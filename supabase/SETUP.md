# Supabase setup — click by click

You need one Supabase project. It takes about six minutes.

## 1. Create the project

1. Go to <https://supabase.com/dashboard> and sign in.
2. **New project** → pick your organisation.
3. Name: `guffy`. Region: closest to you (or to your Render region).
4. Generate a database password and **save it somewhere** (you will not need it
   for this app, but you will want it for `psql`).
5. **Create new project** and wait for provisioning to finish.

## 2. Run the schema

1. In the left sidebar open **SQL Editor** → **New query**.
2. Open [`migrations/0001_guffy_init.sql`](migrations/0001_guffy_init.sql) from
   this folder, copy the whole file, paste it in, press **Run** (⌘/Ctrl + Enter).
3. You should see `Success. No rows returned`.
4. Open **Table Editor**. You should now see `profiles`, `projects`,
   `messages`, `runs`, `project_files`, `provider_keys`, `deployments`.

The migration is idempotent — running it twice is harmless.

## 3. Copy the three values the app needs

Open **Project Settings** → **API**.

| Value | Where it goes | Secret? |
| --- | --- | --- |
| Project URL (`https://xxxx.supabase.co`) | `VITE_SUPABASE_URL` on Netlify **and** `SUPABASE_URL` on Render | no |
| `anon` / publishable key | `VITE_SUPABASE_ANON_KEY` on Netlify **and** `SUPABASE_ANON_KEY` on Render | no |
| `service_role` key (reveal it) | `SUPABASE_SERVICE_ROLE_KEY` on Render **only** | **yes** |

Never put `service_role` in Netlify, in `VITE_*` variables, or in this repo. It
bypasses row-level security.

## 4. Turn on the sign-in methods

Open **Authentication** → **Sign In / Providers**.

- **Email** — already enabled. Leave it on.
- Scroll to **Email** settings and turn **Confirm email** *off* if you want
  instant sign-in while building (Supabase's built-in SMTP is rate limited to a
  handful of mails per hour). If you leave it on, users must click the link
  before they can sign in — that is the production-correct setting.
- **Magic link** uses the same Email provider; nothing else to enable.

### Redirect URLs (needed for magic links and email confirmation)

Open **Authentication** → **URL Configuration**.

- **Site URL**: your Netlify URL, e.g. `https://guffy.netlify.app`.
- **Redirect URLs**: add both
  - `https://guffy.netlify.app/**`
  - `http://localhost:5173/**`

If you test on a Netlify deploy preview URL, add that origin too.

## 5. Row-level security: what is protected

- Every table is owner-scoped. A signed-in user can only read and write rows
  whose `user_id` (or parent project's `user_id`) is their own.
- `provider_keys` has **no** policy for `anon` or `authenticated`, so it is
  unreadable from a browser even with a valid session. Only the engine's
  service-role client touches it, and values are AES-256-GCM encrypted with
  `APP_SECRET` before insert.
- `guffy_consume_quota` is revoked from `anon`/`authenticated`; only the engine
  can spend quota, so the daily limit cannot be bypassed client-side.

## 6. Verify

Run this in the SQL editor:

```sql
select tablename, rowsecurity from pg_tables where schemaname = 'public' order by 1;
```

Every row should show `rowsecurity = true`.
