import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp.js";
import { StashManager } from "./core/manager.js";

export const PORT = 32847;
const SYNC_INTERVAL_MS = 30_000;

export async function startDaemon(baseDir?: string): Promise<void> {
  const manager = await StashManager.load(baseDir);
  const mcpServer = createMcpServer(manager);

  const app = express();
  app.use(express.json());

  // MCP endpoint
  app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless
    });
    res.on("close", () => transport.close());
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.listen(PORT, () => {
    console.log(`Stash daemon listening on http://localhost:${PORT}`);
  });

  // Sync loop
  setInterval(async () => {
    try {
      await manager.sync();
    } catch (err) {
      console.error("Sync error:", (err as Error).message);
    }
  }, SYNC_INTERVAL_MS);
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
