# Stash

A local-first collaborative folder service with MCP interface for AI agents and humans.

## Overview

Stash is a synced folder of markdown/text files that agents and humans can collaboratively edit. It uses CRDTs (Automerge) for conflict-free merging and pluggable sync providers for transport.

```
stash create my-project
→ Sync provider? [None, GitHub]
→ GitHub repo name? rupert/stash-my-project
→ Created stash. Key: github:rupert/stash-my-project

stash join github:rupert/stash-my-project
→ Local name? [my-project]: _
→ Joined! Syncing...
```

## Design Goals

- **Local-first**: Files live on your machine, work offline
- **Conflict-free**: Automerge CRDTs handle concurrent edits
- **Simple**: Clean, modular code; easy to understand
- **Extensible**: Swap sync providers (GitHub now, Iroh/servers later)
- **No infrastructure**: Users don't deploy anything (GitHub is the backend)

## Architecture

```
┌─────────────────────────────────────────┐
│          Daemon (stash start)           │
│  - Background process                   │
│  - Runs MCP server                      │
│  - Sync loop (interval-based)           │
└─────────────────┬───────────────────────┘
                  │
┌─────────────────▼───────────────────────┐
│             MCP Server                  │
│  (read, write, list, delete, move)      │
└─────────────────┬───────────────────────┘
                  │
┌─────────────────▼───────────────────────┐
│           Stash Core                    │
│  - Automerge docs (CRDT layer)          │
│  - Local file storage                   │
│  - Merge logic                          │
└─────────────────┬───────────────────────┘
                  │
┌─────────────────▼───────────────────────┐
│       SyncProvider (interface)          │
│  - push/pull/onData - dumb transport    │
├─────────────────────────────────────────┤
│  GitHubProvider   │  Future providers:  │
│                   │  - IrohProvider     │
│                   │  - ServerProvider   │
│                   │  - S3Provider       │
└─────────────────────────────────────────┘
```

## Core Concepts

### Stash

A named collection of files that syncs as a unit. Stored locally at `~/.stash/<name>/`.

Contents:
```
~/.stash/my-project/
├── files/           # the actual markdown/text files
│   └── todo.md
├── meta.json        # stash metadata (provider, key, local name)
└── automerge/       # Automerge state per file
    └── todo.md.bin
```

### SyncProvider

Interface for transporting data. Providers don't handle conflict resolution or timing - they just move bytes.

```typescript
type SyncMessage = {
  type: 'snapshot'  // later: 'changes' for incremental P2P sync
  file: string      // path within stash, e.g., "notes/todo.md"
  data: Uint8Array  // Automerge binary data
}

class SyncProvider {
  // Send local state to remote/peers
  push(message: SyncMessage): Promise<void>

  // Request remote state (for polling-based providers)
  pull(): Promise<SyncMessage[] | null>

  // Receive data from peers (for P2P providers)
  // Returns a Disposable for cleanup
  onData(handler: (message: SyncMessage) => void): Disposable
}

// Factory functions per provider
namespace GitHubProvider {
  function create(repoName: string, localName: string): Promise<SyncProvider>
  function join(key: string, localName: string): Promise<SyncProvider>
}
```

**GitHub** uses `push`/`pull` (polling, snapshots).
**Iroh (future)** uses `push` and emits via `onData` (P2P, incremental changes).

### Stash Core (Orchestration)

The Stash class handles merging and timing:

```typescript
class Stash {
  provider: SyncProvider | null  // null if no sync provider

  constructor(provider: SyncProvider | null) {
    // Subscribe to incoming P2P changes
    provider?.onData((data) => this.merge(data))
  }

  // Sync once (pull, merge, push)
  sync(): Promise<void>

  // Auto-sync on interval (for polling providers)
  watch(intervalMs?: number): void
  unwatch(): void
}
```

### Automerge Layer

Each file in a stash is an Automerge document. This gives us:
- Character-level CRDT merging
- Automatic conflict resolution
- Change history

