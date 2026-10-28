/**
 * One model call, three wire formats. The engine keeps a neutral conversation
 * shape and converts on the way out, so a Deoid user's BYOK provider works the
 * same whether it speaks OpenAI, Anthropic or Gemini.
 */

export const PROVIDER_BASE = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  deepseek: "https://api.deepseek.com/v1",
  xai: "https://api.x.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  together: "https://api.together.xyz/v1",
  cerebras: "https://api.cerebras.ai/v1",
  custom: "",
};

export function providerStyle(provider, baseUrl) {
  if (provider === "anthropic") return "anthropic";
  if (provider === "google") return "google";
  if (provider === "custom") return "openai";
  if (!PROVIDER_BASE[provider] && baseUrl) return "openai";
  return "openai";
}

export function baseUrlFor(provider, override) {
  return (override || PROVIDER_BASE[provider] || "").replace(/\/+$/, "");
}

/**
 * Keys arrive from a browser form, so they can carry a stray `Bearer `, a whole
 * `Authorization:` line, quotes, or newlines from a wrapped copy. Strip all of
 * that before it reaches a provider; an empty result is a caller error, not a
 * provider error, and must never be sent as `Bearer ` (OpenRouter answers that
 * with "Missing Authentication header").
 */
export function normalizeKey(raw) {
  let key = String(raw ?? "").replace(/[\r\n\t]/g, "").trim();
  key = key.replace(/^authorization\s*:\s*/i, "").trim();
  key = key.replace(/^bearer\s+/i, "").trim();
  if (/^bearer$/i.test(key)) key = "";
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }
  return key;
}

/** OpenRouter asks for attribution and uses it for rate-limit tiers. */
function attributionHeaders(provider) {
  if (provider !== "openrouter") return {};
  return {
    "HTTP-Referer": process.env.SITE_URL || "https://deoid.netlify.app",
    "X-Title": process.env.SITE_NAME || "Deoid",
  };
}

function parseArgs(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/* ------------------------------- OpenAI ---------------------------------- */

function toOpenAIMessages(messages) {
  return messages.map((message) => {
    if (message.role === "tool") {
      return { role: "tool", tool_call_id: message.toolCallId, content: JSON.stringify(message.payload ?? {}) };
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        })),
      };
    }
    return { role: message.role, content: message.content ?? "" };
  });
}

/** Pulls the useful sentence out of an error body, whatever shape it has. */
async function errorDetail(res) {
  const text = await res.text().catch(() => "");
  try {
    const data = JSON.parse(text);
    const raw = data?.error?.message || data?.message || data?.error || text;
    return typeof raw === "string" ? raw : JSON.stringify(raw);
  } catch {
    return text.slice(0, 400);
  }
}

function buildError(res, message, provider) {
  const lower = message.toLowerCase();

  if (
    lower.includes("missing authentication header") ||
    lower.includes("no auth credentials") ||
    lower.includes("no cookie auth credentials")
  ) {
    message += " — the provider saw an empty key. Re-add it in Deoid → Settings → Model keys.";
  } else if (
    lower.includes("user not found") ||
    lower.includes("invalid api key") ||
    lower.includes("incorrect api key") ||
    lower.includes("api key not valid") ||
    lower.includes("invalid_api_key") ||
    lower.includes("authentication_error")
  ) {
    message += " — that key is wrong or was revoked. Re-add it in Deoid → Settings → Model keys.";
  } else if (res.status === 402) {
    message += " — this provider account is out of credits.";
  } else if (res.status === 429) {
    message += " — rate limited. Wait a moment or switch models.";
  } else if (res.status === 404) {
    message += ` — check the model id and base URL for ${provider || "this provider"}.`;
  }

  const error = new Error(message);
  error.status = res.status;
  return error;
}

async function callOpenAI({ baseUrl, apiKey, model, messages, tools, signal, provider }) {
  if (!apiKey) {
    throw new Error(
      "No usable API key reached the engine. Re-add the key in Deoid → Settings → Model keys (paste only the key, not the word Bearer).",
    );
  }

  const url = `${baseUrl}/chat/completions`;
  const headers = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    "user-agent": "deoid-engine/1.0",
    ...attributionHeaders(provider),
  };
  const base = {
    model,
    messages: toOpenAIMessages(messages),
    tools: tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    })),
    tool_choice: "auto",
  };

  // Reasoning models reject max_tokens; older ones reject max_completion_tokens.
  const { max_tokens: _ignored, ...withoutLimit } = {
    ...base,
    max_tokens: 8192,
  };
  const variants = [
    { ...base, max_tokens: 8192 },
    { ...base, max_completion_tokens: 8192 },
    withoutLimit,
  ];

  let lastError = null;

  for (let index = 0; index < variants.length; index++) {
    const res = await fetch(url, {
      method: "POST",
      signal,
      headers,
      body: JSON.stringify(variants[index]),
    });

    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      const choice = data?.choices?.[0]?.message ?? {};
      const toolCalls = (choice.tool_calls ?? []).map((call) => ({
        id: call.id || `call_${Math.random().toString(36).slice(2)}`,
        name: call.function?.name,
        args: parseArgs(call.function?.arguments),
      }));
      return { text: typeof choice.content === "string" ? choice.content : "", toolCalls };
    }

    const detail = await errorDetail(res);
    const lower = detail.toLowerCase();
    const paramComplaint =
      lower.includes("max_tokens") ||
      lower.includes("max_completion_tokens") ||
      lower.includes("unsupported parameter") ||
      lower.includes("unrecognized request argument") ||
      lower.includes("unknown parameter");

    lastError = buildError(res, detail || `Provider replied ${res.status}.`, provider);

    // Only a rejected limit is worth retrying. Auth and quota fail identically
    // with a smaller body.
    if ((res.status === 400 || res.status === 422) && paramComplaint && index < variants.length - 1) {
      continue;
    }
    throw lastError;
  }

  throw lastError || new Error("The provider did not return a response.");
}

