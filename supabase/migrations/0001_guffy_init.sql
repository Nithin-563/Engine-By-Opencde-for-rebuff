-- Guffy — schema, row-level security, quota accounting, and realtime.
-- Paste this whole file into the Supabase SQL editor and press Run.
-- Safe to re-run: every statement is idempotent.

create extension if not exists pgcrypto;

-- ------------------------------------------------------------------ profiles
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  plan text not null default 'free',
  daily_message_limit integer not null default 75,
  messages_today integer not null default 0,
  quota_date date not null default current_date,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles
  for select to authenticated using (auth.uid() = id);

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

create or replace function public.guffy_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'display_name', ''),
      split_part(coalesce(new.email, 'builder'), '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.guffy_handle_new_user();

insert into public.profiles (id, email, display_name)
select u.id, u.email, split_part(coalesce(u.email, 'builder'), '@', 1)
from auth.users u
on conflict (id) do nothing;

-- Atomic quota consumption. Only the engine (service role) may call this, so a
-- browser can never grant itself extra messages.
create or replace function public.guffy_consume_quota(p_user uuid)
returns table (allowed boolean, remaining integer, resets_at date, limit_value integer)
language plpgsql
security definer
set search_path = public
as $$
declare prof public.profiles;
begin
  select * into prof from public.profiles where id = p_user for update;
  if not found then
    return query select false, 0, current_date + 1, 0;
    return;
  end if;

  if prof.quota_date <> current_date then
    update public.profiles
      set messages_today = 0, quota_date = current_date
      where id = p_user
      returning * into prof;
  end if;

  if prof.messages_today >= prof.daily_message_limit then
    return query select false, 0, prof.quota_date + 1, prof.daily_message_limit;
    return;
  end if;

  update public.profiles set messages_today = prof.messages_today + 1 where id = p_user;

  return query select true, prof.daily_message_limit - prof.messages_today - 1, prof.quota_date + 1, prof.daily_message_limit;
end;
$$;

revoke all on function public.guffy_consume_quota(uuid) from anon, authenticated;

-- ------------------------------------------------------------------ projects
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null default 'Untitled project',
  framework text not null default 'static',
  entry_file text not null default 'index.html',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists projects_user_idx on public.projects (user_id, updated_at desc);
alter table public.projects enable row level security;

drop policy if exists projects_owner_all on public.projects;
create policy projects_owner_all on public.projects
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ------------------------------------------------------------------ messages
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists messages_project_idx on public.messages (project_id, created_at);
alter table public.messages enable row level security;

drop policy if exists messages_owner_all on public.messages;
create policy messages_owner_all on public.messages
  for all to authenticated
  using (exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()))
  with check (exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()));

-- ---------------------------------------------------------------------- runs
create table if not exists public.runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  message_id uuid references public.messages (id) on delete set null,
  provider text not null,
  model text not null,
  status text not null default 'running',
  prompt_tokens integer,
  completion_tokens integer,
  duration_ms integer,
  tool_trace jsonb not null default '[]'::jsonb,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists runs_project_idx on public.runs (project_id, created_at desc);
alter table public.runs enable row level security;

drop policy if exists runs_owner_select on public.runs;
create policy runs_owner_select on public.runs
  for select to authenticated using (auth.uid() = user_id);

-- ------------------------------------------------------------- project files
create table if not exists public.project_files (
  project_id uuid not null references public.projects (id) on delete cascade,
  path text not null,
  content text not null default '',
  size integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (project_id, path)
);

alter table public.project_files enable row level security;

drop policy if exists project_files_owner_all on public.project_files;
create policy project_files_owner_all on public.project_files
  for all to authenticated
  using (exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()))
  with check (exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()));

-- -------------------------------------------------------------- provider keys
-- Ciphertext only. The browser can never read this table: no anon/authenticated
-- policy exists, and the engine uses the service role. Keys are sealed with
-- AES-256-GCM using APP_SECRET before they touch the database.
create table if not exists public.provider_keys (
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null,
  ciphertext text not null,
  hint text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

alter table public.provider_keys enable row level security;

-- -------------------------------------------------------------- deployments
create table if not exists public.deployments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  target text not null default 'netlify',
  site_id text,
  url text,
  status text not null default 'queued',
  error text,
  created_at timestamptz not null default now()
);

create index if not exists deployments_project_idx on public.deployments (project_id, created_at desc);
alter table public.deployments enable row level security;

drop policy if exists deployments_owner_select on public.deployments;
create policy deployments_owner_select on public.deployments
  for select to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------------------------- realtime
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.messages;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.project_files;
    exception when duplicate_object then null;
    end;
  end if;
end;
$$;

-- ------------------------------------------------------------------ seed demo
-- Nothing is seeded. Creating a project in the UI inserts a starter page.
