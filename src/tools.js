import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { cfg } from "./config.js";
import * as store from "./db.js";

const MAX_READ = 200_000;
const MAX_WRITE = 300_000;
const MAX_OUTPUT = 32_000;
const MAX_FILES = 400;

export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List every file in the project workspace with its byte size.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file from the project workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Workspace-relative path, e.g. src/App.tsx" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a text file. Always supply the complete file contents.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path" },
          content: { type: "string", description: "Full file contents" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file from the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Case-insensitive text search across project files. Returns path:line matches.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, max_results: { type: "integer", minimum: 1, maximum: 100 } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description:
        "Run a shell command in the project workspace (Linux, bash). Use it to install packages, build, test, or inspect files. Output is truncated.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_ms: { type: "integer", minimum: 1000, maximum: 120000 },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "Fetch a public URL and return its text (documentation, API references).",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
];

const SAFE_ENV = () => {
  const allow = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "NODE_ENV"];
  const out = {};
  for (const k of allow) if (process.env[k]) out[k] = process.env[k];
  out.TERM = "dumb";
  out.CI = "1";
  out.npm_config_fund = "false";
  out.npm_config_audit = "false";
  return out;
};

export function resolveInRoot(root, filePath) {
  const cleaned = String(filePath ?? "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!cleaned) throw new Error("path is required");
  const abs = path.resolve(root, cleaned);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`path escapes the workspace: ${filePath}`);
  if (rel.split("/").some((seg) => seg === ".git" || seg === "node_modules")) {
    throw new Error(`path is inside a protected directory: ${filePath}`);
  }
  return { abs, rel: rel.split(path.sep).join("/") };
}

export async function walk(root, dir = root, acc = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (acc.length >= MAX_FILES) break;
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".data") continue;
    if (entry.name === ".guffy-synced") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(root, abs, acc);
    else if (entry.isFile()) acc.push(path.relative(root, abs).split(path.sep).join("/"));
  }
  return acc;
}

async function runShell(root, command, timeoutMs) {
  if (!cfg.allowShell) return "error: shell execution is disabled on this engine (ALLOW_SHELL=false)";
  const limit = Math.min(Math.max(Number(timeoutMs) || cfg.shellTimeoutMs, 1000), 120_000);
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd: root,
      env: SAFE_ENV(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let killed = false;
    const push = (buf) => {
      if (out.length < MAX_OUTPUT) out += buf.toString("utf8");
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, limit);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(`error: ${err.message}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const clipped = out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n… truncated (${out.length} bytes)` : out;
      resolve(`${killed ? `timed out after ${limit}ms\n` : ""}exit ${code}\n${clipped || "(no output)"}`);
    });
  });
}

async function fetchUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "error: invalid URL";
  }
  if (!/^https?:$/.test(parsed.protocol)) return "error: only http(s) URLs are supported";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(parsed, { signal: controller.signal, redirect: "follow" });
    const text = await res.text();
    const trimmed = text.length > 24_000 ? `${text.slice(0, 24_000)}\n… truncated` : text;
    return `status ${res.status}\n${trimmed}`;
  } catch (err) {
    return `error: ${err.message}`;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Execute one tool call. Mutating tools write through to Supabase so the file
 * tree survives a Render restart.
 */
export async function executeTool(ctx, name, rawArgs) {
  let args = {};
  if (rawArgs && rawArgs.trim()) {
    try {
      args = JSON.parse(rawArgs);
    } catch {
      return `error: arguments were not valid JSON (${rawArgs.slice(0, 200)})`;
    }
  }
  const { root, projectId } = ctx;

  try {
    switch (name) {
      case "list_files": {
        const files = await walk(root);
        if (!files.length) return "(workspace is empty)";
        const rows = await Promise.all(
          files.map(async (rel) => {
            const stat = await fs.stat(path.join(root, rel)).catch(() => null);
            return `${rel} (${stat?.size ?? 0} bytes)`;
          }),
        );
        return rows.join("\n");
      }
      case "read_file": {
        const { abs, rel } = resolveInRoot(root, args.path);
        const content = await fs.readFile(abs, "utf8");
        const clipped = content.length > MAX_READ ? `${content.slice(0, MAX_READ)}\n… truncated` : content;
        await store.getFile(projectId, rel).catch(() => null);
        return clipped;
      }
      case "write_file": {
        const { abs, rel } = resolveInRoot(root, args.path);
        const content = String(args.content ?? "");
        if (content.length > MAX_WRITE) return `error: file exceeds ${MAX_WRITE} characters`;
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, "utf8");
        await store.putFile(projectId, rel, content);
        return `wrote ${rel} (${Buffer.byteLength(content, "utf8")} bytes)`;
      }
      case "delete_file": {
        const { abs, rel } = resolveInRoot(root, args.path);
        await fs.rm(abs, { force: true });
        await store.removeFile(projectId, rel);
        return `deleted ${rel}`;
      }
      case "search_files": {
        const query = String(args.query ?? "");
        if (!query) return "error: query is required";
        const limit = Math.min(Number(args.max_results) || 40, 100);
        const files = await walk(root);
        const hits = [];
        for (const rel of files) {
          if (hits.length >= limit) break;
          let content;
          try {
            content = await fs.readFile(path.join(root, rel), "utf8");
          } catch {
            continue;
          }
          const lines = content.split("\n");
          for (let i = 0; i < lines.length && hits.length < limit; i++) {
            if (lines[i].toLowerCase().includes(query.toLowerCase())) {
              hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 220)}`);
            }
          }
        }
        return hits.length ? hits.join("\n") : `no matches for "${query}"`;
      }
      case "run_shell":
        return await runShell(root, String(args.command ?? ""), args.timeout_ms);
      case "fetch_url":
        return await fetchUrl(String(args.url ?? ""));
      default:
        return `error: unknown tool "${name}"`;
    }
  } catch (err) {
    return `error: ${err.message}`;
  }
}
