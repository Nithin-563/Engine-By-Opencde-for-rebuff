import http from "node:http";
import { spawn } from "node:child_process";
import express from "express";
import { WebSocketServer } from "ws";

import { cfg, isConfigured, missing, reportConfig } from "./config.js";
import * as store from "./db.js";
import {
  PROVIDERS,
  getProvider,
  publicCatalog,
  resolveBaseUrl,
  isManagedAvailable,
  headerFor,
} from "./providers.js";
import { listModels, UpstreamError } from "./llm.js";
import { runAgent } from "./agent.js";
import { deployToNetlify } from "./deploy.js";
import {
  ensureWorkspace,
  projectDir,
  previewSignature,
  resolvePreviewFile,
  mimeFor,
  listWorkspace,
} from "./workspace.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "6mb" }));

/* ------------------------------------------------------------------- helpers */

const fail = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = cfg.webOrigins.includes("*") || (origin && cfg.webOrigins.includes(origin));
  if (origin && allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "authorization,content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function bearer(req) {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

const auth = wrap(async (req, res, next) => {
  const user = await store.authenticate(bearer(req));
  if (!user) return fail(res, 401, "sign in required");
  req.user = user;
  next();
});

/** Resolve the key + base URL for a provider, preferring the user's own key. */
async function resolveCredentials(userId, provider, bodyBaseUrl) {
  const stored = await store.getKey(userId, provider.id).catch(() => null);
  const apiKey = stored?.apiKey || (provider.managed ? cfg.managedKeys[provider.id] : "") || "";
  const baseUrl = resolveBaseUrl(provider, stored?.baseUrl || bodyBaseUrl);
  const headers = provider.id === "azure_openai" && apiKey.startsWith("sk-") === false
    ? { "api-key": apiKey }
    : headerFor(provider, apiKey).authorization
      ? { authorization: `Bearer ${apiKey}` }
      : {};
  return { apiKey, baseUrl, headers, byok: Boolean(stored?.apiKey) };
}

const buckets = new Map();
function rateLimit(userId, limit, windowMs) {
  const now = Date.now();
  const hits = (buckets.get(userId) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) return false;
  hits.push(now);
  buckets.set(userId, hits);
  return true;
}

/* -------------------------------------------------------------------- health */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    configured: isConfigured(),
    missing,
    providers: PROVIDERS.length,
    managed: Object.entries(cfg.managedKeys).filter(([, v]) => v).map(([k]) => k),
    shell: cfg.allowShell,
    uptimeSec: Math.round(process.uptime()),
  });
});

/* ------------------------------------------------------------------ catalog */

app.get("/api/providers", (req, res) => {
  res.json({
    providers: publicCatalog().map((p) => ({ ...p, managedAvailable: p.managed && isManagedAvailable(getProvider(p.id)) })),
  });
});

app.get(
  "/api/models",
  auth,
  wrap(async (req, res) => {
    const provider = getProvider(String(req.query.provider ?? ""));
    if (!provider) return fail(res, 400, "unknown provider");
    const { apiKey, baseUrl, headers } = await resolveCredentials(req.user.id, provider, String(req.query.baseUrl ?? ""));
    if (!apiKey) return fail(res, 400, "no key configured for this provider", { code: "no_key" });
    const result = await listModels({ baseUrl, apiKey, extraHeaders: headers, provider });
    res.json({ provider: provider.id, ...result });
  }),
);

/* ---------------------------------------------------------------------- me */

app.get(
  "/api/me",
  auth,
  wrap(async (req, res) => {
    const profile = await store.getProfile(req.user.id);
    const keys = await store.listKeyHints(req.user.id);
    res.json({
      user: { id: req.user.id, email: req.user.email },
      profile: {
        displayName: profile.display_name,
        plan: profile.plan,
        messagesToday: profile.messages_today,
        dailyLimit: profile.daily_message_limit,
        quotaDate: profile.quota_date,
      },
      keys,
      managed: Object.fromEntries(PROVIDERS.filter((p) => p.managed).map((p) => [p.id, isManagedAvailable(p)])),
    });
  }),
);

/* -------------------------------------------------------------------- keys */

