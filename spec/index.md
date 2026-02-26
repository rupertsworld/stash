# Stash

A local-first collaborative folder service. Multiple editors (humans and AI agents) read/write the same files concurrently with automatic conflict-free merging via Automerge CRDTs. Background sync to GitHub. AI agents interact via MCP tools.

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Filesystem  │ ←→  │  Reconciler  │ ←→  │  Automerge   │
│  (user files)│     │  (chokidar + │     │  (CRDT state)│
└─────────────┘     │  fast-diff)  │     └──────┬───────┘
                    └─────────────┘            │
                                          ┌────┴────┐
                                          │ Provider │
                                          │ (GitHub) │
                                          └─────────┘
```

**Filesystem-first**: the filesystem is the source of truth. Users edit files normally with any editor, shell, or IDE. The reconciler watches for changes and syncs them into Automerge state. Remote sync pushes/pulls Automerge docs and renders user files.

**Key libraries**: `@automerge/automerge` for CRDTs, `chokidar` for file watching, `fast-diff` for text diffing, `commander` for CLI, `express` + `@modelcontextprotocol/sdk` for daemon/MCP, `octokit` for GitHub API, `ulid` for IDs, `minimatch` for glob matching.

**Spec maintenance**: Specs describe *what* each part does and key invariants; they stay high-level. The code (and its types/JSDoc) is the source of truth for API detail. When in doubt, document in code and reference the file from the spec.

**Provider APIs**: The SyncProvider interface (and any provider-facing API) must not be implementation-specific. It must be defined so that any provider (GitHub, S3, future backends, etc.) could implement it. No GitHub-only or other backend-specific methods or semantics in the interface.

**Manager vs provider**: The **StashManager** is solely responsible for stashes (local): creation, deletion, registration, loading. The **provider** is solely responsible for the remote: fetch, push, and (if implemented) optional `create?()` (ensure remote exists) and `delete?()` (destroy remote). When an operation has a remote aspect, the manager handles local state first, then **passes through** to the provider when the provider implements it — e.g. on delete with remote, manager calls `provider.delete?()` if present, then does local deletion; on create with remote, manager may call `provider.create?()` when appropriate so the remote exists before or after local creation.

## Components

| Spec | Source | Description |
|------|--------|-------------|
| [stash](./stash.md) | `core/stash.ts`, `core/structure.ts`, `core/file.ts` | CRDT state management, file operations, sync, conflict resolution |
| [manager](./manager.md) | `core/manager.ts`, `core/config.ts` | Multi-stash orchestration, global config, name validation |
| [reconciler](./reconciler.md) | `core/reconciler.ts` | Filesystem ↔ Automerge sync, file watching, diff/merge |
| [provider](./provider.md) | `providers/types.ts`, `providers/github.ts` | Sync provider interface, GitHub implementation |
| [daemon](./daemon.md) | `daemon.ts` | Background process, HTTP server, periodic sync |
| [mcp](./mcp.md) | `mcp.ts`, `mcp-server.ts` | MCP tools for AI agents, HTTP and stdio transports |
| [cli](./cli.md) | `cli.ts`, `cli/` | Command-line interface, interactive prompts |

## Data Model

### Global Config

Stored at `~/.stash/config.json`. Directory permissions `0o700`, file permissions `0o600`.

```typescript
interface GlobalConfig {
  actorId: string;                 // ULID, auto-generated on first run
  providers?: {
    github?: { token: string };    // GitHub PAT
  };
  stashes: Record<string, string>; // name → absolute path
}
```

On first access (`ensureConfig`), if the config file does not exist, create it with a fresh `actorId` (ULID) and empty `stashes`. If it exists but lacks `actorId` or `stashes`, backfill them and rewrite.

Config helpers:
- `ensureConfig(baseDir)` — read or create config, backfill missing fields.
- `readConfig(baseDir)` — alias for `ensureConfig`.
- `writeConfig(config, baseDir)` — write config to disk with `0o600` permissions.
- `getGitHubToken(baseDir)` — read token from config.
- `setGitHubToken(token, baseDir)` — write token to config.
- `registerStash(name, path, baseDir)` — add stash to config.
- `unregisterStash(name, baseDir)` — remove stash from config.

Default base directory: `~/.stash/` (`DEFAULT_STASH_DIR`).

### Stash Directory Layout

Each stash is a directory containing user files and a `.stash/` metadata folder:

```
<stash-root>/
├── .stash/
│   ├── meta.json              # StashMeta
│   ├── structure.automerge    # StructureDoc (Automerge binary)
│   ├── known-paths.json       # { paths: string[] }
│   ├── docs/                  # one .automerge file per tracked file
│   │   └── <ulid>.automerge
│   └── blobs/                 # binary file content, addressed by hash
│       └── <sha256>.bin
├── notes.md                   # user files live alongside .stash/
└── ...
```

### StashMeta

```typescript
interface StashMeta {
  name: string;
  description?: string;
  remote?: string | null;   // e.g. "github:owner/repo" or "github:owner/repo/folder"
}
```

### StructureDoc

An Automerge document tracking all files in the stash:

```typescript
interface StructureDoc {
  files: Record<string, FileEntry>;
}

