# Stash System Specification

A local-first collaborative folder service with MCP interface and GitHub sync.

## Architecture Overview

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Filesystem │ ←→  │  Reconciler │ ←→  │  Automerge  │
│   (source   │     │  (watcher + │     │   (CRDT     │
│   of truth) │     │   diff/merge)│     │   state)    │
└─────────────┘     └─────────────┘     └─────────────┘
                                              ↓
                    ┌─────────────┐     ┌─────────────┐
                    │   GitHub    │ ←→  │   Provider  │
                    │   (remote)  │     │   (sync)    │
                    └─────────────┘     └─────────────┘
```

## Core Concepts

### Filesystem-First

The filesystem is the source of truth. Users edit files normally; the reconciler detects changes and updates Automerge state. This allows:

- Normal editor/IDE usage
- Git operations on stash folders
- Shell scripting with stash files

### Automerge CRDTs

Each file is backed by an Automerge document for conflict-free merging:

- **Text files**: Character-level CRDT (`Automerge.Text`)
- **Binary files**: Metadata only (hash + size), bytes stored as blobs

### Soft-Delete Tombstones

Deleted files are marked with `deleted: true` in the structure doc rather than removed. This enables:

- Proper conflict resolution during sync
- "Content wins" when local edits conflict with remote deletion
- Distinguishing "never existed" from "was deleted"

## Data Model

### Global Config (`~/.stash/config.json`)

```typescript
interface GlobalConfig {
  actorId: string;              // ULID for this machine
  providers?: {
    github?: { token: string }; // GitHub PAT
  };
  stashes: Record<string, string>; // name → absolute path
}
```

Permissions: 0o600 (file), 0o700 (directory)

### Stash Structure (`<stash>/.stash/`)

```
<stash>/
├── .stash/
│   ├── meta.json           # { name, description?, remote? }
│   ├── structure.automerge # Structure doc (file registry)
│   ├── known-paths.json    # Local-only tracking of seen files
│   ├── docs/               # File docs (one per file)
│   │   ├── <ulid>.automerge
│   │   └── ...
│   └── blobs/              # Binary file content
│       ├── <sha256>.bin
│       └── ...
├── file1.md                # User files
├── docs/
│   └── guide.md
└── ...
```

### Structure Document

```typescript
interface StructureDoc {
  files: Record<string, FileEntry>;
}

interface FileEntry {
  docId: string;      // ULID of file doc
  created: number;    // Timestamp (ms since epoch)
  deleted?: boolean;  // Soft-delete tombstone
}
```

### File Documents

```typescript
// Text files
interface TextFileDoc {
  type: "text";
  content: Automerge.Text;
}

