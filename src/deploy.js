import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { walk } from "./tools.js";

const API = "https://api.netlify.com/api/v1";
const SKIP = new Set([".git", "node_modules", ".data", ".guffy-synced", "dist", ".env", ".env.local"]);

async function netlify(token, route, init = {}) {
  const res = await fetch(`${API}${route}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`netlify ${res.status}: ${body.slice(0, 400)}`);
  }
  return res;
}

async function collectFiles(dir) {
  const files = [];
  for (const rel of await walk(dir)) {
    if (SKIP.has(rel) || rel.split("/").some((seg) => SKIP.has(seg))) continue;
    const abs = path.join(dir, rel);
    const body = await fs.readFile(abs).catch(() => null);
    if (!body) continue;
    files.push({ rel, body, sha1: crypto.createHash("sha1").update(body).digest("hex") });
  }
  return files;
}

/**
 * Deploy a project workspace to Netlify with the file-digest API (no zip step).
 * Returns the live URL once Netlify reports the deploy ready.
 */
export async function deployToNetlify({ project, dir, token, siteId, siteName }) {
  if (!token) throw new Error("a Netlify personal access token is required");
  const files = await collectFiles(dir);
  if (!files.length) throw new Error("workspace is empty — nothing to deploy");

  let targetSite = siteId;
  if (!targetSite) {
    const res = await netlify(token, "/sites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: siteName }),
    });
    const site = await res.json();
    targetSite = site.id;
  }

  const digest = Object.fromEntries(files.map((f) => [`/${f.rel}`, f.sha1]));
  const created = await netlify(token, `/sites/${targetSite}/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files: digest }),
  });
  const deploy = await created.json();
  const required = new Set(deploy.required ?? []);

  for (const file of files) {
    if (required.size && !required.has(file.sha1)) continue;
    await netlify(token, `/deploys/${deploy.id}/files/${file.rel.split("/").map(encodeURIComponent).join("/")}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: file.body,
    });
  }

  const deadline = Date.now() + 120_000;
  let state = deploy.state ?? "uploading";
  let url = deploy.ssl_url ?? deploy.url ?? null;
  while (Date.now() < deadline) {
    if (state === "ready" || state === "current") break;
    if (state === "error") throw new Error("netlify reported a failed deploy");
    await new Promise((r) => setTimeout(r, 2500));
    const poll = await netlify(token, `/deploys/${deploy.id}`);
    const info = await poll.json();
    state = info.state ?? state;
    url = info.ssl_url ?? info.url ?? url;
  }
  if (!url) throw new Error("netlify deploy finished without a URL");
  return { url, siteId: targetSite, deployId: deploy.id, state };
}
