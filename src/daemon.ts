/**
 * Background daemon for syncing and MCP server.
 * Uses StashReconciler for file watching and automatic sync.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp.js";
import { StashManager } from "./core/manager.js";
import { StashReconciler } from "./core/reconciler.js";
import { DEFAULT_STASH_DIR } from "./core/config.js";
import type { Stash } from "./core/stash.js";

export const PORT = 32847;
const SYNC_INTERVAL_MS = 30_000;

export function pidFilePath(baseDir: string = DEFAULT_STASH_DIR): string {
  return path.join(baseDir, "daemon.pid");
}

async function writePidFile(baseDir: string): Promise<void> {
  await fs.writeFile(pidFilePath(baseDir), String(process.pid), { mode: 0o600 });
}

async function removePidFile(baseDir: string): Promise<void> {
  try {
    await fs.unlink(pidFilePath(baseDir));
  } catch {
    // Ignore if already removed
  }
}

export async function startDaemon(
  baseDir: string = DEFAULT_STASH_DIR,
): Promise<void> {
  const manager = await StashManager.load(baseDir);

  // Write PID file for stop command
  await writePidFile(baseDir);

  const reconcilers = new Map<string, StashReconciler>();

  // Start reconcilers for all stashes
  for (const name of manager.list()) {
    const stash = manager.get(name);
    if (stash) {
      const reconciler = new StashReconciler(stash);
      await reconciler.start();
      await reconciler.scan();  // Import existing files from disk
      reconcilers.set(name, reconciler);
    }
  }

  const app = express();
  app.use(express.json());

  // MCP endpoint - create fresh server per request to avoid race conditions
  app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless
    });
    // Create fresh MCP server for this request (avoids transport race on concurrent requests)
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

  // Periodic sync as fallback
  setInterval(async () => {
    try {
      await manager.sync();
      // Flush reconcilers after sync to write remote changes to disk
      for (const [name, reconciler] of reconcilers) {
        try {
          await reconciler.flush();
        } catch (err) {
          console.error(
            `Flush error (${name}):`,
            (err as Error).message,
          );
        }
      }
    } catch (err) {
      console.error("Sync error:", (err as Error).message);
    }
  }, SYNC_INTERVAL_MS);

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    for (const reconciler of reconcilers.values()) {
      await reconciler.close();
    }
    reconcilers.clear();
    await removePidFile(baseDir);
    process.exit(0);
  });
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
