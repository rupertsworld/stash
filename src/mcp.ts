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
          "List stashes or immediate children within a path. No path = list stashes. 'stash:' = list root. 'stash:dir/' = list in dir.",
        inputSchema: {
          type: "object" as const,
          properties: {
            path: {
              type: "string",
              description:
                'Empty = list stashes. "stash:" = list root. "stash:dir/" = list in dir.',
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
            path: {
              type: "string",
              description: '"stash-name:filepath"',
            },
          },
          required: ["path"],
        },
      },
      {
        name: "stash_write",
        description:
          "Write or update a file. Provide content for full replacement or patch for partial edit.",
        inputSchema: {
          type: "object" as const,
          properties: {
            path: {
              type: "string",
              description: '"stash-name:filepath"',
            },
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
          required: ["path"],
        },
      },
      {
        name: "stash_delete",
        description: "Delete a file from a stash.",
        inputSchema: {
          type: "object" as const,
          properties: {
            path: {
              type: "string",
              description: '"stash-name:filepath"',
            },
          },
          required: ["path"],
        },
      },
      {
        name: "stash_move",
        description:
          "Move or rename a file within a stash. Preserves document identity.",
        inputSchema: {
          type: "object" as const,
          properties: {
            from: {
              type: "string",
              description: '"stash-name:filepath"',
            },
            to: {
              type: "string",
              description: '"stash-name:filepath" (must be same stash)',
            },
          },
          required: ["from", "to"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Reload to pick up external changes before each operation
    await manager.reload();

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

function parsePath(path: string): { stash: string; filePath: string } | null {
  const colonIndex = path.indexOf(":");
  if (colonIndex === -1) return null;
  return {
    stash: path.slice(0, colonIndex),
    filePath: path.slice(colonIndex + 1),
  };
}

async function handleList(
  manager: StashManager,
  args: Record<string, unknown> | undefined,
) {
  const path = args?.path as string | undefined;

  if (!path) {
    // List stashes
    return jsonResponse({ items: manager.list() });
  }

  const parsed = parsePath(path);
  if (!parsed) return errorResponse(`Invalid path format: ${path}`);

  const stash = manager.get(parsed.stash);
  if (!stash) return errorResponse(`Stash not found: ${parsed.stash}`);

  // Sync before reading to get latest remote state
  await stash.sync();

  const items = stash.list(parsed.filePath || undefined);
  return jsonResponse({ items });
}

async function handleGlob(
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

  // Sync before reading to get latest remote state
  await stash.sync();

  const files = stash.glob(pattern);
  return jsonResponse({ files });
}

async function handleRead(
  manager: StashManager,
  args: Record<string, unknown> | undefined,
) {
  const path = args?.path as string;
  if (!path) return errorResponse("path is required");

  const parsed = parsePath(path);
  if (!parsed) return errorResponse(`Invalid path format: ${path}`);

  const stash = manager.get(parsed.stash);
  if (!stash) return errorResponse(`Stash not found: ${parsed.stash}`);

  // Sync before reading to get latest remote state
  await stash.sync();

  try {
    const content = stash.read(parsed.filePath);
    return jsonResponse({ content });
  } catch (err) {
    return errorResponse(`File not found: ${parsed.filePath}`);
  }
}

async function handleWrite(
  manager: StashManager,
  args: Record<string, unknown> | undefined,
) {
  const path = args?.path as string;
  const content = args?.content as string | undefined;
  const patch = args?.patch as
    | { start: number; end: number; text: string }
    | undefined;

  if (!path) return errorResponse("path is required");
  if (content === undefined && !patch) {
    return errorResponse("Must provide content or patch");
  }

  const parsed = parsePath(path);
  if (!parsed) return errorResponse(`Invalid path format: ${path}`);

  const stash = manager.get(parsed.stash);
  if (!stash) return errorResponse(`Stash not found: ${parsed.stash}`);

  // Sync before writing to merge with remote state
  await stash.sync();

  try {
    if (patch) {
      stash.patch(parsed.filePath, patch.start, patch.end, patch.text);
    } else {
      stash.write(parsed.filePath, content!);
    }
    // Sync after writing to push changes
    await stash.sync();
    return jsonResponse({ success: true });
  } catch (err) {
    return errorResponse((err as Error).message);
  }
}

async function handleDelete(
  manager: StashManager,
  args: Record<string, unknown> | undefined,
) {
  const path = args?.path as string;
  if (!path) return errorResponse("path is required");

  const parsed = parsePath(path);
  if (!parsed) return errorResponse(`Invalid path format: ${path}`);

  const stash = manager.get(parsed.stash);
  if (!stash) return errorResponse(`Stash not found: ${parsed.stash}`);

  // Sync before deleting to merge with remote state
  await stash.sync();

  try {
    stash.delete(parsed.filePath);
    // Sync after deleting to push changes
    await stash.sync();
    return jsonResponse({ success: true });
  } catch (err) {
    return errorResponse((err as Error).message);
  }
}

async function handleMove(
  manager: StashManager,
  args: Record<string, unknown> | undefined,
) {
  const from = args?.from as string;
  const to = args?.to as string;

  if (!from || !to) return errorResponse("from and to are required");

  const parsedFrom = parsePath(from);
  const parsedTo = parsePath(to);
  if (!parsedFrom) return errorResponse(`Invalid path format: ${from}`);
  if (!parsedTo) return errorResponse(`Invalid path format: ${to}`);
  if (parsedFrom.stash !== parsedTo.stash) {
    return errorResponse("Cross-stash moves not supported");
  }

  const stash = manager.get(parsedFrom.stash);
  if (!stash) return errorResponse(`Stash not found: ${parsedFrom.stash}`);

  // Sync before moving to merge with remote state
  await stash.sync();

  try {
    stash.move(parsedFrom.filePath, parsedTo.filePath);
    // Sync after moving to push changes
    await stash.sync();
    return jsonResponse({ success: true });
  } catch (err) {
    return errorResponse((err as Error).message);
  }
}
