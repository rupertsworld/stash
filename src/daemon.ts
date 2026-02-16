/**
 * Background daemon for syncing and MCP server.
 * Watches for local changes and syncs automatically.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp.js";
import { StashManager } from "./core/manager.js";
import { DEFAULT_STASH_DIR } from "./core/config.js";

export const PORT = 32847;
const SYNC_INTERVAL_MS = 30_000;
const WATCH_DEBOUNCE_MS = 500;

export async function startDaemon(baseDir: string = DEFAULT_STASH_DIR): Promise<void> {
  const manager = await StashManager.load(baseDir);

  // Write PID file for clean shutdown
  const pidFile = path.join(baseDir, "daemon.pid");
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid));

  const cleanup = () => {
    try { fs.unlinkSync(pidFile); } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);

  const app = express();
  app.use(express.json());

  // MCP endpoint -- fresh server per request to avoid transport conflicts
  app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless
    });
    const requestServer = createMcpServer(manager);
    res.on("close", () => transport.close());
    await requestServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.listen(PORT, () => {
    console.log(`Stash daemon listening on http://localhost:${PORT}`);
  });

  // Watch for file changes
  setupFileWatcher(baseDir, manager);

  // Periodic sync as fallback
  setInterval(async () => {
    try {
      await manager.sync();
    } catch (err) {
      console.error("Sync error:", (err as Error).message);
    }
  }, SYNC_INTERVAL_MS);
}

function setupFileWatcher(baseDir: string, manager: StashManager): void {
  const pendingSyncs = new Map<string, ReturnType<typeof setTimeout>>();

  // Watch the base directory for stash changes
  try {
    fs.watch(baseDir, { recursive: true }, (event, filename) => {
      if (!filename || !filename.endsWith(".automerge")) return;

      // Extract stash name from path (first directory component)
      const stashName = filename.split(path.sep)[0];
      if (!stashName) return;

      const stash = manager.get(stashName);
      if (!stash) return;

      // Skip if already syncing
      if (stash.isSyncing()) return;

      // Debounce syncs per stash
      const existingTimeout = pendingSyncs.get(stashName);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
      }

      pendingSyncs.set(
        stashName,
        setTimeout(async () => {
          pendingSyncs.delete(stashName);
          try {
            await stash.sync();
          } catch (err) {
            console.error(`Watch sync error (${stashName}):`, (err as Error).message);
          }
        }, WATCH_DEBOUNCE_MS)
      );
    });
    console.log(`Watching ${baseDir} for changes`);
  } catch (err) {
    console.warn(`Could not watch ${baseDir}:`, (err as Error).message);
  }
}

// Run as main
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("/daemon.js") ||
    process.argv[1].endsWith("/daemon.ts"));
if (isMain) {
  startDaemon().catch((err) => {
    console.error("Failed to start daemon:", err);
    process.exit(1);
  });
}
