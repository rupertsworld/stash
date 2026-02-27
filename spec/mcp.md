# MCP Server

MCP tools for AI agents to work with stash files. Source: `mcp.ts`, `mcp-server.ts`. Transports: HTTP (via [daemon](./daemon.md)) and stdio (direct run of `mcp-server.ts`).

## Design

- **Reload**: Before each tool, `manager.reloadIfStale()` so external changes (e.g. CLI) are visible.
- **Filesystem-first**: Tools read/write the filesystem; the reconciler syncs changes into Automerge. Same path as user edits.

## Tools

All tools return JSON in MCP text content; errors as `{ error: message }`.

| Tool | Params | Returns | Behavior |
|------|--------|--------|----------|
| `stash_list` | `stash?`, `path?` | `{ stashes }` or `{ items }` | No stash: list all stashes (name, description, path). With stash: list files at path (root if omitted). |
| `stash_glob` | `stash`, `glob` | `{ files }` | Paths matching minimatch pattern. |
| `stash_read` | `stash`, `path` | `{ content }` | File content (UTF-8). |
| `stash_write` | `stash`, `path`, `content` | `{ success }` | Full content replacement; creates if missing. |
| `stash_edit` | `stash`, `path`, `old_string`, `new_string` | `{ success }` | Find/replace; `old_string` must be unique. |
| `stash_delete` | `stash`, `path` or `glob` | `{ success }` or `{ success, deleted }` | Single path or glob; path and glob mutually exclusive. |
| `stash_move` | `stash`, `from`, `to` | `{ success }` | Rename/move; reconciler detects rename. |
| `stash_grep` | `stash`, `pattern`, `glob?` | `{ matches }` | Regex search; `matches`: `[{ path, line, content }]`. |

Tools read/write the filesystem; reconciler syncs into Automerge. Same path as user edits.
