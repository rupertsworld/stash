import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_STASH_DIR } from "../../core/config.js";

export async function stopDaemon(): Promise<void> {
  const pidFile = path.join(DEFAULT_STASH_DIR, "daemon.pid");

  let pid: number;
  try {
    pid = parseInt(await fs.readFile(pidFile, "utf-8"), 10);
  } catch {
    console.log("Daemon is not running.");
    return;
  }

  // Verify process is actually alive (handles stale PID files from crashes)
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't kill
  } catch {
    await fs.unlink(pidFile).catch(() => {});
    console.log("Daemon is not running (cleaned up stale PID file).");
    return;
  }

  process.kill(pid, "SIGTERM");
  console.log("Daemon stopped.");
}