app.put(
  "/api/keys/:provider",
  auth,
  wrap(async (req, res) => {
    const provider = getProvider(req.params.provider);
    if (!provider) return fail(res, 400, "unknown provider");
    const apiKey = String(req.body?.apiKey ?? "").trim();
    const baseUrl = String(req.body?.baseUrl ?? "").trim();
    if (apiKey.length < 8) return fail(res, 400, "that key looks too short");
    if (provider.needsBaseUrl && !/^https?:\/\//i.test(baseUrl)) {
      return fail(res, 400, "this provider needs a base URL (https://…)");
    }
    await store.setKey(req.user.id, provider.id, { apiKey, baseUrl: baseUrl || null });
    res.json({ ok: true, provider: provider.id });
  }),
);

app.delete(
  "/api/keys/:provider",
  auth,
  wrap(async (req, res) => {
    await store.deleteKey(req.user.id, req.params.provider);
    res.json({ ok: true });
  }),
);

/* ---------------------------------------------------------------- projects */

app.get(
  "/api/projects",
  auth,
  wrap(async (req, res) => {
    res.json({ projects: await store.listProjects(req.user.id) });
  }),
);

app.post(
  "/api/projects",
  auth,
  wrap(async (req, res) => {
    const project = await store.createProject(req.user.id, {
      name: req.body?.name,
      framework: req.body?.framework,
    });
    res.status(201).json({ project });
  }),
);

app.patch(
  "/api/projects/:id",
  auth,
  wrap(async (req, res) => {
    const project = await store.getProject(req.user.id, req.params.id);
    if (!project) return fail(res, 404, "project not found");
    if (typeof req.body?.name === "string" && req.body.name.trim()) {
      await store.renameProject(req.user.id, project.id, req.body.name.trim().slice(0, 120));
    }
    res.json({ ok: true });
  }),
);

app.delete(
  "/api/projects/:id",
  auth,
  wrap(async (req, res) => {
    await store.deleteProject(req.user.id, req.params.id);
    res.json({ ok: true });
  }),
);

app.get(
  "/api/projects/:id/messages",
  auth,
  wrap(async (req, res) => {
    const project = await store.getProject(req.user.id, req.params.id);
    if (!project) return fail(res, 404, "project not found");
    res.json({ messages: await store.listMessages(project.id) });
  }),
);

app.get(
  "/api/projects/:id/deployments",
  auth,
  wrap(async (req, res) => {
    const project = await store.getProject(req.user.id, req.params.id);
    if (!project) return fail(res, 404, "project not found");
    res.json({ deployments: await store.listDeployments(project.id) });
  }),
);

/* ------------------------------------------------------------------- files */

app.get(
  "/api/projects/:id/files",
  auth,
  wrap(async (req, res) => {
    const project = await store.getProject(req.user.id, req.params.id);
    if (!project) return fail(res, 404, "project not found");
    const files = await store.listFiles(project.id);
    const includeContent = req.query.content === "1";
    res.json({
      files: files.map((f) =>
        includeContent ? f : { path: f.path, size: f.size, updated_at: f.updated_at },
      ),
    });
  }),
);

app.get(
  "/api/projects/:id/file",
  auth,
  wrap(async (req, res) => {
    const project = await store.getProject(req.user.id, req.params.id);
    if (!project) return fail(res, 404, "project not found");
    const file = await store.getFile(project.id, String(req.query.path ?? ""));
    if (!file) return fail(res, 404, "file not found");
    res.json({ file });
  }),
);

