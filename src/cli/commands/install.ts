import * as fs from "node:fs/promises";
import * as path from "node:path";

export async function install(): Promise<void> {
  // Find the path to the mcp-server.js
  const mcpServerPath = path.resolve(
    import.meta.dirname,
    "../../mcp-server.js",
  );

  const mcpConfig = {
    mcpServers: {
      stash: {
        command: "node",
        args: [mcpServerPath],
      },
    },
  };

  // Output the config for the user to add
  console.log("Add this to your MCP client configuration:\n");
  console.log(JSON.stringify(mcpConfig, null, 2));
  console.log("\nFor Claude Code, run: claude mcp add stash node " + mcpServerPath);
}