**File tracking:**
- One Automerge doc per file (stored in `automerge/<path>.bin`)
- File creation = create new Automerge doc
- File deletion = delete Automerge doc + mark as deleted in sync
- File move = delete old + create new (no identity tracking across paths)

**Sync behavior:**
- Writes update local Automerge state immediately
- Push to remote happens on next sync interval (not immediately)
- Debounce: 1-2 seconds after last write before marking "dirty" for sync

## MCP Server Interface

The MCP server exposes these tools to agents.

Path format: `<stash>:<filepath>` or empty/no-colon for listing stashes.

### `stash_list`

List stashes or files within a stash.

```typescript
// List all stashes
stash_list({})
→ { items: ["my-project", "research"] }

// List files in stash root
stash_list({ path: "my-project:" })
→ { items: ["todo.md", "notes/"] }

// List files in subdirectory
stash_list({ path: "my-project:notes/" })
→ { items: ["ideas.md", "links.md"] }
```

### `stash_read`

```typescript
{
  path: string  // e.g., "my-project:todo.md"
}
→ { content: string }
```

### `stash_write`

```typescript
{
  path: string,           // e.g., "my-project:todo.md"
  content?: string,       // full content replacement
  patch?: {               // OR partial edit
    start: number,
    end: number,
    text: string
  }
}
→ { success: boolean }
```

### `stash_delete`

```typescript
{
  path: string  // e.g., "my-project:old-notes.md"
}
→ { success: boolean }
```

### `stash_move`

```typescript
{
  from: string,  // e.g., "my-project:draft.md"
  to: string     // e.g., "my-project:notes/final.md"
}
→ { success: boolean }
```

### `stash_mkdir`

```typescript
{
  path: string  // e.g., "my-project:notes/archive/"
}
→ { success: boolean }
```

## CLI Interface

### Auth

```bash
stash auth github
# Prompts for GitHub personal access token
# Stores in ~/.stash/config.json
```

Only needed when using GitHub provider. Triggered automatically if you select GitHub during `create` without existing auth.

### Stash Management

```bash
stash create <name>
# Prompts:
#   Sync provider? [None, GitHub]
#   (if GitHub) Repo name? <user>/<repo>
# Creates local stash
# If GitHub: creates repo, returns key

stash join <key> [local-name]
# Joins existing stash by key
# Prompts for local name if not provided
# Key format: github:owner/repo

stash list
# Lists all local stashes

stash delete <name>
# Removes local stash
# Prompts: also delete remote? (if synced)
```

### Daemon

```bash
stash start
# Starts background daemon process
# - Runs MCP server
# - Watches all stashes, syncs on interval (default 30s)

stash stop
# Stops the daemon

stash status
# Shows daemon status, connected stashes, last sync times
```

### Sync

```bash
stash sync [name]
# Manual sync now (all stashes if name omitted)
# Works whether daemon is running or not
```

## GitHub Provider Implementation

### Storage Model

Each stash = one GitHub repo:
- `files/` - the actual content (markdown, readable on GitHub)
- `automerge/` - binary Automerge state for each file

### sync() Flow

1. Fetch latest from GitHub
2. For each file:
   - Load remote Automerge state
   - Merge with local Automerge state
   - Write merged content to local files
3. Commit merged state
4. Push to GitHub
5. If push fails (not fast-forward), retry from step 1

### Auth

For v1: prompt for personal access token, store in `~/.stash/config.json`.

Later: OAuth flow or `gh` CLI integration.

### Sharing

Just give collaborators the key (`github:owner/repo`). They need:
- The key
- Access to the GitHub repo (add them as collaborator)

No special `stash share` command needed.

## File Structure

```
~/.stash/
├── config.json              # global config (auth tokens)
├── my-project/
│   ├── files/
│   │   ├── notes.md
│   │   └── research/
│   │       └── links.md
│   ├── meta.json            # { provider, key, localName }
│   └── automerge/
│       ├── notes.md.bin
│       └── research/
│           └── links.md.bin
└── another-stash/
    └── ...
```

