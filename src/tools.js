import {
  listPaths,
  readPath,
  removePath,
  runCommand,
  writePath,
  SandboxError,
} from "./sandbox.js";

/**
 * The tool surface. Deliberately small and legible: the agent can build almost
 * anything with files, a shell and one outbound HTTP call.
 */

export const TOOL_SPECS = [
  {
    name: "write_file",
    description:
      "Create or overwrite a file in the workspace. Use a relative path such as src/app.js. Content is the complete file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path." },
        content: { type: "string", description: "Full file contents." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file from the workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "list_files",
    description: "List directory entries. Use '.' for the workspace root.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
    },
  },
  {
    name: "delete_file",
    description: "Delete a file or directory inside the workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command inside the workspace (bash). Use it to install dependencies, run tests, build, or inspect output. Network is available.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_ms: { type: "number", description: "Optional timeout, max 60000." },
      },
      required: ["command"],
    },
  },
  {
    name: "fetch_url",
    description: "Fetch a public HTTP(S) URL and return its text (first 12k characters).",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
];

export const TOOL_NAMES = TOOL_SPECS.map((tool) => tool.name);

const PRIVATE_HOSTS = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^\[?::1\]?$/,
  /\.internal$/i,
  /\.local$/i,
];

function summarizeCommand(result) {
  const firstLine = (result.stdout || result.stderr || "").split("\n").find((line) => line.trim());
  const head = firstLine ? firstLine.trim().slice(0, 120) : "no output";
  return result.killed ? `timed out · ${head}` : `exit ${result.code} · ${head}`;
}

export async function executeTool(id, name, args) {
  const input = args && typeof args === "object" ? args : {};

  try {
    switch (name) {
      case "write_file": {
        const result = await writePath(id, input.path, input.content);
        return { ok: true, summary: `wrote ${result.path} (${result.bytes} bytes)`, payload: result };
      }
      case "read_file": {
        const result = await readPath(id, input.path);
        return {
          ok: true,
          summary: `read ${result.path}`,
          payload: { path: result.path, content: result.content.slice(0, 12_000) },
        };
      }
      case "list_files": {
        const result = await listPaths(id, input.path || ".");
        return {
          ok: true,
          summary: `${result.entries.length} entries in ${result.path}`,
          payload: result,
        };
      }
      case "delete_file": {
        const result = await removePath(id, input.path);
        return { ok: true, summary: `deleted ${result.path}`, payload: result };
      }
      case "run_command": {
        const result = await runCommand(id, input.command, input.timeout_ms);
        return {
          ok: result.code === 0 && !result.killed,
          summary: summarizeCommand(result),
          payload: {
            code: result.code,
            killed: result.killed,
            stdout: result.stdout,
            stderr: result.stderr,
          },
        };
      }
      case "fetch_url": {
        const url = new URL(String(input.url || ""));
        if (url.protocol !== "https:" && url.protocol !== "http:") {
          throw new SandboxError("Only http(s) URLs can be fetched.");
        }
        if (PRIVATE_HOSTS.some((pattern) => pattern.test(url.hostname))) {
          throw new SandboxError("That host is not reachable from the engine.");
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        try {
          const res = await fetch(url, {
            signal: controller.signal,
            headers: { "user-agent": "deoid-engine/1.0" },
            redirect: "follow",
          });
          const text = (await res.text()).slice(0, 12_000);
          return {
            ok: res.ok,
            summary: `GET ${url.hostname} → ${res.status}`,
            payload: { status: res.status, content: text },
          };
        } finally {
          clearTimeout(timer);
        }
      }
      default:
        return { ok: false, summary: `unknown tool ${name}`, payload: { error: "Unknown tool." } };
    }
  } catch (error) {
    const message = error instanceof SandboxError ? error.message : String(error?.message ?? error);
    return { ok: false, summary: message.slice(0, 140), payload: { error: message } };
  }
}
