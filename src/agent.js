import { cfg } from "./config.js";
import * as store from "./db.js";
import { TOOL_DEFINITIONS, executeTool } from "./tools.js";
import { streamChat, UpstreamError } from "./llm.js";
import { ensureWorkspace, projectDir } from "./workspace.js";

const SYSTEM = `You are Guffy, an autonomous coding agent working inside a browser IDE.
The user's project files live in a Linux workspace and are mirrored to a database.

Rules:
- Use the tools. Never claim you changed a file unless a write_file result confirms it.
- Read before you edit when the file already exists; then write the complete file.
- Keep the project runnable in a static preview: index.html at the root, relative asset paths,
  no server-only imports. If a framework is needed, output built assets instead of a dev server.
- Prefer small, working increments over large speculative rewrites.
- run_shell is available for builds and checks. Do not print secrets, and never run
  interactive commands (no editors, no servers that never exit).
- When you finish, summarise what changed in one or two sentences. No preamble.`;

export async function* runAgent({
  project,
  userId,
  provider,
  apiKey,
  extraHeaders,
  baseUrl,
  model,
  history,
  userMessage,
  signal,
  meta,
}) {
  const root = await ensureWorkspace(project);
  const files = await (await import("./workspace.js")).listWorkspace(project);
  const manifest = files
    .slice(0, 120)
    .map((f) => f.path)
    .join("\n");

  const messages = [
    { role: "system", content: `${SYSTEM}\n\nWorkspace: ${project.name}\nFiles at start:\n${manifest || "(empty)"}` },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userMessage },
  ];

  const ctx = { root: projectDir(project.id), projectId: project.id };
  let fullText = "";
  const trace = [];

  for (let step = 0; step < cfg.maxSteps; step++) {
    let stepText = "";
    const calls = [];

    for await (const event of streamChat({
      baseUrl,
      apiKey,
      extraHeaders,
      model,
      messages,
      tools: TOOL_DEFINITIONS,
      signal,
    })) {
      if (event.type === "text") {
        stepText += event.text;
        fullText += event.text;
        yield { type: "delta", text: event.text };
      } else if (event.type === "usage") {
        meta.promptTokens += event.promptTokens;
        meta.completionTokens += event.completionTokens;
      } else if (event.type === "tool_calls") {
        calls.push(...event.calls);
      }
    }

    if (!calls.length) {
      yield { type: "done", text: fullText };
      meta.trace = trace;
      return;
    }

    messages.push({
      role: "assistant",
      content: stepText || null,
      tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments || "{}" } })),
    });

    for (const call of calls) {
      yield { type: "tool_start", id: call.id, name: call.name, arguments: call.arguments };
      const started = Date.now();
      const result = await executeTool(ctx, call.name, call.arguments);
      const entry = {
        id: call.id,
        name: call.name,
        arguments: call.arguments,
        result: result.slice(0, 1500),
        durationMs: Date.now() - started,
      };
      trace.push(entry);
      yield { type: "tool_end", id: call.id, name: call.name, result: entry.result, durationMs: entry.durationMs };
      messages.push({ role: "tool", tool_call_id: call.id, content: result.slice(0, 24_000) });
    }
  }

  meta.trace = trace;
  yield { type: "done", text: fullText, truncated: true };
}

export { UpstreamError, store };
