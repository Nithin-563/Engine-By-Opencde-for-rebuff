import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { runAgent } from "./agent.js";
import { normalizeKey } from "./providers.js";
import { TOOL_NAMES } from "./tools.js";
import { fileTree, resetSession, sessionId } from "./sandbox.js";

const PORT = Number(process.env.PORT) || 8080;
const TOKEN = (process.env.ENGINE_TOKEN || "").trim();
const VERSION = "deoid-engine/1.0.0";
const MAX_BODY = 4 * 1024 * 1024;
const MAX_MESSAGE = 24_000;

if (!TOKEN) {
  console.error("ENGINE_TOKEN is required. Set it in Render (Environment → Add Environment Variable) or Railway. Use any long random string.");
  process.exit(1);
}

const CORS = process.env.CORS_ORIGIN || "*";

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": CORS,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function authorized(req) {
  const header = req.headers.authorization || "";
  const provided = header.replace(/^Bearer\s+/i, "").trim();
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sseHead(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "access-control-allow-origin": CORS,
  });
}

function event(res, name, data) {
  res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

/* Rate limit: 30 runs per minute per IP. */
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowStart = now - 60_000;
  const list = (hits.get(ip) || []).filter((time) => time > windowStart);
  if (list.length >= 30) {
    hits.set(ip, list);
    return true;
  }
  list.push(now);
  hits.set(ip, list);
  return false;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": CORS,
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-max-age": "86400",
    });
    res.end();
    return;
  }

  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>Deoid engine</title>
<body style="font:14px/1.6 ui-monospace,monospace;background:#0a0a0b;color:#eee;padding:40px">
<h1 style="font-size:18px">Deoid engine</h1>
<p>${VERSION} is running.</p>
<p>POST <code>/v1/run</code> with <code>Authorization: Bearer $ENGINE_TOKEN</code>.</p>
<p>Health: <a style="color:#9ae6b4" href="/health">/health</a></p>
</body>`);
    return;
  }

  if (url.pathname === "/health") {
    const health = {
      ok: true,
      version: VERSION,
      tools: TOOL_NAMES,
      uptime: Math.round(process.uptime()),
      node: process.version,
    };
    if (!authorized(req)) {
      // A bare health check is useful for Railway, but do not leak config.
      send(res, 200, { ok: true, version: VERSION });
      return;
    }
    send(res, 200, health);
    return;
  }

  if (url.pathname.startsWith("/v1/") && !authorized(req)) {
    send(res, 401, { error: "Missing or invalid engine token." });
    return;
  }

  if (url.pathname === "/v1/run" && req.method === "POST") {
    const ip = req.socket.remoteAddress || "unknown";
    if (rateLimited(ip)) {
      send(res, 429, { error: "Too many runs. Wait a minute and try again." });
      return;
    }

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error) {
      send(res, 400, { error: error instanceof Error ? error.message : "Invalid JSON." });
      return;
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const last = messages[messages.length - 1];
    if (!last || typeof last.content !== "string" || !last.content.trim()) {
      send(res, 400, { error: "A user message is required." });
      return;
    }
    if (last.content.length > MAX_MESSAGE) {
      send(res, 413, { error: `Message is too long (max ${MAX_MESSAGE} characters).` });
      return;
    }
    if (!body.model) {
      send(res, 400, { error: "model is required." });
      return;
    }

    // Reject an unusable key before opening the stream, so the app can display a
    // real 400 instead of a mid-stream error it has to recover from.
    const apiKey = normalizeKey(body.apiKey || process.env.MODEL_API_KEY || "");
    if (!apiKey) {
      send(res, 400, {
        error:
          "No usable model API key reached the engine. Re-add it in Deoid → Settings → Model keys (paste only the key, not the word Bearer), then retry.",
      });
      return;
    }

    const session = sessionId(body.threadId || body.sessionId || `${ip}:${Date.now()}`);
    const surface = ["chat", "builder", "cowork"].includes(body.surface) ? body.surface : "chat";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.RUN_TIMEOUT_MS) || 540_000);

    // `req` closes as soon as its body is consumed, which is immediately here.
    // Only a client that walks away from the response should cancel the run.
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    sseHead(res);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);

    event(res, "meta", { engine: VERSION, sessionId: session, model: body.model, surface });

    try {
      const result = await runAgent({
        session,
        surface,
        provider: body.provider || "openai",
        model: body.model,
        apiKey,
        baseUrl: body.baseUrl || null,
        messages,
        signal: controller.signal,
        emit: (name, data) => event(res, name, data),
      });

      // Emit the answer in small chunks so the client renders progressively.
      const text = String(result.text || "");
      for (let index = 0; index < text.length; index += 180) {
        event(res, "delta", { text: text.slice(index, index + 180) });
      }
      event(res, "done", {
        text,
        steps: result.steps,
        sessionId: session,
        files: result.files?.slice(0, 200) ?? [],
      });
    } catch (error) {
      const message =
        error?.name === "AbortError"
          ? "The run was cancelled or hit the time limit."
          : error instanceof Error
            ? error.message
            : "The engine failed.";
      event(res, "error", { message });
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      res.end();
    }
    return;
  }

  if (url.pathname === "/v1/files" && req.method === "GET") {
    const id = sessionId(url.searchParams.get("sessionId") || "");
    send(res, 200, { sessionId: id, files: await fileTree(id) });
    return;
  }

  if (url.pathname === "/v1/reset" && req.method === "POST") {
    let body = {};
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      body = {};
    }
    const id = sessionId(body.sessionId || body.threadId || "");
    send(res, 200, await resetSession(id));
    return;
  }

  send(res, 404, { error: "Not found." });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`${VERSION} listening on :${PORT}`);
});
