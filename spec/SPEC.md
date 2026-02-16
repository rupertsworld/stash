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

Uses chokidar with `ignoreInitial: true`. Events:

- **add**: Create file doc, update structure
- **change**: Compute diff, apply patches to CRDT
- **unlink**: Create tombstone (soft-delete)

### Diff/Merge Algorithm

1. Fork from last-known snapshot
2. Compute `fast-diff` between snapshot and new disk content
3. Apply patches to forked doc
4. Merge forked doc with current Automerge state
5. Write merged content back to disk
6. Update snapshot

### Scan

On startup, reconciler scans disk to import existing files not yet in Automerge.

### Flush

Writes Automerge state to disk, respecting:

- Known paths (files we've seen before)
- Tombstones (don't recreate deleted files)
- User edits (don't overwrite unsaved changes)

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

## Conflict Resolution

### Content Wins

When merging, if one side has content and the other has a tombstone, content wins. This prevents accidental data loss.

### Known Paths

Tracks files we've seen locally. Used to distinguish:

- File deleted locally → create tombstone
- File never existed locally → adopt remote content

## Daemon

Background process providing:

- **MCP Server**: HTTP endpoint for Claude Code tools
- **Reconcilers**: One per stash, watching for changes
- **Periodic Sync**: Every 30 seconds as fallback

### MCP Tools

| Tool | Description |
|------|-------------|
| `stash_list` | List stashes or directory contents |
| `stash_glob` | Find files by pattern |
| `stash_read` | Read file content |
| `stash_write` | Write file content |
| `stash_edit` | Replace text in file |
| `stash_delete` | Delete file |
| `stash_move` | Move/rename file |
| `stash_grep` | Search file contents |

All MCP tools read/write filesystem directly for consistency.

## CLI Commands

```bash
stash create <name> [path]    # Create new stash
stash connect <remote> [name] # Connect to remote stash
stash list                    # List stashes
stash delete <name>           # Delete stash
stash start                   # Start daemon
stash stop                    # Stop daemon
stash sync                    # Manual sync
stash config                  # Configure (GitHub token, etc.)
```

## Security Considerations

- **Name validation**: Rejects path traversal (`../`), hidden names (`.foo`)
- **Config permissions**: Token file readable only by owner
- **PID file**: Daemon stop uses PID file, not `lsof`

## Performance Optimizations

- **Throttled reload**: Manager reloads limited to once per 2 seconds
- **Bulk operations**: Uses `splice()` for efficient CRDT updates
- **Debounced sync**: 2-second debounce on sync after mutations
