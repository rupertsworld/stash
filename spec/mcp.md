# MCP Server

MCP tools for AI agents to work with stash files. Source: `mcp.ts`, `mcp-server.ts`. Transports: HTTP (via [daemon](./daemon.md)) and stdio (direct run of `mcp-server.ts`).

## Design

- **Reload**: Before each tool, `manager.reloadIfStale()` so external changes (e.g. CLI) are visible.
- **Filesystem-first**: Tools read/write the filesystem; the reconciler syncs changes into Automerge. Same path as user edits.

## Tools

`stash_list` — list stashes or directory contents. `stash_glob` — paths matching a glob. `stash_read` / `stash_write` — file content (full read/write). `stash_edit` — find/replace by unique old string. `stash_delete` — single path or glob. `stash_move` — rename/move. `stash_grep` — regex search over file contents.

All return JSON in MCP text content; errors as `{ error: message }`. Parameter and behavior detail: see tool implementations in `mcp.ts`.
