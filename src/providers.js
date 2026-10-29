import { cfg } from "./config.js";

/**
 * Every entry speaks the OpenAI /chat/completions shape. `managed: true` means
 * the Guffy operator supplies the key; anything else is BYOK.
 */
const P = (id, label, baseUrl, docs, defaultModel, extra = {}) => ({
  id,
  label,
  baseUrl,
  docs,
  defaultModel,
  managed: false,
  models: [],
  ...extra,
});

export const PROVIDERS = [
  P("openrouter", "OpenRouter", "https://openrouter.ai/api/v1", "https://openrouter.ai/keys", "openrouter/auto", {
    managed: true, managedEnv: "OPENROUTER_API_KEY", note: "Guffy-provided · 400+ models",
  }),
  P("kilo", "Kilo Gateway", "https://ai-gateway.kilo.ai/api/v1", "https://kilocode.ai", "kilo/auto", {
    managed: true, managedEnv: "KILO_API_KEY", note: "Guffy-provided · Kilo Code gateway",
  }),
  P("openai", "OpenAI", "https://api.openai.com/v1", "https://platform.openai.com/api-keys", "gpt-4o-mini"),
  P("groq", "Groq", "https://api.groq.com/openai/v1", "https://console.groq.com/keys", "llama-3.3-70b-versatile"),
  P("deepseek", "DeepSeek", "https://api.deepseek.com/v1", "https://platform.deepseek.com/api_keys", "deepseek-chat"),
  P("mistral", "Mistral", "https://api.mistral.ai/v1", "https://console.mistral.ai/api-keys", "mistral-large-latest"),
  P("together", "Together AI", "https://api.together.xyz/v1", "https://api.together.ai/settings/api-keys", "meta-llama/Llama-3.3-70B-Instruct-Turbo"),
  P("fireworks", "Fireworks AI", "https://api.fireworks.ai/inference/v1", "https://fireworks.ai/account/api-keys", "accounts/fireworks/models/llama-v3p3-70b-instruct"),
  P("perplexity", "Perplexity", "https://api.perplexity.ai", "https://www.perplexity.ai/settings/api", "sonar"),
  P("xai", "xAI", "https://api.x.ai/v1", "https://console.x.ai", "grok-2-latest"),
  P("google", "Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "https://aistudio.google.com/apikey", "gemini-2.0-flash"),
  P("cerebras", "Cerebras", "https://api.cerebras.ai/v1", "https://cloud.cerebras.ai", "llama-3.3-70b"),
  P("hyperbolic", "Hyperbolic", "https://api.hyperbolic.xyz/v1", "https://app.hyperbolic.xyz/settings", "meta-llama/Llama-3.3-70B-Instruct"),
  P("nebius", "Nebius AI Studio", "https://api.studio.nebius.ai/v1", "https://studio.nebius.ai/settings/api-keys", "meta-llama/Llama-3.3-70B-Instruct"),
  P("novita", "Novita", "https://api.novita.ai/v3/openai", "https://novita.ai/settings/key-management", "meta-llama/llama-3.3-70b-instruct"),
  P("sambanova", "SambaNova", "https://api.sambanova.ai/v1", "https://cloud.sambanova.ai/apis", "Meta-Llama-3.3-70B-Instruct"),
  P("moonshot", "Moonshot / Kimi", "https://api.moonshot.ai/v1", "https://platform.moonshot.ai/console/api-keys", "kimi-k2-0711-preview"),
  P("zhipu", "Z.ai / GLM", "https://api.z.ai/api/paas/v4", "https://z.ai/manage-apikey/apikey-list", "glm-4-plus"),
  P("minimax", "MiniMax", "https://api.minimax.io/v1", "https://www.minimax.io/platform/user-center/basic-information", "MiniMax-Text-01"),
  P("qwen", "Alibaba Qwen", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "https://bailian.console.alibabacloud.com", "qwen-max"),
  P("siliconflow", "SiliconFlow", "https://api.siliconflow.com/v1", "https://cloud.siliconflow.com/account/ak", "deepseek-ai/DeepSeek-V3"),
  P("github", "GitHub Models", "https://models.github.ai/inference", "https://github.com/settings/tokens", "openai/gpt-4o-mini"),
  P("aimlapi", "AI/ML API", "https://api.aimlapi.com/v1", "https://aimlapi.com/app/keys", "gpt-4o-mini"),
  P("requesty", "Requesty Router", "https://router.requesty.ai/v1", "https://app.requesty.ai/api-keys", "openai/gpt-4o-mini"),
  P("chutes", "Chutes", "https://llm.chutes.ai/v1", "https://chutes.ai/app/api", "deepseek-ai/DeepSeek-V3"),
  P("kluster", "Kluster.ai", "https://api.kluster.ai/v1", "https://platform.kluster.ai/apikeys", "klusterai/Meta-Llama-3.3-70B-Instruct-Turbo"),
  P("unify", "Unify", "https://api.unify.ai/v1", "https://console.unify.ai", "gpt-4o-mini@openai"),
  P("ollama", "Ollama (local)", "http://localhost:11434/v1", "https://ollama.com", "llama3.2", { note: "Runs on your own machine — the hosted engine cannot reach it" }),
  P("ollama_cloud", "Ollama Cloud", "https://ollama.com/v1", "https://ollama.com/settings/keys", "gpt-oss:120b"),
  P("lmstudio", "LM Studio", "http://localhost:1234/v1", "https://lmstudio.ai", "local-model", { note: "Local runtime" }),
  P("vllm", "vLLM", "http://localhost:8000/v1", "https://docs.vllm.ai", "local-model", { note: "Self-hosted runtime" }),
  P("litellm", "LiteLLM proxy", "http://localhost:4000/v1", "https://docs.litellm.ai", "gpt-4o-mini", { note: "Self-hosted proxy" }),
  P("llamacpp", "llama.cpp server", "http://localhost:8080/v1", "https://github.com/ggml-org/llama.cpp", "local-model", { note: "Local runtime" }),
  P("azure_openai", "Azure OpenAI", "", "https://learn.microsoft.com/azure/ai-services/openai/", "gpt-4o-mini", { needsBaseUrl: true }),
  P("custom", "Custom OpenAI-compatible", "", "https://platform.openai.com/docs/api-reference", "", { needsBaseUrl: true, custom: true }),
];

const byId = new Map(PROVIDERS.map((p) => [p.id, p]));

export const publicCatalog = () =>
  PROVIDERS.map(({ id, label, baseUrl, docs, defaultModel, managed, models, note, needsBaseUrl, custom }) => ({
    id, label, baseUrl, docs, defaultModel, managed, models, note, needsBaseUrl, custom,
  }));

export function getProvider(id) {
  return byId.get(id) ?? null;
}

/** Resolve the base URL to use, honouring a per-user override (Azure, custom). */
export function resolveBaseUrl(provider, override) {
  if (override && /^https?:\/\//i.test(override)) return override.replace(/\/+$/, "");
  return provider.baseUrl;
}

export function isManagedAvailable(provider) {
  if (!provider?.managed) return false;
  return Boolean(cfg.managedKeys[provider.id]);
}

export function headerFor(provider, apiKey) {
  if (provider.id === "azure_openai") {
    return { "api-key": apiKey, "content-type": "application/json" };
  }
  return { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
}

/** OpenRouter likes attribution headers; harmless everywhere else. */
export function attributionHeaders() {
  return { "http-referer": "https://guffy.app", "x-title": "Guffy" };
}
