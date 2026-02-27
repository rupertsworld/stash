# Daemon

Background process: file watching, periodic sync, MCP HTTP endpoint. Source: `daemon.ts`. Port: `32847`.

## Role

- **Startup**: Load StashManager, write PID file at `<baseDir>/daemon.pid`, for each stash create a StashReconciler, start it and run initial scan, then start Express on port and periodic sync loop.
- **HTTP**: `POST /mcp` — per-request MCP (fresh server + transport per request to avoid races). `GET /health` — `{ status: "ok" }` for daemon detection.
- **Periodic sync**: Every 30s, `manager.sync()` then each reconciler `flush()`. Errors logged, not thrown.
- **Shutdown**: SIGTERM closes reconcilers, removes PID file, exit 0. PID file is `0o600`, used by CLI `stash stop`.

Entry: run `daemon.ts` directly (detected via `argv[1]` ending with `daemon.js`/`daemon.ts`).
