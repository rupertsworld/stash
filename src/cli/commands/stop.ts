import * as fs from "node:fs/promises";
import { PORT, pidFilePath } from "../../daemon.js";
import { DEFAULT_STASH_DIR } from "../../core/config.js";

export async function stopDaemon(baseDir: string = DEFAULT_STASH_DIR): Promise<void> {
  const pidFile = pidFilePath(baseDir);

  // Try to read PID from file
  let pid: number | null = null;
  try {
    const content = await fs.readFile(pidFile, "utf-8");
    pid = parseInt(content.trim(), 10);
  } catch {
    // PID file doesn't exist
  }

  if (pid) {
    // Check if process is actually running
    try {
      process.kill(pid, 0); // Signal 0 = check if process exists
      process.kill(pid, "SIGTERM");
      console.log("Daemon stopped.");
      // Clean up stale PID file
      await fs.unlink(pidFile).catch(() => {});
      return;
    } catch {
      // Process not running, clean up stale PID file
      await fs.unlink(pidFile).catch(() => {});
    }
  }

  // Fallback: check health endpoint
  try {
    const res = await fetch(`http://localhost:${PORT}/health`);
    if (res.ok) {
      console.log("Daemon running but no PID file. Try 'lsof -ti :32847' to find process.");
      return;
    }
  } catch {
    // Not running
  }

  console.log("Daemon is not running.");
}
