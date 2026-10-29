import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { cfg } from "./config.js";
import * as store from "./db.js";
import { walk } from "./tools.js";

export const projectDir = (projectId) => path.join(cfg.dataDir, projectId);

export const previewSignature = (projectId) =>
  crypto.createHmac("sha256", cfg.appSecret || "dev").update(projectId).digest("base64url").slice(0, 24);

/**
 * Materialise a project on local disk from Supabase. The engine disk is
 * ephemeral on Render, so the database is the source of truth and this runs on
 * every first touch (and again after a restart).
 */
export async function ensureWorkspace(project) {
  const dir = projectDir(project.id);
  const marker = path.join(dir, ".guffy-synced");
  try {
    await fs.access(marker);
    return dir;
  } catch {
    // fall through and rebuild
  }
  await fs.mkdir(dir, { recursive: true });
  const files = await store.listFiles(project.id);
  for (const file of files) {
    const abs = path.join(dir, file.path);
    if (!abs.startsWith(dir)) continue;
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, file.content, "utf8");
  }
  await fs.writeFile(marker, new Date().toISOString(), "utf8");
  return dir;
}

export async function resetWorkspace(project) {
  await fs.rm(projectDir(project.id), { recursive: true, force: true });
  return ensureWorkspace(project);
}

export async function listWorkspace(project) {
  const dir = await ensureWorkspace(project);
  const files = await walk(dir);
  return Promise.all(
    files.map(async (rel) => {
      const stat = await fs.stat(path.join(dir, rel)).catch(() => null);
      return { path: rel, size: stat?.size ?? 0 };
    }),
  );
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

export const mimeFor = (file) => MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";

/** Resolve one preview request inside a project directory, with SPA fallback. */
export async function resolvePreviewFile(dir, requestPath) {
  const clean = decodeURIComponent(String(requestPath || "")).replace(/^\/+/, "").replace(/\\/g, "/");
  const candidate = path.resolve(dir, clean || "index.html");
  if (!candidate.startsWith(path.resolve(dir))) return null;

  const serveIndex = async () => {
    for (const name of ["index.html", "public/index.html"]) {
      const abs = path.join(dir, name);
      const file = await fs.readFile(abs).catch(() => null);
      if (file) return { abs, body: file };
    }
    return null;
  };

  if (!clean || clean.endsWith("/")) return serveIndex();

  const body = await fs.readFile(candidate).catch(() => null);
  if (body) return { abs: candidate, body };

  // Extensionless routes fall back to the entry document.
  if (!path.extname(clean)) return serveIndex();
  return null;
}
