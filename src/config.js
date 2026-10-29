import path from "node:path";

const str = (v, fallback = "") => (typeof v === "string" && v.trim() ? v.trim() : fallback);
const bool = (v, fallback) => (v === undefined ? fallback : v === "true" || v === "1");

const webOrigin = str(process.env.WEB_ORIGIN, "*");

export const cfg = {
  port: Number(str(process.env.PORT, "8080")),
  supabaseUrl: str(process.env.SUPABASE_URL),
  supabaseAnonKey: str(process.env.SUPABASE_ANON_KEY),
  supabaseServiceKey: str(process.env.SUPABASE_SERVICE_ROLE_KEY),
  appSecret: str(process.env.APP_SECRET),
  dataDir: path.resolve(str(process.env.DATA_DIR, "./.data/workspaces")),
  publicUrl: str(process.env.PUBLIC_URL).replace(/\/+$/, ""),
  webOrigins: webOrigin.split(",").map((s) => s.trim()).filter(Boolean),
  allowShell: bool(process.env.ALLOW_SHELL, true),
  shellTimeoutMs: Number(str(process.env.SHELL_TIMEOUT_MS, "45000")),
  maxSteps: Number(str(process.env.MAX_AGENT_STEPS, "14")),
  // Keys the Guffy owner pays for. Users pick these providers without a key.
  managedKeys: {
    openrouter: str(process.env.OPENROUTER_API_KEY),
    kilo: str(process.env.KILO_API_KEY),
  },
  netlifyToken: str(process.env.NETLIFY_AUTH_TOKEN),
  netlifySiteId: str(process.env.NETLIFY_SITE_ID),
  supabaseManagement: {
    projectRef: str(process.env.SUPABASE_PROJECT_REF),
  },
};

export const missing = [];
if (!cfg.supabaseUrl) missing.push("SUPABASE_URL");
if (!cfg.supabaseAnonKey) missing.push("SUPABASE_ANON_KEY");
if (!cfg.supabaseServiceKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
if (!cfg.appSecret) missing.push("APP_SECRET");
if (cfg.appSecret && cfg.appSecret.length < 24) {
  missing.push("APP_SECRET (must be at least 24 characters)");
}

export const isConfigured = () => missing.length === 0;

export function reportConfig(log = console) {
  if (missing.length) {
    log.warn(`[guffy] missing environment: ${missing.join(", ")}`);
    log.warn("[guffy] running in degraded mode — health and provider catalog only");
  }
  const managed = Object.entries(cfg.managedKeys).filter(([, v]) => v).map(([k]) => k);
  log.info(`[guffy] managed providers: ${managed.join(", ") || "none"}`);
  if (!cfg.netlifyToken) log.info("[guffy] NETLIFY_AUTH_TOKEN unset — deploy endpoint will ask users for a token");
}
