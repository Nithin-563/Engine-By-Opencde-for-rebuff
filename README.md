# guffy-engine

Node service that does the actual work: provider routing, the agent tool loop,
workspace files, a shell, signed previews and Netlify deploys.

```bash
cp .env.example .env
node --env-file=.env src/index.js     # http://localhost:8080
```

`GET /health` reports `configured` and the exact missing variables. It will boot
in degraded mode (health + catalog only) rather than crash.

## Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | yes | project URL |
| `SUPABASE_ANON_KEY` | yes | used only to verify bearer tokens |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | **secret** — bypasses RLS |
| `APP_SECRET` | yes | 24+ chars; seals BYOK keys and signs preview URLs |
| `OPENROUTER_API_KEY` | optional | managed models |
| `KILO_API_KEY` | optional | managed models |
| `WEB_ORIGIN` | yes in prod | exact origin(s), comma-separated; `*` allows all |
| `PUBLIC_URL` | yes in prod | used to build preview URLs |
| `DATA_DIR` | no | default `./.data/workspaces` |
| `ALLOW_SHELL` | no | default `true`; `false` disables shell + terminal |
| `SHELL_TIMEOUT_MS` | no | default 45000, max 120000 |
| `MAX_AGENT_STEPS` | no | default 14 |
| `NETLIFY_AUTH_TOKEN` / `NETLIFY_SITE_ID` | no | lets users deploy without pasting a token |

## Routes

```
GET    /health
GET    /api/providers
GET    /api/models?provider=&baseUrl=
GET    /api/me
PUT    /api/keys/:provider          { apiKey, baseUrl? }
DELETE /api/keys/:provider
GET    /api/projects
POST   /api/projects                { name, framework? }
PATCH  /api/projects/:id            { name }
DELETE /api/projects/:id
GET    /api/projects/:id/messages
GET    /api/projects/:id/files?content=1
GET    /api/projects/:id/file?path=
PUT    /api/projects/:id/file       { path, content }
DELETE /api/projects/:id/file?path=
GET    /api/projects/:id/workspace
POST   /api/projects/:id/chat       SSE agent stream
GET    /api/projects/:id/preview-url
GET    /api/projects/:id/deployments
POST   /api/projects/:id/deploy     { token?, siteId? }
WS     /ws/terminal?projectId=&token=
GET    /preview/:projectId/:signature/*
```

All `/api/*` routes require `Authorization: Bearer <supabase access token>`.

## SSE contract

`POST /api/projects/:id/chat` streams `data: {json}` frames:

```
{ type: "ready", runId, provider, model, byok }
{ type: "delta", text }
{ type: "tool_start", id, name, arguments }
{ type: "tool_end", id, name, result, durationMs }
{ type: "done", text, truncated? }
{ type: "saved", messageId }
{ type: "error", message }
```

## Files and state

Supabase is the source of truth. `ensureWorkspace()` materialises a project into
`DATA_DIR/<projectId>/` on first touch and marks it with `.guffy-synced`; every
tool write goes to disk *and* `guffy_project_files`. A Render restart therefore loses
nothing — the next request rebuilds the directory.

## Security notes

- Shell commands run as the service user. Isolate the instance; do not co-tenant it.
- The child environment is a whitelist (`PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ`,
  `NODE_ENV`), so `SUPABASE_SERVICE_ROLE_KEY` and provider keys are never visible
  to a shell command.
- Path resolution rejects traversal and writes into `.git` / `node_modules`.
- Output is capped (reads 200 KB, writes 300 KB, shell 32 KB, 400 files per walk).
- Previews are signed with HMAC-SHA256(APP_SECRET, projectId) and served
  `no-store`. Anyone with the signed URL can read the preview; treat it as
  unlisted, not private.

## Hosting beyond Render

The engine is a plain Node HTTP server with one WebSocket upgrade handler, so
any container or VM works. Free-ish options, in order of least friction:

| Host | Notes |
| --- | --- |
| Render free web service | Sleeps after idle; disk is ephemeral (files re-materialise from Supabase). First request after sleep is slow. |
| Koyeb free instance | Always-on single instance, ephemeral disk. |
| Google Cloud Run free tier | Scales to zero; 60-minute request cap is fine for SSE; always-on CPU costs money. |
| Hugging Face Spaces (Docker) | Free CPU, public by default; add a secret for auth env vars. |
| Oracle Cloud Always Free ARM VM | Truly free and persistent; run under `pm2` behind Caddy for TLS. |
| Fly.io | Small always-on machine, needs a card on file. |
| Home machine + Cloudflare Tunnel | Free and persistent; only as available as your uptime. |

Netlify Functions and Cloudflare Workers are **not** suitable: the engine needs a
persistent process, child processes for the shell and unbounded SSE streams.
