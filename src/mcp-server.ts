#!/usr/bin/env node
/**
 * Stdio-based MCP server for Stash.
 * This is launched by Claude/AI assistants directly.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp.js";
import { StashManager } from "./core/manager.js";

async function main() {
  const manager = await StashManager.load();
  const server = createMcpServer(manager);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
