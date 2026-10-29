-- Guffy — schema, row-level security, quota accounting, and realtime.
--
-- Every object is namespaced with a `guffy_` prefix. That matters: this Supabase
-- project may also host another app, and generic names like `public.projects`
-- or `public.messages` collide with it. Nothing here drops, alters or reads a
-- table it did not create.
--
-- Paste this whole file into the Supabase SQL editor and press Run.
-- Safe to re-run: every statement is idempotent.

create extension if not exists pgcrypto;

-- ------------------------------------------------------------------ profiles
create table if not exists public.guffy_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  plan text not null default 'free',
  daily_message_limit integer not null default 75,
  messages_today integer not null default 0,
  quota_date date not null default current_date,
  created_at timestamptz not null default now()
);

alter table public.guffy_profiles enable row level security;

drop policy if exists guffy_profiles_select_self on public.guffy_profiles;
create policy guffy_profiles_select_self on public.guffy_profiles
  for select to authenticated using (auth.uid() = id);

drop policy if exists guffy_profiles_update_self on public.guffy_profiles;
create policy guffy_profiles_update_self on public.guffy_profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

create or replace function public.guffy_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.guffy_profiles (id, email, display_name)
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

-- A trigger name on auth.users is global to the project, and another app may
-- already own `on_auth_user_created`. This one is distinct, so both can run.
drop trigger if exists on_auth_user_created_guffy on auth.users;
create trigger on_auth_user_created_guffy
  after insert on auth.users
  for each row execute function public.guffy_handle_new_user();

insert into public.guffy_profiles (id, email, display_name)
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
declare prof public.guffy_profiles;
begin
  select * into prof from public.guffy_profiles where id = p_user for update;
  if not found then
    return query select false, 0, current_date + 1, 0;
    return;
  end if;

  if prof.quota_date <> current_date then
    update public.guffy_profiles
      set messages_today = 0, quota_date = current_date
      where id = p_user
      returning * into prof;
  end if;

  if prof.messages_today >= prof.daily_message_limit then
    return query select false, 0, prof.quota_date + 1, prof.daily_message_limit;
    return;
  end if;

  update public.guffy_profiles set messages_today = prof.messages_today + 1 where id = p_user;

  return query select true, prof.daily_message_limit - prof.messages_today - 1, prof.quota_date + 1, prof.daily_message_limit;
end;
$$;

revoke all on function public.guffy_consume_quota(uuid) from anon, authenticated;

-- ------------------------------------------------------------------ projects
create table if not exists public.guffy_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null default 'Untitled project',
  framework text not null default 'static',
  entry_file text not null default 'index.html',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Index names are schema-wide in Postgres, so these are prefixed too.
create index if not exists guffy_projects_user_idx on public.guffy_projects (user_id, updated_at desc);
alter table public.guffy_projects enable row level security;

drop policy if exists guffy_projects_owner_all on public.guffy_projects;
create policy guffy_projects_owner_all on public.guffy_projects
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ------------------------------------------------------------------ messages
create table if not exists public.guffy_messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.guffy_projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists guffy_messages_project_idx on public.guffy_messages (project_id, created_at);
alter table public.guffy_messages enable row level security;

drop policy if exists guffy_messages_owner_all on public.guffy_messages;
create policy guffy_messages_owner_all on public.guffy_messages
  for all to authenticated
  using (exists (select 1 from public.guffy_projects p where p.id = project_id and p.user_id = auth.uid()))
  with check (exists (select 1 from public.guffy_projects p where p.id = project_id and p.user_id = auth.uid()));

-- ---------------------------------------------------------------------- runs
create table if not exists public.guffy_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.guffy_projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  message_id uuid references public.guffy_messages (id) on delete set null,
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

create index if not exists guffy_runs_project_idx on public.guffy_runs (project_id, created_at desc);
alter table public.guffy_runs enable row level security;

drop policy if exists guffy_runs_owner_select on public.guffy_runs;
create policy guffy_runs_owner_select on public.guffy_runs
  for select to authenticated using (auth.uid() = user_id);

-- ------------------------------------------------------------- project files
create table if not exists public.guffy_project_files (
  project_id uuid not null references public.guffy_projects (id) on delete cascade,
  path text not null,
  content text not null default '',
  size integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (project_id, path)
);

alter table public.guffy_project_files enable row level security;

drop policy if exists guffy_project_files_owner_all on public.guffy_project_files;
create policy guffy_project_files_owner_all on public.guffy_project_files
  for all to authenticated
  using (exists (select 1 from public.guffy_projects p where p.id = project_id and p.user_id = auth.uid()))
  with check (exists (select 1 from public.guffy_projects p where p.id = project_id and p.user_id = auth.uid()));

-- -------------------------------------------------------------- provider keys
-- Ciphertext only. The browser can never read this table: no anon/authenticated
-- policy exists, and the engine uses the service role. Keys are sealed with
-- AES-256-GCM using APP_SECRET before they touch the database.
create table if not exists public.guffy_provider_keys (
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null,
  ciphertext text not null,
  hint text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

alter table public.guffy_provider_keys enable row level security;

-- -------------------------------------------------------------- deployments
create table if not exists public.guffy_deployments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.guffy_projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  target text not null default 'netlify',
  site_id text,
  url text,
  status text not null default 'queued',
  error text,
  created_at timestamptz not null default now()
);

create index if not exists guffy_deployments_project_idx on public.guffy_deployments (project_id, created_at desc);
alter table public.guffy_deployments enable row level security;

drop policy if exists guffy_deployments_owner_select on public.guffy_deployments;
create policy guffy_deployments_owner_select on public.guffy_deployments
  for select to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------------------------- realtime
do $realtime$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.guffy_messages;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.guffy_project_files;
    exception when duplicate_object then null;
    end;
  end if;
end;
$realtime$;

-- ------------------------------------------------------------------- checks
-- After running, confirm every Guffy table has RLS enabled:
--
--   select tablename, rowsecurity
--   from pg_tables
--   where schemaname = 'public' and tablename like 'guffy\_%'
--   order by 1;
--
-- Expect 7 rows, all rowsecurity = true.