// Binary files
interface BinaryFileDoc {
  type: "binary";
  hash: string;  // SHA-256
  size: number;
}
```

## Reconciler

The reconciler syncs filesystem ↔ Automerge state.

### File Watching

Uses chokidar with configuration:

- `ignoreInitial: true` - Don't fire events for existing files on start
- `awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }` - Wait for writes to complete
- Ignores `.stash/` directory and hidden files

Events:

- **add**: Create file doc, update structure (or detect rename)
- **change**: Compute diff, apply patches to CRDT
- **unlink**: Buffer for 500ms to detect renames, then create tombstone

### Rename Detection

Renames are detected by matching content hashes:

1. On delete, buffer the file info for 500ms with content hash
2. On add, check if hash + basename matches a pending delete
3. If match found, perform rename instead of delete + create

### Type Change Detection

Files can change between text and binary:

- Text → Binary: Delete snapshot, store blob, update doc type
- Binary → Text: Create text doc, update snapshot

### Diff/Merge Algorithm

1. Fork from last-known snapshot
2. Compute `fast-diff` between snapshot and new disk content
3. Apply patches to forked doc
4. Merge forked doc with current Automerge state
5. Write merged content back to disk
6. Update snapshot

### Scan

On startup, reconciler scans disk to:

- Import existing files not yet in Automerge
- Delete from Automerge files that no longer exist on disk
- Garbage collect unreferenced binary blobs

### Flush

Writes Automerge state to disk, respecting:

- Known paths (files we've seen before)
- Tombstones (don't recreate deleted files)
- User edits (don't overwrite unsaved changes)

After flush, reconciles any changes made during the write window.

## Sync Provider

Providers implement a simple interface:

```typescript
interface SyncProvider {
  fetch(): Promise<Map<string, Uint8Array>>;
  push(docs: Map<string, Uint8Array>, files: Map<string, string | Buffer>): Promise<void>;
  create(): Promise<void>;
  delete(): Promise<void>;
}
```

### GitHub Provider

- Uses Git Trees API for atomic commits
- Stores Automerge docs in `.stash/` folder
- Renders text files to repository root
- Supports path prefixes (`github:user/repo/folder`)
- Deletes remote files not in desired state (complete sync)

Remote format: `github:owner/repo[/path]`

Examples:
- `github:user/notes` → root of repo
- `github:user/repo/notes` → `notes/` folder in repo

## Conflict Resolution

### Content Wins

When merging, if one side has content and the other has a tombstone, content wins. This prevents accidental data loss.

### Fresh Join

When local is empty (no files), adopt remote state entirely:

1. Load remote structure doc directly
2. Load all remote file docs
3. Mark all paths as known

### Known Paths

Tracks files we've seen locally (`known-paths.json`). Used to distinguish:

- File deleted locally → create tombstone
- File never existed locally → adopt remote content (resurrect)

## Daemon

Background process providing:

- **MCP Server**: HTTP endpoint on port 32847
- **Reconcilers**: One per stash, watching for changes
- **Periodic Sync**: Every 30 seconds as fallback
- **PID File**: `~/.stash/daemon.pid` for process management

### MCP Tools

| Tool | Description |
|------|-------------|
| `stash_list` | List stashes or directory contents |
| `stash_glob` | Find files by pattern |
| `stash_read` | Read file content |
| `stash_write` | Write file (full replacement) |
| `stash_edit` | Replace unique text in file |
| `stash_delete` | Delete file or files by glob pattern |
| `stash_move` | Move/rename file (preserves doc identity) |
| `stash_grep` | Search file contents with regex |

All MCP tools read/write filesystem directly for consistency.

## CLI Commands

```bash
# Stash management
stash create <name>              # Create new stash
  --path <dir>                   # Custom directory (default: ~/.stash/stashes/<name>)
  --description <text>           # Optional description
  --remote <remote>              # Link to remote on creation

stash connect <remote>           # Clone/connect to remote stash
  --name <name>                  # Required: local name
  --path <dir>                   # Custom directory

stash list                       # List all stashes
stash edit <name>                # Update stash metadata
  --description <text>           # Change description
  --remote <remote|none>         # Change or disconnect remote

stash delete <name>              # Delete local stash
  --remote                       # Also delete from remote
  --force                        # Skip confirmation

stash link [stash] [path]        # Create symlink to stash
stash unlink [path]              # Remove stash symlink

# Sync
stash sync [name]                # Manual sync (all if no name)
stash status                     # Show daemon and stash status

# Daemon
stash start                      # Start background daemon
stash stop                       # Stop daemon (via PID file)

# Auth
stash auth github                # Set GitHub personal access token

# Setup
stash install                    # Show MCP client configuration
```

## Error Handling

### Retry with Backoff

Sync operations use exponential backoff:

```typescript
const RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};
```

### SyncError

Custom error type with `retryable` flag for network vs logic errors.

## Security Considerations

- **Name validation**: Rejects path traversal (`../`), hidden names (`.foo`)
- **Config permissions**: 0o600 for config file, 0o700 for directory
- **PID file**: Daemon stop uses PID file, not process scanning
- **Token storage**: GitHub PAT stored in config, not environment

## Performance Optimizations

- **Throttled reload**: Manager reloads limited to once per 2 seconds
- **Bulk CRDT operations**: Uses `insertAt`/`deleteAt` for efficient updates
- **Debounced sync**: 2-second debounce on sync after mutations
- **Atomic writes**: Uses temp file + rename for crash safety
- **Empty dir cleanup**: Removes empty parent directories after file deletion