app.put(
  "/api/projects/:id/file",
  auth,
  wrap(async (req, res) => {
    const project = await store.getProject(req.user.id, req.params.id);
    if (!project) return fail(res, 404, "project not found");
    const filePath = String(req.body?.path ?? "").trim();
    const content = String(req.body?.content ?? "");
    if (!filePath) return fail(res, 400, "path is required");
    const dir = await ensureWorkspace(project);
    const { resolveInRoot } = await import("./tools.js");
    const { abs, rel } = resolveInRoot(dir, filePath);
    const fs = await import("node:fs/promises");
    await fs.mkdir((await import("node:path")).dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    await store.putFile(project.id, rel, content);
    res.json({ ok: true, path: rel });
  }),
);

app.delete(
  "/api/projects/:id/file",
  auth,
  wrap(async (req, res) => {
    const project = await store.getProject(req.user.id, req.params.id);
    if (!project) return fail(res, 404, "project not found");
    const filePath = String(req.query.path ?? "");
    const dir = await ensureWorkspace(project);
    const { resolveInRoot } = await import("./tools.js");
    const { abs, rel } = resolveInRoot(dir, filePath);
    const fs = await import("node:fs/promises");
    await fs.rm(abs, { force: true });
    await store.removeFile(project.id, rel);
    res.json({ ok: true });
  }),
);

app.get(
  "/api/projects/:id/workspace",
  auth,
  wrap(async (req, res) => {
    const project = await store.getProject(req.user.id, req.params.id);
    if (!project) return fail(res, 404, "project not found");
    res.json({ files: await listWorkspace(project) });
  }),
);

/* -------------------------------------------------------------------- chat */

app.post(
  "/api/projects/:id/chat",
  auth,
  wrap(async (req, res) => {
    const project = await store.getProject(req.user.id, req.params.id);
    if (!project) return fail(res, 404, "project not found");
    if (!rateLimit(req.user.id, 40, 5 * 60_000)) return fail(res, 429, "slow down — too many runs at once");

    const message = String(req.body?.message ?? "").trim();
    if (!message) return fail(res, 400, "message is required");
    if (message.length > 24_000) return fail(res, 400, "message is too long");

    const provider = getProvider(String(req.body?.provider ?? ""));
    if (!provider) return fail(res, 400, "choose a provider");

    const creds = await resolveCredentials(req.user.id, provider, String(req.body?.baseUrl ?? ""));
    if (!creds.apiKey) {
      return fail(res, 400, `${provider.label} needs an API key`, { code: "no_key", provider: provider.id });
    }
    const model = String(req.body?.model ?? "").trim() || provider.defaultModel;
    if (!model) return fail(res, 400, "choose a model");

    if (provider.managed && !creds.byok) {
      const quota = await store.consumeQuota(req.user.id);
      if (!quota.allowed) {
        return fail(res, 429, `daily limit reached (${quota.limit}). Resets ${quota.resetsAt}.`, {
          code: "quota",
          resetsAt: quota.resetsAt,
        });
      }
    }

    const history = (await store.listMessages(project.id)).slice(-24);
    await store.addMessage(project.id, req.user.id, "user", message, { provider: provider.id, model });
    const runId = await store.startRun(project.id, req.user.id, provider.id, model);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const controller = new AbortController();
    req.on("close", () => controller.abort());
    const started = Date.now();
    const meta = { promptTokens: 0, completionTokens: 0, trace: [] };

    send({ type: "ready", runId, provider: provider.id, model, byok: creds.byok });

    let text = "";
    try {
      for await (const event of runAgent({
        project,
        userId: req.user.id,
        provider,
        apiKey: creds.apiKey,
        extraHeaders: creds.headers,
        baseUrl: creds.baseUrl,
        model,
        history,
        userMessage: message,
        signal: controller.signal,
        meta,
      })) {
        if (event.type === "delta") text += event.text;
        send(event);
      }

      const saved = await store.addMessage(project.id, req.user.id, "assistant", text || "(no output)", {
        provider: provider.id,
        model,
        runId,
        trace: meta.trace,
      });
      await store.finishRun(runId, {
        status: "succeeded",
        promptTokens: meta.promptTokens,
        completionTokens: meta.completionTokens,
        durationMs: Date.now() - started,
        toolTrace: meta.trace,
        messageId: saved.id,
      });
      send({ type: "saved", messageId: saved.id });
    } catch (err) {
      const aborted = controller.signal.aborted;
      const detail = err instanceof UpstreamError ? err.detail || err.message : err.message;
      if (!aborted) send({ type: "error", message: aborted ? "cancelled" : detail });
      await store.finishRun(runId, {
        status: aborted ? "cancelled" : "failed",
        promptTokens: meta.promptTokens,
        completionTokens: meta.completionTokens,
        durationMs: Date.now() - started,
        toolTrace: meta.trace,
        error: aborted ? "cancelled by client" : String(detail).slice(0, 900),
      });
    } finally {
      res.end();
    }
  }),
);

/* ----------------------------------------------------------------- preview */

app.get(
  "/api/projects/:id/preview-url",
  auth,
  wrap(async (req, res) => {
    const project = await store.getProject(req.user.id, req.params.id);
    if (!project) return fail(res, 404, "project not found");
    await ensureWorkspace(project);
    const base = cfg.publicUrl || `${req.protocol}://${req.get("host")}`;
    res.json({
      url: `${base}/preview/${project.id}/${previewSignature(project.id)}/`,
      entry: project.entry_file,
    });
  }),
);

async function servePreview(req, res) {
  const projectId = req.params.projectId;
  const sig = req.params.sig;
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(sig) || sig !== previewSignature(projectId)) {
    return res.status(403).send("invalid preview signature");
  }
  const { data: project } = await store
    .db()
    .from("guffy_projects")
    .select("id,name,entry_file,framework")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) return res.status(404).send("project not found");

  const dir = await ensureWorkspace(project);
  const rest = req.params[0] ?? "";
  const file = await resolvePreviewFile(dir, rest);
  if (!file) return res.status(404).type("text/plain").send(`not found: ${rest}`);

  res.setHeader("Content-Type", mimeFor(file.abs));
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.send(file.body);
}

