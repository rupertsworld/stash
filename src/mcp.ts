import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
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
          "List stashes or directory contents. No stash = list all stashes with name, description, path. With stash = list files at path (or root if no path).",
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
            glob: {
              type: "string",
              description: 'Glob pattern (e.g., "**/*.md")',
            },
          },
          required: ["stash", "glob"],
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
        description: "Write file (full content replacement). Creates file if it doesn't exist.",
        inputSchema: {
          type: "object" as const,
          properties: {
            stash: { type: "string", description: "Stash name" },
            path: { type: "string", description: "File path within stash" },
            content: {
              type: "string",
              description: "Full file content",
            },
          },
          required: ["stash", "path", "content"],
        },
      },
      {
        name: "stash_edit",
        description:
          "Edit file with text replacement. old_string must be unique in the file.",
        inputSchema: {
          type: "object" as const,
          properties: {
            stash: { type: "string", description: "Stash name" },
            path: { type: "string", description: "File path within stash" },
            old_string: {
              type: "string",
              description: "Text to replace (must be unique in file)",
            },
            new_string: {
              type: "string",
              description: "Replacement text",
            },
          },
          required: ["stash", "path", "old_string", "new_string"],
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
      {
        name: "stash_grep",
        description: "Search file contents with regex pattern.",
        inputSchema: {
          type: "object" as const,
          properties: {
            stash: { type: "string", description: "Stash name" },
            pattern: {
              type: "string",
              description: "Regex pattern to search for",
            },
            glob: {
              type: "string",
              description: "Optional glob pattern to filter files",
            },
          },
          required: ["stash", "pattern"],
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
      case "stash_edit":
        return handleEdit(manager, args);
      case "stash_delete":
        return handleDelete(manager, args);
      case "stash_move":
        return handleMove(manager, args);
      case "stash_grep":
        return handleGrep(manager, args);
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
    // List all stashes with details
    const stashNames = manager.list();
    const stashes = stashNames.map((name) => {
      const stash = manager.get(name)!;
      const meta = stash.getMeta();
      return {
        name,
        description: meta.description,
        path: stash.path,
      };
    });
    return jsonResponse({ stashes });
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
  const pattern = (args?.glob ?? args?.pattern) as string;

  if (!stashName || !pattern) {
    return errorResponse("stash and glob are required");
  }

  const stash = manager.get(stashName);
  if (!stash) return errorResponse(`Stash not found: ${stashName}`);

  const files = stash.glob(pattern);
  return jsonResponse({ files });
}

async function handleRead(
  manager: StashManager,
  args: Record<string, unknown> | undefined,
) {
  const stashName = args?.stash as string;
  const filePath = args?.path as string;

  if (!stashName || !filePath) {
    return errorResponse("stash and path are required");
  }

  const stash = manager.get(stashName);
  if (!stash) return errorResponse(`Stash not found: ${stashName}`);

  // Read from filesystem
  const diskPath = nodePath.join(stash.path, filePath);
  try {
    const content = await fs.readFile(diskPath, "utf-8");
    return jsonResponse({ content });
  } catch {
    return errorResponse(`File not found: ${filePath}`);
  }
}

async function handleWrite(
  manager: StashManager,
  args: Record<string, unknown> | undefined,
) {
  const stashName = args?.stash as string;
  const filePath = args?.path as string;
  const content = args?.content as string | undefined;

  if (!stashName || !filePath) {
    return errorResponse("stash and path are required");
  }
  if (content === undefined) {
    return errorResponse("content is required");
  }

  const stash = manager.get(stashName);
  if (!stash) return errorResponse(`Stash not found: ${stashName}`);

  // Write to filesystem - reconciler will pick up the change
  const diskPath = nodePath.join(stash.path, filePath);
  try {
    await fs.mkdir(nodePath.dirname(diskPath), { recursive: true });
    await fs.writeFile(diskPath, content);
    return jsonResponse({ success: true });
  } catch (err) {
    return errorResponse((err as Error).message);
  }
}

async function handleEdit(
  manager: StashManager,
  args: Record<string, unknown> | undefined,
) {
  const stashName = args?.stash as string;
  const filePath = args?.path as string;
  const oldString = args?.old_string as string;
  const newString = args?.new_string as string;

  if (!stashName || !filePath || oldString === undefined || newString === undefined) {
    return errorResponse("stash, path, old_string, and new_string are required");
  }

  const stash = manager.get(stashName);
  if (!stash) return errorResponse(`Stash not found: ${stashName}`);

  const diskPath = nodePath.join(stash.path, filePath);
  try {
    const content = await fs.readFile(diskPath, "utf-8");

    // Check old_string exists and is unique
    const firstIndex = content.indexOf(oldString);
    if (firstIndex === -1) {
      return errorResponse(`old_string not found in file`);
    }
    const secondIndex = content.indexOf(oldString, firstIndex + 1);
    if (secondIndex !== -1) {
      return errorResponse(`old_string is not unique in file`);
    }

    const newContent = content.replace(oldString, newString);
    await fs.writeFile(diskPath, newContent);
    return jsonResponse({ success: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return errorResponse(`File not found: ${filePath}`);
    }
    return errorResponse((err as Error).message);
  }
}

async function handleDelete(
  manager: StashManager,
  args: Record<string, unknown> | undefined,
) {
  const stashName = args?.stash as string;
  const filePath = args?.path as string;

  if (!stashName || !filePath) {
    return errorResponse("stash and path are required");
  }

  const stash = manager.get(stashName);
  if (!stash) return errorResponse(`Stash not found: ${stashName}`);

  // Delete from filesystem - reconciler will pick up the change
  const diskPath = nodePath.join(stash.path, filePath);
  try {
    await fs.unlink(diskPath);
    return jsonResponse({ success: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return errorResponse(`File not found: ${filePath}`);
    }
    return errorResponse((err as Error).message);
  }
}

async function handleMove(
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

  // Move on filesystem - reconciler will detect rename
  const fromPath = nodePath.join(stash.path, from);
  const toPath = nodePath.join(stash.path, to);
  try {
    await fs.mkdir(nodePath.dirname(toPath), { recursive: true });
    await fs.rename(fromPath, toPath);
    return jsonResponse({ success: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return errorResponse(`File not found: ${from}`);
    }
    return errorResponse((err as Error).message);
  }
}

async function handleGrep(
  manager: StashManager,
  args: Record<string, unknown> | undefined,
) {
  const stashName = args?.stash as string;
  const pattern = args?.pattern as string;
  const globPattern = args?.glob as string | undefined;

  if (!stashName || !pattern) {
    return errorResponse("stash and pattern are required");
  }

  const stash = manager.get(stashName);
  if (!stash) return errorResponse(`Stash not found: ${stashName}`);

  let filePaths: string[];
  if (globPattern) {
    filePaths = stash.glob(globPattern);
  } else {
    filePaths = stash.glob("**/*");
  }

  const regex = new RegExp(pattern);
  const matches: Array<{ path: string; line: number; content: string }> = [];

  for (const filePath of filePaths) {
    const diskPath = nodePath.join(stash.path, filePath);
    try {
      const content = await fs.readFile(diskPath, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push({
            path: filePath,
            line: i + 1,
            content: lines[i],
          });
        }
      }
    } catch {
      // Skip files that can't be read (binary, etc.)
    }
  }

  return jsonResponse({ matches });
}
