# StashManager

Orchestrates multiple stashes. Source: `core/manager.ts`, `core/config.ts`. Loads from global config (`~/.stash/config.json`); see [index](./index.md) for `GlobalConfig` and helpers.

**Responsibility**: The manager is **solely responsible for stashes** (local): creation, deletion, registration, loading. When an operation has a remote aspect, the manager does the local work, then **passes through** to the provider if it implements the remote part: e.g. delete with remote → `if (provider.delete) await provider.delete()`, then local deletion; create with remote → ensure remote exists via `provider.create?()` when appropriate, then local creation. The provider is solely responsible for the remote; see [provider](./provider.md).

## Role

- **Loading**: `StashManager.load(baseDir?)` reads config, loads each registered stash via `Stash.load`, attaches provider where `meta.remote` is set. If a registered stash path is missing (`ENOENT`), it is treated as stale registration: manager removes it from config and notifies the user. Other load failures are warned and skipped. Default baseDir: `~/.stash/`.
- **Operations**: get, list, create, connect, delete, sync, reload, reloadIfStale. Create/connect validate name and path; create can import existing files from disk; connect pulls from remote. Delete: if deleteRemote and provider implements `delete?()`, calls it then removes local stash; otherwise removes local only. `reloadIfStale()` (used by MCP) reloads only if >2s since last reload. API detail: see `StashManager` in `core/manager.ts`.

## API

| Method | Behavior |
|--------|----------|
| `static load(baseDir?)` | Read config, load each registered stash, attach provider from meta.remote. Remove stale registrations (ENOENT). Default baseDir: `~/.stash/`. |
| `get(name)` | Return stash or undefined. |
| `list()` | Sorted stash names. |
| `create(name, path?, provider?, remote?, description?)` | Validate name, create stash, import existing files if path exists, save, register. |
| `connect(remote, name, provider, path?, description?)` | Validate name, create stash, sync (pull), register. |
| `delete(name, deleteRemote?)` | If deleteRemote and provider.delete, call it; then remove local stash and unregister. |
| `sync()` | Sync all stashes; throws AggregateError on partial failure. |
| `reload()` | Reload config and all stashes. |
| `reloadIfStale()` | Reload only if >2s since last reload (used by MCP). |

## Invariants

- **Name validation**: Stash names must be non-empty, ≤64 chars, start with letter/number, contain only `[a-zA-Z0-9._-]` (pattern `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`). Rejects path traversal, hidden names, spaces. Applied on create and connect.
- **File import**: When create targets an existing directory, files are imported: skip `.stash/` and hidden files and symlinks; text (UTF-8) via `stash.write()`, binary via hash + blob + `stash.writeBinary()`. See `importExistingFiles` in `core/manager.ts`.
