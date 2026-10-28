import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

/**
 * Every chat gets its own directory under WORKSPACE_ROOT. Paths from the model
 * are resolved inside that directory and anything that escapes is rejected.
 */

const ROOT = resolve(process.env.WORKSPACE_ROOT || "/tmp/deoid-workspaces");
const MAX_FILE_BYTES = 400_000;
const MAX_OUTPUT = 20_000;
const MAX_TIMEOUT_MS = 60_000;

const BLOCKED = [
  /rm\s+-rf\s+\/(\s|$)/i,
  /\bmkfs\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\bdd\s+if=.*of=\/dev\//i,
  /\bchown\s+-R\s+.*\s+\/(\s|$)/i,
];

export class SandboxError extends Error {}

export function sessionId(input) {
  const raw = String(input || "").trim();
  if (!raw) return randomBytes(8).toString("hex");
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

export function sessionDir(id) {
  return join(ROOT, id);
}

export async function ensureSession(id) {
  const dir = sessionDir(id);
  await mkdir(dir, { recursive: true });
  return dir;
}

function safePath(id, requested) {
  const base = sessionDir(id);
  const cleaned = normalize(String(requested || ".").replace(/\\/g, "/")).replace(/^([/])+/, "");
  const target = resolve(base, cleaned);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new SandboxError("That path is outside the session workspace.");
  }
  return target;
}

export function relative(id, absolute) {
  const base = sessionDir(id);
  return absolute.startsWith(base) ? absolute.slice(base.length + 1) || "." : absolute;
}

export async function writePath(id, path, content) {
  if (typeof content !== "string") throw new SandboxError("content must be a string.");
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    throw new SandboxError(`File is too large (max ${MAX_FILE_BYTES} bytes).`);
  }
  const target = safePath(id, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  return { path: relative(id, target), bytes: Buffer.byteLength(content, "utf8") };
}

export async function readPath(id, path) {
  const target = safePath(id, path);
  const info = await stat(target);
  if (!info.isFile()) throw new SandboxError("Not a file.");
  if (info.size > MAX_FILE_BYTES) throw new SandboxError("File is too large to read.");
  return { path: relative(id, target), content: await readFile(target, "utf8") };
}

export async function listPaths(id, path = ".") {
  const target = safePath(id, path);
  if (!existsSync(target)) return { path, entries: [] };

  const entries = await readdir(target, { withFileTypes: true });
  const rows = [];
  for (const entry of entries.slice(0, 400)) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    rows.push({
      name: entry.name,
      type: entry.isDirectory() ? "dir" : "file",
      path: relative(id, join(target, entry.name)),
    });
  }
  return { path: relative(id, target), entries: rows };
}

export async function removePath(id, path) {
  const target = safePath(id, path);
  if (target === sessionDir(id)) throw new SandboxError("Refusing to delete the workspace root.");
  await rm(target, { recursive: true, force: true });
  return { path: relative(id, target), deleted: true };
}

export async function fileTree(id) {
  const dir = sessionDir(id);
  if (!existsSync(dir)) return [];
  const out = [];
  async function walk(current, depth) {
    if (depth > 4 || out.length > 300) return;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const absolute = join(current, entry.name);
      const rel = relative(id, absolute);
      if (entry.isDirectory()) {
        out.push({ path: rel, type: "dir" });
        await walk(absolute, depth + 1);
      } else {
        const info = await stat(absolute).catch(() => null);
        out.push({ path: rel, type: "file", bytes: info?.size ?? 0 });
      }
    }
  }
  await walk(dir, 0);
  return out;
}

export function sanitizedEnv() {
  const allow = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "NODE_ENV", "SHELL", "TMPDIR"];
  const env = {};
  for (const key of allow) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.HOME = ROOT;
  env.CI = "1";
  env.NO_COLOR = "1";
  // Never leak model keys, tokens or the operator's environment into a shell.
  return env;
}

export async function runCommand(id, command, timeoutMs = 30_000) {
  if (typeof command !== "string" || !command.trim()) {
    throw new SandboxError("command must be a non-empty string.");
  }
  for (const pattern of BLOCKED) {
    if (pattern.test(command)) throw new SandboxError("That command is blocked by the engine policy.");
  }

  const cwd = await ensureSession(id);
  const timeout = Math.min(Math.max(Number(timeoutMs) || 30_000, 1_000), MAX_TIMEOUT_MS);

  return new Promise((resolvePromise, reject) => {
    const child = spawn("/bin/sh", ["-lc", command], {
      cwd,
      env: sanitizedEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeout);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new SandboxError(`Could not start the command: ${error.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        code: code ?? -1,
        killed,
        stdout: stdout.slice(0, MAX_OUTPUT),
        stderr: stderr.slice(0, MAX_OUTPUT),
      });
    });
  });
}

export async function resetSession(id) {
  await rm(sessionDir(id), { recursive: true, force: true });
  return { sessionId: id, reset: true };
}
