# Stash System Specification

## 1. Overview

Stash is a local-first collaborative folder service. It enables multiple editors (humans and AI agents) to read and write to the same set of files simultaneously, with all changes merging automatically and without conflicts.

The core insight is that traditional file-sharing approaches (Git, Dropbox, SyncThing) either require manual conflict resolution, impose sequential workflows, or silently overwrite changes. Stash eliminates these problems by storing every file as a CRDT (Conflict-free Replicated Data Type) using the Automerge library, guaranteeing that concurrent edits always converge to a consistent state.

Changes are persisted locally first, then synced to a remote provider (currently GitHub) in the background. The system works fully offline and syncs when connectivity is available.

### 1.1 Design Principles

- **Local-first**: All data is available on disk. No network required for reads or writes.
- **Conflict-free**: Automerge CRDTs merge concurrent edits deterministically. No manual conflict resolution.
- **Background sync**: Sync happens automatically. No explicit pull/push workflow.
- **Agent-native**: First-class MCP (Model Context Protocol) interface for AI agents alongside a human CLI.
- **Provider-agnostic**: Sync backends are pluggable via a simple interface.

### 1.2 Technology Stack

| Component        | Technology                          |
| ---------------- | ----------------------------------- |
| Language         | TypeScript (ES2022 target)          |
| Runtime          | Node.js 18+                        |
| Module system    | ES Modules (`"type": "module"`)     |
| CRDT library     | Automerge 2.2.8                     |
| CLI framework    | Commander.js 12                     |
| MCP framework    | @modelcontextprotocol/sdk 1.12.1    |
| HTTP server      | Express 4.21                        |
| GitHub API       | Octokit 4.1                         |
| Glob matching    | minimatch 10                        |
| ID generation    | ULID 2.3                            |
| Build            | TypeScript compiler (`tsc`)         |
| Tests            | Vitest 2.1                          |

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Interface Layer                        │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  CLI          │  │  MCP (stdio) │  │  MCP (HTTP)   │  │
│  │  commander.js │  │  mcp-server  │  │  daemon       │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘  │
└─────────┼─────────────────┼──────────────────┼───────────┘
          │                 │                  │
          ▼                 ▼                  ▼
┌──────────────────────────────────────────────────────────┐
│                   Manager Layer                           │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  StashManager                                      │  │
│  │  - Loads/creates/deletes stashes                   │  │
│  │  - Coordinates sync across all stashes             │  │
│  │  - Restores providers from persisted metadata      │  │
│  └──────────────────────┬─────────────────────────────┘  │
│                         │                                 │
│  ┌──────────────────────▼─────────────────────────────┐  │
│  │  Stash (one per stash)                             │  │
│  │  - Owns StructureDoc + FileDoc map                 │  │
│  │  - File CRUD operations (read/write/patch/delete)  │  │
│  │  - Schedules background save + debounced sync      │  │
│  └──────────────────────┬─────────────────────────────┘  │
└─────────────────────────┼────────────────────────────────┘
                          │
┌─────────────────────────┼────────────────────────────────┐
│                  Document Layer (Automerge CRDTs)         │
│                                                          │
│  ┌──────────────────┐   ┌─────────────────────────────┐  │
│  │  StructureDoc    │   │  FileDoc (one per file)     │  │
│  │  {               │   │  {                          │  │
│  │    files: {      │   │    content: Automerge.Text  │  │
│  │      [path]:     │──▶│  }                          │  │
│  │        { docId,  │   │                             │  │
│  │          created }│   │  - Character-level CRDT     │  │
│  │    }             │   │  - Concurrent edits merge   │  │
│  │  }               │   │    deterministically        │  │
│  └──────────────────┘   └─────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────┼────────────────────────────────┐
│                   Provider Layer                          │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │  SyncProvider interface                          │    │
│  │  - sync(docs) → merged docs                     │    │
│  │  - exists() / create() / delete()               │    │
│  └──────────────────────┬───────────────────────────┘    │
│                         │                                 │
│  ┌──────────────────────▼───────────────────────────┐    │
│  │  GitHubProvider                                  │    │
│  │  - Stores .automerge binaries in GitHub repo     │    │
│  │  - Renders plain-text files alongside for        │    │
│  │    human readability on GitHub                   │    │
│  │  - Atomic commits via Git tree API               │    │
│  └──────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

