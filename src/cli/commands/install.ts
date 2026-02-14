import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PORT } from "../../daemon.js";

export async function install(): Promise<void> {
  // Write MCP config for Claude Code
  const configDir = path.join(
    process.env.HOME ?? "~",
    ".config",
  );

  const mcpConfig = {
    mcpServers: {
      stash: {
        url: `http://localhost:${PORT}/mcp`,
      },
    },
  };

  // Output the config for the user to add
  console.log("Add this to your MCP client configuration:\n");
  console.log(JSON.stringify(mcpConfig, null, 2));
  console.log(
    "\nFor Claude Code, add to ~/.claude/claude_desktop_config.json",
  );
}