interface FileEntry {
  docId: string;       // ULID referencing a file doc in docs/
  created: number;     // ms since epoch
  deleted?: boolean;   // tombstone flag
}
```

Operations:
- `createStructureDoc(actorId?)` — creates doc with empty `files` map.
- `addFile(doc, path, docId?)` — creates or resurrects an entry. Generates a ULID if `docId` not provided. Explicitly deletes the `deleted` flag to handle resurrection.
- `removeFile(doc, path)` — sets `deleted: true` (does not remove the entry).
- `moveFile(doc, from, to)` — copies `docId`+`created` to the new path and deletes the old key entirely (not a tombstone — the file identity moves).
- `getEntry(doc, path)` — returns the raw entry (may have `deleted: true`).
- `listPaths(doc)` — returns paths where `deleted` is not `true`.
- `listDeletedPaths(doc)` — returns paths where `deleted === true`.
- `isDeleted(doc, path)` — returns true if entry exists with `deleted === true`.

### FileDoc

Each tracked file has a corresponding Automerge document:

```typescript
interface TextFileDoc {
  type: "text";
  content: Automerge.Text;  // character-level CRDT
}

interface BinaryFileDoc {
  type: "binary";
  hash: string;   // SHA-256 hex of content
  size: number;   // byte count
}

type FileDoc = TextFileDoc | BinaryFileDoc;
```

Operations:
- `createFileDoc(content, actorId?)` — creates a `TextFileDoc` with `Automerge.Text`.
- `createBinaryFileDoc(hash, size, actorId?)` — creates a `BinaryFileDoc`.
- `getContent(doc)` — returns the text content string. Throws if doc is binary.
- `setContent(doc, content)` — replaces entire text content using `splice` for efficiency. Throws if binary.
- `applyPatch(doc, start, end, text)` — applies a positional patch via `splice`.

Binary file bytes are stored on disk in `.stash/blobs/<sha256>.bin`, not in Automerge.

### Actor IDs

Automerge requires hex actor IDs. The system stores a ULID in config, then converts to hex padded to 64 chars: `Buffer.from(actorId).toString("hex").padEnd(64, "0")`.

## Shared Conventions

### Filesystem-first

User files on disk are the source of truth. The reconciler watches disk and syncs into Automerge; MCP tools write to disk so the same path is used as for human edits.

### Atomic Writes

All file persistence uses atomic writes: write to a temp file (`<path>.<random>.tmp`) then `fs.rename` to target. Prevents corruption on crash.

### UTF-8 Detection

A buffer is considered text if `buffer.toString("utf-8")` does not contain the Unicode replacement character (`\uFFFD`). Otherwise it's binary.

### Hidden Files

All directory walks skip `.stash/` and files/directories starting with `.`. Symlinks are also skipped (`entry.isFile()` returns false for symlinks).

### Error Handling

```typescript
class SyncError extends Error {
  constructor(message: string, public readonly retryable: boolean, public readonly cause?: Error);
}
```

`withRetry(fn)` wraps async functions with exponential backoff:
- Max 3 attempts.
- Exponential backoff: 1s, 2s (base × 2^(attempt-1)), capped at 30s.
- Non-retryable `SyncError` fails immediately.
- Other errors retry until max attempts.

```typescript
const RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};
```

### Stash Names

Stash names must match `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` and be ≤64 characters. This rejects path traversal (`../foo`), hidden names (`.secret`), spaces, and special characters. Enforced in manager create/connect.

### Security

- Config directory `~/.stash/` created with `0o700`.
- Config file and PID file written with `0o600`. PID file at `~/.stash/daemon.pid`.
- GitHub token stored in config file (not environment variables).

### Empty Directory Cleanup

`removeEmptyParents(filePath, stopAt)` removes empty parent directories up to (but not including) `stopAt`, using `fs.rmdir` which fails on non-empty directories.