---

## 3. Data Model

### 3.1 StructureDoc

The structure document is a single Automerge document per stash that acts as the file index. It maps file paths to document references.

```typescript
interface StructureDoc {
  files: { [path: string]: FileEntry };
}

interface FileEntry {
  docId: string;   // ULID referencing a FileDoc
  created: number; // Unix timestamp (ms)
}
```

**Operations**: `addFile`, `removeFile`, `moveFile`, `getEntry`, `listPaths`.

Paths are flat strings (e.g., `"docs/notes.md"`), not nested objects. Directory structure is derived at query time by splitting on `/`.

The `moveFile` operation preserves document identity: only the path key changes, the underlying `docId` stays the same, so CRDT history is preserved across renames.

### 3.2 FileDoc

Each file is a separate Automerge document containing a single `Text` CRDT field.

```typescript
interface FileDoc {
  content: Automerge.Text;
}
```

**Operations**:
- `createFileDoc(content?, actorId?)` - Initialize with optional content.
- `getContent(doc)` - Extract plain string.
- `setContent(doc, content)` - Replace entire content (deletes all characters, then inserts new ones).
- `applyPatch(doc, start, end, text)` - Character-range replacement. Deletes `end - start` characters at `start`, then inserts `text` at that position.

Storing each file as a separate Automerge document means syncing a single file change doesn't require transferring the entire stash's state.

### 3.3 StashMeta

Persisted metadata for each stash instance.

```typescript
interface StashMeta {
  localName: string;          // Human-readable name
  provider: string | null;    // Provider type identifier ("github" or null)
  key: string | null;         // Provider-specific location (e.g., "github:owner/repo")
  actorId: string;            // ULID used as Automerge actor ID basis
}
```

The `actorId` is a ULID converted to hex and padded to 64 characters to satisfy Automerge's actor ID format. Each stash instance has a unique actor, enabling Automerge to distinguish edits from different replicas.

### 3.4 StashConfig

Global application configuration.

```typescript
interface StashConfig {
  github?: {
    token: string;
  };
}
```

Stored at `~/.stash/config.json`. Contains credentials for sync providers.

---

## 4. On-Disk Layout

```
~/.stash/                              # Base directory (DEFAULT_STASH_DIR)
├── config.json                        # Global config (provider tokens)
│
├── <stash-name>/                      # One directory per stash
│   ├── meta.json                      # StashMeta (name, provider, key, actorId)
│   ├── structure.automerge            # StructureDoc (binary Automerge)
│   └── docs/                          # File documents
│       ├── <ULID-1>.automerge         # FileDoc (binary Automerge)
│       ├── <ULID-2>.automerge
│       └── ...
│
└── <another-stash>/
    ├── meta.json
    ├── structure.automerge
    └── docs/
        └── ...
```

All `.automerge` files are Automerge binary serializations (`Automerge.save()`). Writes use an atomic temp-file-then-rename pattern to prevent corruption from crashes.

When a file is deleted from a stash, its entry is removed from the structure document and its `FileDoc` is removed from memory, but the `.automerge` file on disk is left as an orphan. On load, only documents referenced by the current structure document are loaded; orphans are ignored.

---

## 5. Remote Layout (GitHub)

When synced to GitHub, the repository contains:

```
repo/
├── .stash/                            # Binary Automerge documents
│   ├── structure.automerge
│   └── docs/
│       ├── <ULID-1>.automerge
│       └── ...
│
├── file1.txt                          # Plain-text renderings (human-readable)
├── docs/
│   └── notes.md                       # Mirrors stash file structure
└── ...
```

The `.stash/` directory contains the authoritative CRDT data. The plain-text files at the repo root are rendered copies for human readability when browsing the repo on GitHub. They are regenerated on every push.

---

## 6. Core Operations

### 6.1 Stash Class

The `Stash` class is the central abstraction. It holds the in-memory state of a single stash and provides all file operations.

**File operations** (all synchronous except `sync` and `save`):

