import { attributionHeaders } from "./providers.js";

const REDACT = (s) => String(s ?? "").replace(/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, "$1…redacted");

/**
 * Stream an OpenAI-compatible chat completion.
 * Yields: {type:'text',text} | {type:'tool_calls',calls} | {type:'usage',...}
 */
export async function* streamChat({ baseUrl, apiKey, extraHeaders, model, messages, tools, signal, temperature = 0.3 }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body = {
    model,
    messages,
    stream: true,
    temperature,
    ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
  };

  const call = (withUsage) =>
    fetch(url, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", ...attributionHeaders(), ...extraHeaders },
      body: JSON.stringify(withUsage ? { ...body, stream_options: { include_usage: true } } : body),
    });

  let res = await call(true);
  if (res.status === 400) {
    // Some gateways reject stream_options; retry without it once.
    const detail = await res.text();
    if (!/stream_options|unknown field|unrecognized/i.test(detail)) {
      throw new UpstreamError(res.status, REDACT(detail));
    }
    res = await call(false);
  }
  if (!res.ok) throw new UpstreamError(res.status, REDACT(await res.text()));

  const decoder = new TextDecoder();
  let buffer = "";
  const partial = new Map(); // index -> {id, name, arguments}

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      if (json.error) throw new UpstreamError(502, REDACT(json.error.message ?? JSON.stringify(json.error)));
      if (json.usage) {
        yield { type: "usage", promptTokens: json.usage.prompt_tokens ?? 0, completionTokens: json.usage.completion_tokens ?? 0 };
      }
      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content) yield { type: "text", text: delta.content };
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const cur = partial.get(idx) ?? { id: tc.id ?? `call_${idx}`, name: "", arguments: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        partial.set(idx, cur);
      }
    }
  }

  const calls = [...partial.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
    .filter((c) => c.name);

  if (calls.length) yield { type: "tool_calls", calls };
}

export class UpstreamError extends Error {
  constructor(status, detail) {
    super(`upstream ${status}: ${String(detail).slice(0, 600)}`);
    this.status = status;
    this.detail = String(detail).slice(0, 1200);
  }
}

/** List models from a provider's /models endpoint, degrading to the catalog default. */
export async function listModels({ baseUrl, apiKey, extraHeaders, provider }) {
  const fallback = provider.models?.length
    ? provider.models.map((id) => ({ id, free: false }))
    : provider.defaultModel
      ? [{ id: provider.defaultModel, free: false }]
      : [];

  if (!baseUrl || !apiKey) return { models: fallback, source: "catalog" };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { ...attributionHeaders(), ...extraHeaders },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { models: fallback, source: "catalog" };

    const json = await res.json();
    const rows = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
    const models = rows
      .map((row) => {
        const id = row.id ?? row.name ?? row.model;
        if (!id) return null;
        const prompt = Number(row.pricing?.prompt ?? 0);
        const completion = Number(row.pricing?.completion ?? 0);
        const free = /:free$/.test(id) || (row.pricing && prompt === 0 && completion === 0);
        return { id: String(id), free: Boolean(free), context: row.context_length ?? row.context_window ?? null };
      })
      .filter(Boolean)
      .sort((a, b) => Number(b.free) - Number(a.free) || a.id.localeCompare(b.id));

    return { models: models.length ? models : fallback, source: "remote" };
  } catch {
    return { models: fallback, source: "catalog" };
  }
}
