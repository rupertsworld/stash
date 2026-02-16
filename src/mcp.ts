import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { StashManager } from "./core/manager.js";

export function createMcpServer(manager: StashManager): Server {
  const server = new Server(
    { name: "stash", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "stash_list",
        description:
          "List stashes or files within a stash. No stash = list all stashes. With stash = list files at path (or root if no path).",
        inputSchema: {
          type: "object" as const,
          properties: {
            stash: { type: "string", description: "Stash name" },
            path: {
              type: "string",
              description: "Directory path within stash (defaults to root)",
            },
          },
        },
      },
      {
        name: "stash_glob",
        description: "Find files matching a glob pattern within a stash.",
        inputSchema: {
          type: "object" as const,
          properties: {
            stash: { type: "string", description: "Stash name" },
            pattern: {
              type: "string",
              description: 'Glob pattern (e.g., "**/*.md")',
            },
          },
          required: ["stash", "pattern"],
        },
      },
      {
        name: "stash_read",
        description: "Read file content from a stash.",
        inputSchema: {
          type: "object" as const,
          properties: {
            stash: { type: "string", description: "Stash name" },
            path: { type: "string", description: "File path within stash" },
          },
          required: ["stash", "path"],
        },
      },
      {
        name: "stash_write",
        description:
          "Write or update a file. Provide content for full replacement or patch for partial edit.",
        inputSchema: {
          type: "object" as const,
          properties: {
            stash: { type: "string", description: "Stash name" },
            path: { type: "string", description: "File path within stash" },
            content: {
              type: "string",
              description: "Full content (creates file if new)",
            },
            patch: {
              type: "object",
              description: "Partial edit (file must exist)",
              properties: {
                start: { type: "number" },
                end: { type: "number" },
                text: { type: "string" },
              },
              required: ["start", "end", "text"],
            },
          },
          required: ["stash", "path"],
        },
      },
      {
        name: "stash_delete",
        description: "Delete a file from a stash.",
        inputSchema: {
          type: "object" as const,
          properties: {
            stash: { type: "string", description: "Stash name" },
            path: { type: "string", description: "File path within stash" },
          },
          required: ["stash", "path"],
        },
      },
      {
        name: "stash_move",
        description:
          "Move or rename a file within a stash. Preserves document identity.",
        inputSchema: {
          type: "object" as const,
          properties: {
            stash: { type: "string", description: "Stash name" },
            from: { type: "string", description: "Source file path" },
            to: { type: "string", description: "Destination file path" },
          },
          required: ["stash", "from", "to"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Reload to pick up external changes (throttled to avoid redundant disk reads)
    await manager.reloadIfStale();

    switch (name) {
      case "stash_list":
        return handleList(manager, args);
      case "stash_glob":
        return handleGlob(manager, args);
      case "stash_read":
        return handleRead(manager, args);
      case "stash_write":
        return handleWrite(manager, args);
      case "stash_delete":
        return handleDelete(manager, args);
      case "stash_move":
        return handleMove(manager, args);
      default:
        return errorResponse(`Unknown tool: ${name}`);
    }
  });

  return server;
}

function errorResponse(error: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error }) }],
  };
}

function jsonResponse(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

function handleList(
  manager: StashManager,
  args: Record<string, unknown> | undefined,
) {
  const stashName = args?.stash as string | undefined;
  const path = args?.path as string | undefined;

  if (!stashName) {
    // List stashes
    return jsonResponse({ items: manager.list() });
  }

  const stash = manager.get(stashName);
  if (!stash) return errorResponse(`Stash not found: ${stashName}`);

  const items = stash.list(path || undefined);
  return jsonResponse({ items });
}

function handleGlob(
  manager: StashManager,
  args: Record<string, unknown> | undefined,
) {
  const stashName = args?.stash as string;
  const pattern = args?.pattern as string;

  if (!stashName || !pattern) {
    return errorResponse("stash and pattern are required");
  }

  const stash = manager.get(stashName);
  if (!stash) return errorResponse(`Stash not found: ${stashName}`);

  const files = stash.glob(pattern);
  return jsonResponse({ files });
}

function handleRead(
  manager: StashManager,
  args: Record<string, unknown> | undefined,
) {
  const stashName = args?.stash as string;
  const path = args?.path as string;

  if (!stashName || !path) {
    return errorResponse("stash and path are required");
  }

  const stash = manager.get(stashName);
  if (!stash) return errorResponse(`Stash not found: ${stashName}`);

  try {
    const content = stash.read(path);
    return jsonResponse({ content });
  } catch (err) {
    return errorResponse(`File not found: ${path}`);
  }
}

function handleWrite(
  manager: StashManager,
  args: Record<string, unknown> | undefined,
) {
  const stashName = args?.stash as string;
  const path = args?.path as string;
  const content = args?.content as string | undefined;
  const patch = args?.patch as
    | { start: number; end: number; text: string }
    | undefined;

  if (!stashName || !path) {
    return errorResponse("stash and path are required");
  }
  if (content === undefined && !patch) {
    return errorResponse("Must provide content or patch");
  }

  const stash = manager.get(stashName);
  if (!stash) return errorResponse(`Stash not found: ${stashName}`);

  try {
    if (patch) {
      stash.patch(path, patch.start, patch.end, patch.text);
    } else {
      stash.write(path, content!);
    }
    // stash.write/patch triggers background save + debounced sync
    return jsonResponse({ success: true });
  } catch (err) {
    return errorResponse((err as Error).message);
  }
}

function handleDelete(
  manager: StashManager,
  args: Record<string, unknown> | undefined,
) {
  const stashName = args?.stash as string;
  const path = args?.path as string;

  if (!stashName || !path) {
    return errorResponse("stash and path are required");
  }

  const stash = manager.get(stashName);
  if (!stash) return errorResponse(`Stash not found: ${stashName}`);

  try {
    stash.delete(path);
    // stash.delete triggers background save + debounced sync
    return jsonResponse({ success: true });
  } catch (err) {
    return errorResponse((err as Error).message);
  }
}

function handleMove(
  manager: StashManager,
  args: Record<string, unknown> | undefined,
) {
  const stashName = args?.stash as string;
  const from = args?.from as string;
  const to = args?.to as string;

  if (!stashName || !from || !to) {
    return errorResponse("stash, from, and to are required");
  }

  const stash = manager.get(stashName);
  if (!stash) return errorResponse(`Stash not found: ${stashName}`);

  try {
    stash.move(from, to);
    // stash.move triggers background save + debounced sync
    return jsonResponse({ success: true });
  } catch (err) {
    return errorResponse((err as Error).message);
  }
}