| Method                            | Behavior                                                                 |
| --------------------------------- | ------------------------------------------------------------------------ |
| `read(path)`                      | Returns file content as string. Throws if not found.                     |
| `write(path, content)`            | Creates or overwrites file. Triggers background save + debounced sync.   |
| `patch(path, start, end, text)`   | Character-range edit on existing file. Triggers background save + sync.  |
| `delete(path)`                    | Removes from structure, orphans FileDoc. Triggers background save + sync.|
| `move(from, to)`                  | Renames path in structure, preserving docId. Triggers save + sync.       |
| `list(dir?)`                      | Lists immediate children of a directory (files and subdirectories).      |
| `glob(pattern)`                   | Returns all paths matching a minimatch glob pattern.                     |

**Lifecycle**:

| Method                              | Behavior                                                            |
| ----------------------------------- | ------------------------------------------------------------------- |
| `Stash.create(name, baseDir, ...)`  | Creates a new stash with fresh StructureDoc and actor ID.           |
| `Stash.load(name, baseDir, ...)`    | Loads from disk. Reads meta.json, structure, and referenced docs.   |
| `save()`                            | Persists all state to disk using atomic writes.                     |
| `sync()`                            | Full sync cycle with provider (see section 7).                      |
| `flush()`                           | Waits for pending background saves to complete.                     |

### 6.2 StashManager

Manages the collection of stashes:

| Method                                  | Behavior                                                         |
| --------------------------------------- | ---------------------------------------------------------------- |
| `StashManager.load(baseDir?)`           | Scans baseDir for stash directories, loads each one.             |
| `get(name)`                             | Returns a Stash instance by name.                                |
| `list()`                                | Returns sorted list of stash names.                              |
| `create(name, provider?, type?, key?)`  | Creates new stash, saves to disk, registers in memory.           |
| `connect(key, localName, provider)`     | Creates empty stash, syncs to pull remote content.               |
| `delete(name, deleteRemote?)`           | Removes from disk and memory. Optionally deletes remote.         |
| `sync()`                                | Syncs all stashes. Collects errors into AggregateError.          |
| `reload()`                              | Re-scans disk and reloads all stashes (picks up external changes). |

On load, the manager restores providers from persisted metadata by reading each stash's `meta.json` and constructing the appropriate provider instance (e.g., `GitHubProvider` from a `github:owner/repo` key and the stored GitHub token).

---

## 7. Sync Protocol

### 7.1 Sync Flow

The sync process follows these steps:

1. **Pre-sync cleanup**: Create empty `FileDoc` for any dangling references in the structure (entries whose `docId` has no corresponding in-memory document).

2. **Serialize**: Convert all Automerge documents (structure + file docs) to binary (`Automerge.save()`), producing a `Map<string, Uint8Array>` where the key `"structure"` refers to the structure doc and all other keys are file doc ULIDs.

3. **Provider sync**: Hand the entire document map to the provider's `sync()` method. The provider:
   a. Fetches remote documents.
   b. Merges each local document with its remote counterpart using `Automerge.merge()`.
   c. Includes any remote-only documents not present locally.
   d. Tracks file deletions (paths in remote structure but not in merged structure).
   e. Pushes the merged state atomically.
   f. Returns the merged document map.

4. **Load merged state**: Replace in-memory structure and file documents with the merged versions. Only load file docs that are referenced by the merged structure (skip orphans).

5. **Persist**: Save merged state to disk.

### 7.2 Debounced Background Sync

Every mutating operation (`write`, `patch`, `delete`, `move`) calls `scheduleBackgroundSave()`, which:

1. **Chains a save**: Appends a `save()` call to a promise chain, ensuring saves execute sequentially and none are lost.
2. **Debounces sync**: Clears any pending sync timeout and sets a new one for 2 seconds in the future. This batches rapid edits into a single sync round-trip.
3. **Fire-and-forget**: Save and sync errors are caught and logged, not propagated to the caller. The mutating operation returns immediately.

### 7.3 Retry Logic

Sync operations use exponential backoff retry:

```
maxAttempts:      3
baseDelayMs:      1000
maxDelayMs:       30000
backoffMultiplier: 2
```

Delays: 1s, 2s, then fail. Non-retryable errors (authentication failures with HTTP 401/403) are thrown immediately without retry.

The `SyncError` class carries a `retryable` boolean and an optional `cause` error.

### 7.4 GitHub Provider Sync Details

