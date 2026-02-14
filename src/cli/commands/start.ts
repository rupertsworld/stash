import { spawn } from "node:child_process";
import * as path from "node:path";
import { PORT } from "../../daemon.js";

export async function startDaemon(): Promise<void> {
  // Check if already running
  try {
    const res = await fetch(`http://localhost:${PORT}/health`);
    if (res.ok) {
      console.log("Daemon is already running.");
      return;
    }
  } catch {
    // Not running, proceed
  }

  // Spawn daemon in background
  const daemonPath = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "..",
    "daemon.js",
  );

  const child = spawn("node", [daemonPath], {
    detached: true,
    stdio: "ignore",
  });

  child.unref();
  console.log(`Daemon started (PID: ${child.pid}).`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
}