app.get("/preview/:projectId/:sig", (req, res) => {
  req.params[0] = "";
  servePreview(req, res).catch(() => res.status(500).send("preview error"));
});
app.get("/preview/:projectId/:sig/*", (req, res) => {
  servePreview(req, res).catch(() => res.status(500).send("preview error"));
});

/* ------------------------------------------------------------------ deploy */

app.post(
  "/api/projects/:id/deploy",
  auth,
  wrap(async (req, res) => {
    const project = await store.getProject(req.user.id, req.params.id);
    if (!project) return fail(res, 404, "project not found");
    const token = String(req.body?.token ?? "").trim() || cfg.netlifyToken;
    if (!token) return fail(res, 400, "a Netlify access token is required", { code: "no_token" });
    const dir = await ensureWorkspace(project);
    const deploymentId = await store.recordDeployment({
      project_id: project.id,
      user_id: req.user.id,
      target: "netlify",
      site_id: String(req.body?.siteId ?? "").trim() || cfg.netlifySiteId || null,
      status: "uploading",
    });
    try {
      const result = await deployToNetlify({
        project,
        dir,
        token,
        siteId: String(req.body?.siteId ?? "").trim() || cfg.netlifySiteId || undefined,
        siteName: `guffy-${project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}-${project.id.slice(0, 6)}`,
      });
      await store.updateDeployment(deploymentId, {
        status: "ready",
        url: result.url,
        site_id: result.siteId,
      });
      res.json({ ok: true, url: result.url, siteId: result.siteId });
    } catch (err) {
      await store.updateDeployment(deploymentId, { status: "failed", error: String(err.message).slice(0, 500) });
      return fail(res, 502, err.message);
    }
  }),
);

/* ------------------------------------------------------------------ errors */

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error("[guffy] unhandled", err);
  fail(res, 500, "internal engine error");
});

/* ------------------------------------------------------- terminal over WS */

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", async (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, "http://engine.local");
  } catch {
    return socket.destroy();
  }
  if (url.pathname !== "/ws/terminal") return socket.destroy();

  try {
    const user = await store.authenticate(url.searchParams.get("token") ?? "");
    if (!user) return socket.destroy();
    const project = await store.getProject(user.id, url.searchParams.get("projectId") ?? "");
    if (!project) return socket.destroy();
    const root = await ensureWorkspace(project);
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachTerminal(ws, root);
    });
  } catch {
    socket.destroy();
  }
});

function attachTerminal(ws, cwd) {
  if (!cfg.allowShell) {
    ws.send(JSON.stringify({ type: "data", data: "shell execution is disabled on this engine\r\n" }));
    ws.close();
    return;
  }
  const shell = spawn("/bin/bash", ["-s"], {
    cwd,
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", TERM: "dumb", LANG: "C.UTF-8" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const send = (data) => ws.readyState === 1 && ws.send(JSON.stringify({ type: "data", data }));
  shell.stdout.on("data", (b) => send(b.toString("utf8")));
  shell.stderr.on("data", (b) => send(b.toString("utf8")));
  shell.on("close", () => {
    send("\r\n[shell exited]\r\n");
    ws.close();
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "input" && typeof msg.data === "string") {
      shell.stdin.write(`${msg.data}\nprintf '\\n__GUFFY_DONE__%s\\n' "$?"\n`);
    } else if (msg.type === "interrupt") {
      shell.kill("SIGINT");
    }
  });

  ws.on("close", () => shell.kill("SIGKILL"));
}

reportConfig();
server.listen(cfg.port, "0.0.0.0", () => {
  console.log(`[guffy] engine listening on 0.0.0.0:${cfg.port}`);
});