**Fetch**: Uses the GitHub Contents API to read `.stash/structure.automerge` and list/read all files in `.stash/docs/`. Returns 404 gracefully for empty repos.

**Merge**: Uses `Automerge.merge()` on each document pair (local + remote). Documents that exist only on one side are included as-is.

**Push**: Uses the Git Data API for atomic commits:
1. Creates blobs for all Automerge binary files (base64-encoded).
2. Renders plain-text versions of all files for the repo root.
3. Marks deleted files with `sha: null` in the tree.
4. Creates a tree with `base_tree` for incremental updates.
5. Creates a commit pointing to the new tree.
6. Updates (or creates) the branch ref.

All repos are created as **private** by default.

---

## 8. Daemon

The daemon (`daemon.ts`) is a long-running background process that provides:

### 8.1 HTTP MCP Endpoint

An Express server on port **32847** with:

- `POST /mcp` - Stateless MCP endpoint using `StreamableHTTPServerTransport`. Each request creates a new transport, connects to the MCP server, handles the request, then closes.
- `GET /health` - Returns `{ "status": "ok" }`.

### 8.2 File Watcher

Uses `fs.watch()` with `{ recursive: true }` on the base stash directory. When a `.automerge` file changes:

1. Extracts the stash name from the first path component.
2. Skips if the stash is already syncing.
3. Debounces sync per stash (500ms window).
4. Triggers `stash.sync()` after the debounce period.

### 8.3 Periodic Sync

A fallback `setInterval` triggers `manager.sync()` every **30 seconds** to catch any changes missed by the file watcher.

### 8.4 Lifecycle

- **Start**: `stash start` spawns the daemon as a detached child process (`child.unref()`). Checks health endpoint first to avoid double-starting.
- **Stop**: `stash stop` finds the process listening on port 32847 using `lsof` and sends `SIGTERM`.

---

## 9. MCP Interface

The MCP server exposes 6 tools for AI agent interaction:

### 9.1 Tools

#### `stash_list`
List stashes or directory contents.

- **Input**: `{ stash?: string, path?: string }`
- **Behavior**:
  - No `stash` → returns list of all stash names.
  - With `stash`, no `path` → returns immediate children of root.
  - With `path` → returns immediate children of that directory.
- **Output**: `{ items: string[] }` (directories suffixed with `/`).

#### `stash_glob`
Find files matching a glob pattern.

- **Input**: `{ stash: string, pattern: string }` (both required)
- **Output**: `{ files: string[] }` sorted alphabetically.

#### `stash_read`
Read file content.

- **Input**: `{ stash: string, path: string }` (both required)
- **Output**: `{ content: string }`
- **Error**: If file not found.

#### `stash_write`
Create or update a file.

- **Input**: `{ stash: string, path: string, content?: string, patch?: { start: number, end: number, text: string } }`
- **Behavior**:
  - `content` provided → full file write (creates if new).
  - `patch` provided → character-range replacement on existing file.
  - Must provide exactly one of `content` or `patch`.
- **Output**: `{ success: true }`
- **Side effect**: Triggers background save and debounced sync.

#### `stash_delete`
Delete a file.

- **Input**: `{ stash: string, path: string }` (both required)
- **Output**: `{ success: true }`

#### `stash_move`
Move or rename a file, preserving CRDT document identity.

- **Input**: `{ stash: string, from: string, to: string }` (all required)
- **Output**: `{ success: true }`

### 9.2 Request Handling

Before every tool call, the MCP handler calls `manager.reload()` to pick up any external changes (e.g., from another process or the daemon). This ensures the MCP server always operates on the latest state.

### 9.3 Transport Modes

- **Stdio**: `mcp-server.ts` launches a `StdioServerTransport` for direct use by AI tools (e.g., `claude mcp add stash node dist/mcp-server.js`).
- **HTTP**: The daemon's `/mcp` endpoint uses `StreamableHTTPServerTransport` for remote or multi-client access.

---

## 10. CLI Interface

The CLI is the primary human interface, built with Commander.js.

### 10.1 Commands

