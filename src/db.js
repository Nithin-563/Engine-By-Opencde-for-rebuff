import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { cfg, isConfigured } from "./config.js";

let admin = null;

export function db() {
  if (!isConfigured()) throw new Error("engine is not configured (see /health)");
  if (!admin) {
    admin = createClient(cfg.supabaseUrl, cfg.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { "x-application-name": "guffy-engine" } },
    });
  }
  return admin;
}

export async function authenticate(token) {
  if (!token) return null;
  const { data, error } = await db().auth.getUser(token);
  if (error || !data?.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}

/* --------------------------------------------------------------- secret box */

const aesKey = () => crypto.createHash("sha256").update(cfg.appSecret).digest();

export function seal(plaintext) {
  if (!cfg.appSecret) throw new Error("APP_SECRET is not set");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
}

export function open(blob) {
  const [iv, tag, ct] = String(blob).split(".");
  if (!iv || !tag || !ct) throw new Error("malformed sealed value");
  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

/* ------------------------------------------------------------------ profile */

export async function getProfile(userId) {
  const { data, error } = await db().from("guffy_profiles").select("*").eq("id", userId).maybeSingle();
  if (error) throw error;
  if (data) return data;
  const { data: created, error: insErr } = await db()
    .from("guffy_profiles")
    .insert({ id: userId })
    .select("*")
    .single();
  if (insErr) throw insErr;
  return created;
}

export async function consumeQuota(userId) {
  const { data, error } = await db().rpc("guffy_consume_quota", { p_user: userId });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return {
    allowed: Boolean(row?.allowed),
    remaining: row?.remaining ?? 0,
    resetsAt: row?.resets_at ?? null,
    limit: row?.limit_value ?? 0,
  };
}

/* ----------------------------------------------------------------- projects */

const projectColumns = "id,user_id,name,framework,entry_file,created_at,updated_at";

export async function listProjects(userId) {
  const { data, error } = await db()
    .from("guffy_projects")
    .select(projectColumns)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function getProject(userId, projectId) {
  const { data, error } = await db()
    .from("guffy_projects")
    .select(projectColumns)
    .eq("id", projectId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

const STARTER_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Guffy starter</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #0b0b0d; color: #f5f2ee; }
  main { max-width: 34rem; padding: 2.5rem; border: 1px solid #26262b;
    border-radius: 18px; background: linear-gradient(180deg,#141417,#0f0f12); }
  h1 { margin: 0 0 .5rem; font-size: 1.6rem; letter-spacing: -.02em; }
  p { margin: 0 0 1rem; color: #a9a49c; line-height: 1.6; }
  code { background: #1c1c21; padding: .15rem .4rem; border-radius: 6px; color: #ffb37a; }
</style>
</head>
<body>
<main>
  <h1>Your Guffy project is live</h1>
  <p>This page is served from the Guffy engine preview. Ask the agent to change
  <code>index.html</code>, then reload this frame.</p>
  <p>When it looks right, deploy it to Netlify from the top bar.</p>
</main>
</body>
</html>
`;

export async function createProject(userId, { name, framework = "static" } = {}) {
  const { data, error } = await db()
    .from("guffy_projects")
    .insert({ user_id: userId, name: name?.trim() || "Untitled project", framework })
    .select(projectColumns)
    .single();
  if (error) throw error;
  await putFile(data.id, "index.html", STARTER_PAGE);
  return data;
}

export async function touchProject(projectId) {
  await db().from("guffy_projects").update({ updated_at: new Date().toISOString() }).eq("id", projectId);
}

export async function renameProject(userId, projectId, name) {
  const { error } = await db()
    .from("guffy_projects")
    .update({ name, updated_at: new Date().toISOString() })
    .eq("id", projectId)
    .eq("user_id", userId);
  if (error) throw error;
}

export async function deleteProject(userId, projectId) {
  const { error } = await db().from("guffy_projects").delete().eq("id", projectId).eq("user_id", userId);
  if (error) throw error;
}

/* ----------------------------------------------------------------- messages */

export async function listMessages(projectId, limit = 200) {
  const { data, error } = await db()
    .from("guffy_messages")
    .select("id,role,content,metadata,created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export async function addMessage(projectId, userId, role, content, metadata = {}) {
  const { data, error } = await db()
    .from("guffy_messages")
    .insert({ project_id: projectId, user_id: userId, role, content, metadata })
    .select("id,role,content,metadata,created_at")
    .single();
  if (error) throw error;
  return data;
}

/* --------------------------------------------------------------------- runs */

export async function startRun(projectId, userId, provider, model) {
  const { data, error } = await db()
    .from("guffy_runs")
    .insert({ project_id: projectId, user_id: userId, provider, model, status: "running" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export async function finishRun(id, { status, promptTokens, completionTokens, durationMs, toolTrace, error, messageId }) {
  await db()
    .from("guffy_runs")
    .update({
      status,
      prompt_tokens: promptTokens ?? null,
      completion_tokens: completionTokens ?? null,
      duration_ms: durationMs ?? null,
      tool_trace: toolTrace ?? [],
      error: error ?? null,
      message_id: messageId ?? null,
    })
    .eq("id", id);
}

/* -------------------------------------------------------------------- files */

export async function listFiles(projectId) {
  const { data, error } = await db()
    .from("guffy_project_files")
    .select("path,content,size,updated_at")
    .eq("project_id", projectId)
    .order("path", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function getFile(projectId, filePath) {
  const { data, error } = await db()
    .from("guffy_project_files")
    .select("path,content,size,updated_at")
    .eq("project_id", projectId)
    .eq("path", filePath)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function putFile(projectId, filePath, content) {
  const { error } = await db().from("guffy_project_files").upsert(
    {
      project_id: projectId,
      path: filePath,
      content,
      size: Buffer.byteLength(content, "utf8"),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "project_id,path" },
  );
  if (error) throw error;
  await touchProject(projectId);
}

export async function removeFile(projectId, filePath) {
  const { error } = await db().from("guffy_project_files").delete().eq("project_id", projectId).eq("path", filePath);
  if (error) throw error;
}

/* ------------------------------------------------------------- provider keys */

export async function listKeyHints(userId) {
  const { data, error } = await db().from("guffy_provider_keys").select("provider,hint,updated_at").eq("user_id", userId);
  if (error) throw error;
  return data ?? [];
}

export async function getKey(userId, provider) {
  const { data, error } = await db()
    .from("guffy_provider_keys")
    .select("ciphertext")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  try {
    const parsed = JSON.parse(open(data.ciphertext));
    return parsed?.apiKey ? parsed : null;
  } catch {
    return null;
  }
}

export async function setKey(userId, provider, payload) {
  const { apiKey, baseUrl } = payload;
  const hint = `…${String(apiKey).slice(-4)}`;
  const { error } = await db().from("guffy_provider_keys").upsert(
    {
      user_id: userId,
      provider,
      ciphertext: seal(JSON.stringify({ apiKey, baseUrl: baseUrl ?? null })),
      hint,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,provider" },
  );
  if (error) throw error;
}

export async function deleteKey(userId, provider) {
  const { error } = await db().from("guffy_provider_keys").delete().eq("user_id", userId).eq("provider", provider);
  if (error) throw error;
}

/* -------------------------------------------------------------- deployments */

export async function recordDeployment(row) {
  const { data, error } = await db().from("guffy_deployments").insert(row).select("id").single();
  if (error) throw error;
  return data.id;
}

export async function updateDeployment(id, patch) {
  await db().from("guffy_deployments").update(patch).eq("id", id);
}

export async function listDeployments(projectId) {
  const { data, error } = await db()
    .from("guffy_deployments")
    .select("id,target,url,status,error,created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) throw error;
  return data ?? [];
}
