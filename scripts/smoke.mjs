/**
 * End-to-end smoke test for the engine: boots a fake provider, boots the engine,
 * and checks auth, key hygiene, OpenRouter attribution and the SSE contract.
 *
 *   node scripts/smoke.mjs
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const PROVIDER_PORT = 4601;
const ENGINE_PORT = 4602;
const TOKEN = "smoke-token";

const seen = [];

const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    seen.push({ url: req.url, headers: req.headers, body });

    if (req.url.includes("/strict") && body.includes("max_tokens")) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message:
              "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
          },
        }),
      );
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "engine says hi" } }],
      }),
    );
  });
});

await new Promise((resolve) => provider.listen(PROVIDER_PORT, resolve));

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "deoid-smoke-"));

const engine = spawn(process.execPath, ["src/server.js"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(ENGINE_PORT),
    ENGINE_TOKEN: TOKEN,
    WORKSPACE_ROOT: workspace,
    SITE_URL: "https://deoid.netlify.app",
    SITE_NAME: "Deoid",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let engineLog = "";
engine.stdout.on("data", (d) => (engineLog += d));
engine.stderr.on("data", (d) => (engineLog += d));

const results = [];
const check = (name, ok, detail = "") => results.push([name, ok, detail]);

const deadline = Date.now() + 8000;
let healthy = false;
while (Date.now() < deadline) {
  try {
    const res = await fetch(`http://127.0.0.1:${ENGINE_PORT}/health`);
    if (res.ok) {
      healthy = true;
      break;
    }
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 150));
}
check("engine health", healthy, engineLog.slice(-400));

async function run(payload) {
  const res = await fetch(`http://127.0.0.1:${ENGINE_PORT}/v1/run`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, text };
}

const base = {
  threadId: "smoke",
  surface: "chat",
  provider: "openrouter",
  baseUrl: `http://127.0.0.1:${PROVIDER_PORT}/v1`,
  model: "mock-model",
  messages: [{ role: "user", content: "hello" }],
};

// 1. A pasted "Bearer " prefix must be normalized, not doubled.
const ok = await run({ ...base, apiKey: "  Bearer test-key\n" });
check("run returns 200", ok.status === 200, ok.text.slice(0, 300));
check(
  "run streams a done event with text",
  ok.text.includes("event: done") && ok.text.includes("engine says hi"),
  ok.text.slice(0, 400),
);

const call = seen[seen.length - 1];
check("provider saw a single Bearer", call?.headers?.authorization === "Bearer test-key", call?.headers?.authorization);
check("openrouter attribution sent", call?.headers?.["http-referer"] === "https://deoid.netlify.app", call?.headers?.["http-referer"]);
check("openrouter title sent", call?.headers?.["x-title"] === "Deoid", call?.headers?.["x-title"]);

// 2. A key that is only the word Bearer is a caller error, not a provider call.
const before = seen.length;
const empty = await run({ ...base, apiKey: "Bearer " });
check("empty Bearer rejected with 400", empty.status === 400, `${empty.status} ${empty.text.slice(0, 200)}`);
check("empty Bearer never reached the provider", seen.length === before, `${seen.length - before} calls`);

// 3. A reasoning-style provider that rejects max_tokens still succeeds.
const beforeStrict = seen.filter((entry) => entry.url.includes("/strict")).length;
const strict = await run({ ...base, baseUrl: `http://127.0.0.1:${PROVIDER_PORT}/strict/v1`, apiKey: "test-key" });
check("retries without max_tokens", strict.status === 200 && strict.text.includes("engine says hi"), strict.text.slice(0, 300));
check(
  "retry used max_completion_tokens",
  seen.filter((entry) => entry.url.includes("/strict")).length - beforeStrict === 2,
  `${seen.filter((entry) => entry.url.includes("/strict")).length - beforeStrict} calls`,
);

// 4. Unauthenticated requests are refused.
const unauth = await fetch(`http://127.0.0.1:${ENGINE_PORT}/v1/run`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(base),
});
check("missing engine token is 401", unauth.status === 401, String(unauth.status));

provider.close();
engine.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 300));
fs.rmSync(workspace, { recursive: true, force: true });

let failed = 0;
for (const [name, passed, detail] of results) {
  if (!passed) failed++;
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${passed ? "" : `  → ${detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