### meta.json

```json
{
  "localName": "my-project",
  "provider": "github",
  "key": "github:rupert/stash-my-project"
}
```

Or for local-only:

```json
{
  "localName": "my-project",
  "provider": null,
  "key": null
}
```

## Module Structure

```
src/
├── cli.ts                   # CLI entry point
├── daemon.ts                # Background daemon (MCP + sync loop)
├── mcp/
│   └── server.ts            # MCP server implementation
├── core/
│   ├── stash.ts             # Stash class (single stash)
│   ├── manager.ts           # Manages multiple stashes
│   ├── document.ts          # Single file Automerge wrapper
│   └── config.ts            # Global config (~/.stash/config.json)
├── providers/
│   ├── types.ts             # SyncProvider interface
│   └── github.ts            # GitHub implementation (v1 only)
└── cli/
    ├── commands/
    │   ├── create.ts
    │   ├── join.ts
    │   ├── sync.ts
    │   ├── start.ts
    │   ├── stop.ts
    │   ├── status.ts
    │   ├── list.ts
    │   ├── delete.ts
    │   └── auth.ts
    └── prompts.ts           # Interactive prompts
```

## Dependencies

- **@automerge/automerge** - CRDT implementation
- **@modelcontextprotocol/sdk** - MCP server
- **octokit** - GitHub API
- **commander** - CLI framework
- **inquirer** - Interactive prompts

## v1 Scope

**In:**
- CLI: create, join, sync, start, stop, status, list, delete, auth
- MCP server: read, write, list, delete, move, mkdir
- GitHub provider (with token auth)
- Local-only mode (no provider)
- Automerge conflict resolution
- Background daemon with sync loop

**Out (for later):**
- OAuth flow for GitHub
- Other providers (Iroh, S3, custom servers)
- Permissions (read-only sharing)
- Web UI
- Real-time sync (WebSocket)

## Implementation Notes

### v1 Focus: GitHub Provider Only

For v1, implement **only** the GitHub provider. The SyncProvider interface exists for future extensibility, but:
- `onData()` can be a no-op for GitHub (it never emits - polling only)
- Focus on `push()`/`pull()` working correctly with GitHub API
- Don't over-engineer for P2P yet

### GitHub API Usage

Use **Octokit** with the GitHub Contents API:
- `GET /repos/{owner}/{repo}/contents/{path}` - read files
- `PUT /repos/{owner}/{repo}/contents/{path}` - create/update files
- `DELETE /repos/{owner}/{repo}/contents/{path}` - delete files
- Requires SHA for updates/deletes (track in meta or fetch first)

### Suggested Build Order

1. **Core first**: `Stash` class with local-only mode (no provider)
   - Read/write files to `~/.stash/<name>/files/`
   - Automerge doc per file
   - No sync yet

2. **CLI basics**: `create`, `list`, `delete` (local-only)

3. **MCP server**: All tools working against local stash

4. **GitHub provider**: `push`/`pull` implementation

5. **Sync integration**: Wire provider into Stash, add `sync` command

6. **Daemon**: `start`/`stop`/`status` with sync loop

### Testing

Test with two local stashes pointing to same GitHub repo to verify:
- Concurrent edits merge correctly
- Sync picks up remote changes
- Conflicts resolve via Automerge

### Error Handling

- GitHub API errors: retry with backoff, surface to user
- Merge conflicts: Automerge handles automatically (no user intervention)
- Network offline: queue changes, sync when back online

## Future Considerations

### Provider Additions
- **IrohProvider**: When JS bindings mature (late 2025)
- **ServerProvider**: WebSocket server for real-time sync
- **S3Provider**: Simple blob storage

### GitHub API Limits
- 5000 requests/hour authenticated
- sync() should be efficient (fetch only changed files)

### Large Files
- Consider Git LFS for files over 1MB
- Or exclude large files from Automerge
