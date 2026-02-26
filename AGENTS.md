# Stash — Agent guide

This repo is a **local-first collaborative folder service**: multiple editors (humans and AI) read/write the same files with conflict-free merging via Automerge CRDTs, optional sync to GitHub, and MCP tools for agents.

**Before making changes:** Read the full spec first — `spec/index.md` and the module specs in `spec/` — so you understand architecture, data model, and conventions.

## How to navigate

- **High-level design and invariants**: Read `spec/index.md` and the module specs in `spec/`. They describe what each part does and key rules (data model, atomic writes, name validation, etc.). They are kept high-level, with examples and interfaces only when required for clarity.
- **API and implementation detail**: The code is the source of truth. Use TypeScript types and JSDoc in `src/` for method signatures, options, and edge cases. When a spec says "see … in src/…", look there for the authoritative behavior.

## Entry points

| Entry | File | Purpose |
|-------|------|---------|
| CLI | `src/cli.ts` | All `stash` subcommands; delegates to `cli/commands/*.ts`. |
| Daemon | `src/daemon.ts` | Background process: reconcilers, HTTP server (port 32847), periodic sync. |
| MCP (stdio) | `src/mcp-server.ts` | Standalone MCP server over stdio for AI clients. |

## Source layout

- **`src/core/`** — Stash (`stash.ts`), structure/file CRDT helpers (`structure.ts`, `file.ts`), manager (`manager.ts`), config (`config.ts`), reconciler (`reconciler.ts`), errors (`errors.ts`).
- **`src/providers/`** — Sync provider interface (`types.ts`), GitHub implementation (`github.ts`).
- **`src/cli/`** — Commander setup, options, prompts, one file per command (create, connect, list, edit, delete, sync, status, start, stop, auth, etc.).
- **`src/daemon.ts`** — Loads manager, starts reconcilers, Express with POST /mcp and GET /health, periodic sync, SIGTERM shutdown.
- **`src/mcp.ts`** — MCP server and tools (stash_list, stash_read, stash_write, stash_edit, stash_delete, stash_glob, stash_move, stash_grep). Tools use the filesystem; reconciler syncs into Automerge.
- **`src/mcp-server.ts`** — Stdio entry: load manager, create MCP server, connect StdioServerTransport.

Tests live in `test/` (structure, file, stash, manager, config, reconciler, providers, daemon, mcp, cli). Run: `npm test`.

Conventions (atomic writes, UTF-8 detection, paths, security, etc.) are in **`spec/index.md`** under “Shared Conventions”. When changing behavior, update the code and JSDoc first; only touch the spec if the *role* or *invariants* of a module change.
