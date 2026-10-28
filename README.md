# Deoid engine

The compute half of Deoid. This is a small container that gives the agent what
Netlify cannot: a persistent workspace, a shell, file tools and a streaming
tool-loop. Deploy it once to Railway (or Fly/VPS), then paste its URL into
**Deoid → Settings → Agent engine**.

```
Deoid web app (Netlify)  ──HTTPS/SSE──▶  deoid-engine (Railway)
        │                                     │
   Supabase (auth, threads)              workspace + shell + tools
        │                                     │
        └────────── model API (BYOK) ◀────────┘
```

## Deploy to Railway (5 minutes)

1. Unzip `deoid-engine.zip`.
2. Push it to a GitHub repo (private is fine):
   ```bash
   cd deoid-engine
   git init && git add . && git commit -m "Deoid engine"
   gh repo create deoid-engine --private --source=. --push
   ```
3. Railway → **New Project → Deploy from GitHub repo** → pick the repo.
   Railway detects the `Dockerfile` automatically.
4. Add variables:
   - `ENGINE_TOKEN` — `openssl rand -hex 32` (required)
   - `CORS_ORIGIN` — your site origin, e.g. `https://deoid.netlify.app`
   - optional: `MODEL_API_KEY` (house key), `MAX_STEPS`, `RUN_TIMEOUT_MS`
5. **Settings → Networking → Generate Domain.** Copy it, e.g.
   `https://deoid-engine-production.up.railway.app`.
6. (Recommended) **Add a volume** mounted at `/data`. Without it, workspaces
   disappear on every deploy. With it, threads keep their files.
7. Open Deoid → Settings → Agent engine, paste the URL and `ENGINE_TOKEN`.
   Deoid calls `GET /health` before saving, so a typo is rejected immediately.

Builder and Cowork then run on the engine. Chat stays on the direct model path.
If the engine is unreachable, Deoid falls back to the direct model and tells you
in the thread.

## API

All `/v1/*` routes require `Authorization: Bearer $ENGINE_TOKEN`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | version, tools, uptime |
| POST | `/v1/run` | run the agent, returns SSE |
| GET | `/v1/files?sessionId=` | list a workspace |
| POST | `/v1/reset` | delete a workspace (`{ sessionId }`) |

`POST /v1/run` body:

```json
{
  "threadId": "uuid",
  "surface": "builder",
  "provider": "openai",
  "model": "gpt-4.1-mini",
  "apiKey": "sk-...",
  "baseUrl": null,
  "messages": [{ "role": "user", "content": "build a habit tracker" }]
}
```

Stream events: `meta`, `status`, `tool`, `delta`, `done`, `error`.

## Tools

`write_file`, `read_file`, `list_files`, `delete_file`, `run_command`,
`fetch_url`.

Safety boundaries:

- Every session is a directory under `WORKSPACE_ROOT`; path traversal is rejected.
- `run_command` uses a sanitised environment — model keys and tokens are never
  passed to the shell — with a 60s hard timeout and output cap.
- Obvious destructive patterns (`rm -rf /`, `mkfs`, `shutdown`, fork bombs) are
  blocked.
- `fetch_url` refuses localhost, private ranges and cloud metadata addresses.
- Tool output is capped so a chatty command cannot blow up the context.

This is a single-tenant-per-user runner: every request carries the user's own
model key, and nothing is stored on the engine except workspace files. If you
run one engine for many users, set `CORS_ORIGIN` and give each Deoid deployment
its own token.

## Local test

```bash
cd deoid-engine
ENGINE_TOKEN=dev-token PORT=8787 WORKSPACE_ROOT=/tmp/deoid-ws node src/server.js
curl -s http://localhost:8787/health
curl -s -H "authorization: Bearer dev-token" http://localhost:8787/health
```

No dependencies, no build step. Node 20+ only.

## Why not run opencode here?

You can. `opencode` is a process, and this container is exactly the kind of host
it needs. If you would rather proxy opencode's own server, add
`OPENCODE_BIN`/`opencode serve` to the image and replace `/v1/run` with a proxy.
The Deoid web app only depends on this HTTP contract, so either implementation
works. The bundled agent exists so the ZIP works with zero extra setup.
