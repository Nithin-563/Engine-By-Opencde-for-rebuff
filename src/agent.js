import { callModel } from "./providers.js";
import { TOOL_SPECS, executeTool } from "./tools.js";
import { ensureSession, fileTree } from "./sandbox.js";

const MAX_STEPS = Math.min(Math.max(Number(process.env.MAX_STEPS) || 12, 1), 30);

export function systemFor(surface) {
  const common = `You are Deoid, a pragmatic coding agent running inside a real Linux workspace.

You have tools: write_file, read_file, list_files, delete_file, run_command, fetch_url.
Rules:
- Work in relative paths. The workspace is persistent for this thread.
- Inspect before you overwrite. Prefer many small, correct files over one huge file.
- Use run_command to install dependencies, run tests and verify the build when the task calls for it.
- Never print API keys, tokens or environment variables.
- Do not claim something works until you ran it or read the result.
- When you are done, reply with a short summary: what you built, how to run it, and the file list.`;

  if (surface === "builder") {
    return `${common}

This is Builder mode. Produce a complete, runnable app in the workspace:
- package.json plus source files, and a README with run instructions.
- Run the install/build/test commands that make sense for the stack you chose.
- Choose the best stack for the request unless the user named one.
- Finish with the exact commands to run the app locally.`;
  }

  if (surface === "cowork") {
    return `${common}

This is Cowork mode. You handle real work end to end: research, documents, scripts,
data cleanup, small automations. Create the files the user can take away, and say
where they are.`;
  }

  return `${common}

This is Chat mode. Answer directly. Use tools only when the user asks for files,
commands or something you must verify.`;
}

function cleanMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => message && (message.role === "user" || message.role === "assistant"))
    .filter((message) => typeof message.content === "string" && message.content.trim())
    .slice(-24)
    .map((message) => ({ role: message.role, content: message.content }));
}

/**
 * Runs the tool loop and reports progress through `emit(event, data)`.
 * Returns the final assistant text and the files left in the workspace.
 */
export async function runAgent({
  session,
  surface,
  provider,
  model,
  apiKey,
  baseUrl,
  messages,
  emit,
  signal,
}) {
  await ensureSession(session);

  const conversation = [
    { role: "system", content: systemFor(surface) },
    ...cleanMessages(messages),
  ];

  if (!conversation.some((message) => message.role === "user")) {
    throw new Error("No user message was provided.");
  }

  let lastText = "";
  let steps = 0;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    steps = step + 1;
    emit("status", { message: `thinking (step ${steps}/${MAX_STEPS})` });

    const result = await callModel({
      provider,
      baseUrl,
      apiKey,
      model,
      messages: conversation,
      tools: TOOL_SPECS,
      signal,
    });

    if (result.text) lastText = result.text;

    if (!result.toolCalls.length) {
      return {
        text: result.text || lastText || "Done.",
        steps,
        files: await fileTree(session),
      };
    }

    conversation.push({
      role: "assistant",
      content: result.text || "",
      toolCalls: result.toolCalls,
    });

    for (const call of result.toolCalls) {
      emit("status", { message: `${call.name}…` });
      const outcome = await executeTool(session, call.name, call.args);
      emit("tool", {
        name: call.name,
        ok: outcome.ok,
        summary: outcome.summary,
      });
      conversation.push({
        role: "tool",
        toolCallId: call.id,
        toolName: call.name,
        content: outcome.summary,
        payload: outcome.payload,
        ok: outcome.ok,
      });
    }
  }

  // Hit the step budget: ask for a wrap-up without tools.
  emit("status", { message: "wrapping up" });
  const wrap = await callModel({
    provider,
    baseUrl,
    apiKey,
    model,
    messages: [
      ...conversation,
      {
        role: "user",
        content: "Stop using tools. Summarise what you did and how to run it.",
      },
    ],
    tools: [],
    signal,
  });

  return {
    text: wrap.text || lastText || "Stopped after the step limit.",
    steps,
    files: await fileTree(session),
  };
}