/* ------------------------------ Anthropic -------------------------------- */

function toAnthropic(messages) {
  let system = "";
  const out = [];

  for (const message of messages) {
    if (message.role === "system") {
      system += `${message.content}\n\n`;
      continue;
    }

    if (message.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: JSON.stringify(message.payload ?? {}).slice(0, 20_000),
        is_error: message.ok === false,
      };
      const last = out[out.length - 1];
      if (last?.role === "user" && Array.isArray(last.content) && last.content[0]?.type === "tool_result") {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }

    if (message.role === "assistant") {
      const content = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.args ?? {} });
      }
      if (content.length) out.push({ role: "assistant", content });
      continue;
    }

    out.push({ role: "user", content: [{ type: "text", text: message.content ?? "" }] });
  }

  return { system: system.trim(), messages: out };
}

async function callAnthropic({ baseUrl, apiKey, model, messages, tools, signal }) {
  const payload = toAnthropic(messages);
  const headers = {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "user-agent": "deoid-engine/1.0",
  };
  const body = (maxTokens) =>
    JSON.stringify({
      model,
      system: payload.system || undefined,
      messages: payload.messages,
      max_tokens: maxTokens,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      })),
    });

  // Older Claude models cap output tokens below 8192; walk the limit down.
  let res;
  let data = {};
  for (const maxTokens of [8192, 4096, 2048]) {
    res = await fetch(`${baseUrl}/messages`, { method: "POST", signal, headers, body: body(maxTokens) });
    data = await res.json().catch(() => ({}));
    if (res.ok) break;
    const message = String(data?.error?.message || data?.message || "");
    if (!(res.status === 400 && message.toLowerCase().includes("max_tokens"))) break;
  }

  if (!res.ok) {
    const message = data?.error?.message || data?.message || `Provider replied ${res.status}.`;
    throw buildError(res, message, "anthropic");
  }

  let text = "";
  const toolCalls = [];
  for (const block of data?.content ?? []) {
    if (block.type === "text") text += block.text ?? "";
    if (block.type === "tool_use") {
      toolCalls.push({ id: block.id, name: block.name, args: block.input ?? {} });
    }
  }
  return { text, toolCalls };
}

/* -------------------------------- Google --------------------------------- */

function toGoogle(messages) {
  let system = "";
  const contents = [];

  for (const message of messages) {
    if (message.role === "system") {
      system += `${message.content}\n\n`;
      continue;
    }

    if (message.role === "tool") {
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: message.toolName || "tool",
              response: message.payload ?? {},
            },
          },
        ],
      });
      continue;
    }

    if (message.role === "assistant") {
      const parts = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls ?? []) {
        parts.push({ functionCall: { name: call.name, args: call.args ?? {} } });
      }
      if (parts.length) contents.push({ role: "model", parts });
      continue;
    }

    contents.push({ role: "user", parts: [{ text: message.content ?? "" }] });
  }

  return { system: system.trim(), contents };
}

async function callGoogle({ baseUrl, apiKey, model, messages, tools, signal }) {
  const payload = toGoogle(messages);
  const res = await fetch(
    `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", "user-agent": "deoid-engine/1.0" },
      body: JSON.stringify({
        systemInstruction: payload.system ? { parts: [{ text: payload.system }] } : undefined,
        contents: payload.contents,
        tools: [
          {
            functionDeclarations: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
          },
        ],
        generationConfig: { maxOutputTokens: 8192 },
      }),
    },
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `Provider replied ${res.status}.`);
  }

  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  let text = "";
  const toolCalls = [];
  for (const part of parts) {
    if (part.text) text += part.text;
    if (part.functionCall) {
      toolCalls.push({
        id: `call_${Math.random().toString(36).slice(2)}`,
        name: part.functionCall.name,
        args: part.functionCall.args ?? {},
      });
    }
  }

  return { text, toolCalls };
}

/* -------------------------------- Public --------------------------------- */

export async function callModel({ provider, baseUrl, apiKey, model, messages, tools, signal }) {
  const style = providerStyle(provider, baseUrl);
  const url = baseUrlFor(provider, baseUrl);
  const key = normalizeKey(apiKey);

  if (!url) throw new Error("No base URL for this provider. Set a custom base URL.");
  if (!key) {
    throw new Error(
      "The model key is empty. Re-add it in Deoid → Settings → Model keys; paste the key itself, not the word Bearer.",
    );
  }

  if (style === "anthropic") {
    return callAnthropic({ baseUrl: url, apiKey: key, model, messages, tools, signal });
  }
  if (style === "google") {
    return callGoogle({ baseUrl: url, apiKey: key, model, messages, tools, signal });
  }
  return callOpenAI({ baseUrl: url, apiKey: key, model, messages, tools, signal, provider });
}
