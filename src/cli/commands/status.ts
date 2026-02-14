import { StashManager } from "../../core/manager.js";
import { PORT } from "../../daemon.js";

export async function showStatus(baseDir?: string): Promise<void> {
  // Check daemon
  let daemonRunning = false;
  try {
    const res = await fetch(`http://localhost:${PORT}/health`);
    daemonRunning = res.ok;
  } catch {
    daemonRunning = false;
  }

  console.log(`Daemon: ${daemonRunning ? "running" : "stopped"}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log();

  const manager = await StashManager.load(baseDir);
  const stashes = manager.list();

  if (stashes.length === 0) {
    console.log("No stashes.");
    return;
  }

  console.log("Stashes:");
  for (const name of stashes) {
    const stash = manager.get(name)!;
    const meta = stash.getMeta();
    const files = stash.glob("**/*");
    const suffix = meta.key ? ` → ${meta.key}` : " (local)";
    console.log(`  ${name}${suffix} (${files.length} files)`);
  }
}