| Command                       | Description                                         |
| ----------------------------- | --------------------------------------------------- |
| `stash auth github`           | Prompt for and save a GitHub personal access token.  |
| `stash create <name>`         | Create a new stash. Prompts for sync provider.       |
| `stash connect <key> --name`  | Connect to an existing remote stash and pull content.|
| `stash list`                  | List all local stashes with their provider keys.     |
| `stash delete <name>`         | Delete a stash. Optionally delete remote.            |
| `stash sync [name]`           | Manually trigger sync for one or all stashes.        |
| `stash status`                | Show daemon status and stash summary.                |
| `stash start`                 | Start the background daemon.                         |
| `stash stop`                  | Stop the background daemon.                          |
| `stash install`               | Print MCP client configuration JSON.                 |

### 10.2 Interactive Prompts

The CLI uses custom prompt utilities (`src/cli/prompts.ts`) built on Node's `readline/promises`:

- `prompt(question)` - Text input.
- `promptSecret(question)` - Text input (no masking in current implementation).
- `promptChoice(question, choices)` - Numbered choice selection.
- `confirm(question)` - Yes/No confirmation.

---

## 11. SyncProvider Interface

The provider interface is the extension point for adding new sync backends.

```typescript
interface SyncProvider {
  sync(docs: Map<string, Uint8Array>): Promise<Map<string, Uint8Array>>;
  exists(): Promise<boolean>;
  create(): Promise<void>;
  delete(): Promise<void>;
}
```

**Contract**:
- `sync()` receives all local documents as Automerge binaries. It must return a map containing all merged documents (local + remote + remote-only). The key `"structure"` identifies the structure document; all other keys are file document ULIDs.
- `exists()` checks whether the remote storage location exists.
- `create()` creates the remote storage location.
- `delete()` destroys the remote storage location.

The provider owns the merge strategy. Currently, `GitHubProvider` performs the merge internally using `Automerge.merge()`, meaning the merge logic lives in the provider rather than in the core `Stash` class.

---

## 12. Error Handling

### 12.1 SyncError

All sync-related failures are wrapped in `SyncError`, which carries:
- `message` - Human-readable description.
- `retryable` - Whether the operation should be retried.
- `cause` - Original error.

### 12.2 Error Propagation

- **MCP handlers**: Catch errors and return them as JSON error responses. Never throw.
- **CLI commands**: Catch errors, print to stderr, and `process.exit(1)`.
- **Background operations** (daemon, scheduled saves/syncs): Catch and log. Never crash the process.
- **StashManager.sync()**: Collects all per-stash errors and throws an `AggregateError`.

---

## 13. Testing

Tests use Vitest and cover:

| Test file                    | Coverage                                              |
| ---------------------------- | ----------------------------------------------------- |
| `test/core/structure.test.ts`| StructureDoc CRUD operations and path management.     |
| `test/core/file.test.ts`     | FileDoc creation, content replacement, patching.      |
| `test/core/stash.test.ts`    | Stash file operations, persistence, background save.  |
| `test/core/manager.test.ts`  | StashManager lifecycle, create/delete/list/connect.    |
| `test/core/config.test.ts`   | Configuration read/write, token management.           |
| `test/providers/github.test.ts` | GitHub provider sync, merge, push operations.      |
| `test/mcp.test.ts`           | MCP tool request handling and responses.              |

Tests use temporary directories and mock providers where needed. Vitest globals are enabled (`globals: true`).

---

## 14. Build and Development

### 14.1 Build

```bash
npm run build     # Runs tsc, outputs to dist/
```

TypeScript compiles `src/**/*` to `dist/` with ES2022 target, Node16 module resolution, strict mode, source maps, and declaration files.

### 14.2 Test

```bash
npm test          # Runs vitest once
npm run test:watch  # Runs vitest in watch mode
```

### 14.3 Install Globally

```bash
npm link          # Makes `stash` command available globally
```

The `bin.stash` entry in `package.json` points to `dist/cli.js`.

---

## 15. Security Considerations

- **GitHub tokens** are stored in plaintext in `~/.stash/config.json`. No encryption or keychain integration.
- **No MCP authentication**: The MCP server assumes the caller is authorized. The stdio transport is inherently local. The HTTP transport on port 32847 has no auth and is accessible to any local process.
- **Repos are created as private** by default on GitHub.
- **Secret input** in the CLI (`promptSecret`) does not actually mask terminal input.
