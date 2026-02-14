import { PORT } from "../../daemon.js";

export async function stopDaemon(): Promise<void> {
  try {
    const res = await fetch(`http://localhost:${PORT}/health`);
    if (!res.ok) {
      console.log("Daemon is not running.");
      return;
    }
  } catch {
    console.log("Daemon is not running.");
    return;
  }

  // Send shutdown signal via the health endpoint approach
  // Since we don't have a proper shutdown endpoint, find and kill the process
  try {
    const { execSync } = await import("node:child_process");
    const result = execSync(
      `lsof -ti :${PORT} 2>/dev/null || true`,
    ).toString().trim();
    if (result) {
      for (const pid of result.split("\n")) {
        process.kill(parseInt(pid, 10), "SIGTERM");
      }
      console.log("Daemon stopped.");
    }
  } catch {
    console.error("Failed to stop daemon.");
  }
}
