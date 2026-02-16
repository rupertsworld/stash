# Stash

Conflict-free synced folders for humans and agents.

Multiple editors can read and write to the same files simultaneously. All changes merge automatically using CRDTs -- no conflicts, no manual resolution, no pull/push workflows.

## The Problem

When multiple people or AI agents work on shared files:

- **Git** requires manual conflict resolution and explicit pull/push workflows
- **Dropbox/SyncThing** can conflict or silently overwrite concurrent edits
- **No existing solution** handles concurrent editing across humans and agents cleanly

## How Stash Works

Stash stores every file as an [Automerge](https://automerge.org/) CRDT (Conflict-free Replicated Data Type). This means:

- **Concurrent edits always merge** -- two people editing the same file at the same time get a deterministic, sensible result
- **Changes sync in the background** to GitHub (or other providers in the future)
- **Works offline** -- all data lives locally, sync happens when connected
- **AI-agent-native** -- a full MCP interface lets agents read/write files as naturally as humans

## Quick Start

```bash
# Install
npm install
npm run build
npm link                      # makes 'stash' command available globally

# Set up GitHub sync
stash auth github             # paste a GitHub personal access token (repo scope)

# Create a synced stash
stash create my-notes         # select "GitHub" when prompted for provider
                              # enter "youruser/my-notes" as the repo

# Start background sync
stash start
```

Your stash is now live. Any writes (via CLI, MCP, or another connected instance) sync automatically.

### Connect from Another Machine

```bash
stash connect github:youruser/my-notes --name my-notes
stash start
```

Both machines now share the same files with automatic conflict-free merging.

## CLI Reference

```
stash auth github                   Set GitHub personal access token
stash create <name>                 Create a new stash (prompts for provider)
stash connect <key> --name <name>   Connect to an existing remote stash
stash list                          List all local stashes
stash delete <name>                 Delete a stash (optionally delete remote)
stash sync [name]                   Manually sync one or all stashes
stash status                        Show daemon and stash status
stash start                         Start background sync daemon
stash stop                          Stop the daemon
stash install                       Print MCP client configuration
```

### Key Format

Remote stash keys follow the pattern `provider:location`:

```
github:owner/repo              # GitHub repository
```

## MCP Integration

Stash provides a Model Context Protocol (MCP) server so AI agents (like Claude Code) can read and write stash files directly.

### Setup

**Option A: Stdio transport** (recommended for single-agent use)

```bash
claude mcp add stash node /path/to/stash/dist/mcp-server.js
```

Or run `stash install` to see the full MCP config JSON.

**Option B: HTTP transport** (via daemon, for multi-client use)

```bash
stash start   # starts daemon on port 32847
# MCP endpoint: http://localhost:32847/mcp
```

### Available Tools

| Tool           | Description                              | Required Params            |
| -------------- | ---------------------------------------- | -------------------------- |
| `stash_list`   | List stashes or directory contents       | none (optional: stash, path)|
| `stash_glob`   | Find files matching a glob pattern       | stash, pattern             |
| `stash_read`   | Read file content                        | stash, path                |
| `stash_write`  | Write or patch a file                    | stash, path, content/patch |
| `stash_delete` | Delete a file                            | stash, path                |
| `stash_move`   | Move/rename a file                       | stash, from, to            |

### Example Usage

```
stash_list({})                                          # list all stashes
stash_list({ stash: "notes" })                          # list files at root
stash_list({ stash: "notes", path: "docs/" })           # list files in subdirectory
stash_read({ stash: "notes", path: "todo.md" })         # read a file
stash_write({ stash: "notes", path: "todo.md",          # write a file
              content: "# My Todo\n- item 1" })
stash_write({ stash: "notes", path: "todo.md",          # patch (partial edit)
              patch: { start: 0, end: 7, text: "# Tasks" } })
stash_delete({ stash: "notes", path: "old.md" })        # delete a file
stash_move({ stash: "notes", from: "a.md", to: "b.md"}) # rename/move
```

## Architecture

Stash is organized in layers:

```
Interface Layer      CLI (Commander.js) | MCP stdio | MCP HTTP (daemon)
                                    |
Manager Layer        StashManager -- manages --> Stash instances
                                    |
Document Layer       StructureDoc (file index) --> FileDoc[] (Automerge.Text CRDTs)
                                    |
Provider Layer       SyncProvider interface --> GitHubProvider
```

**Key design decisions:**

- Each file is a separate Automerge document (efficient per-file sync)
- A structure document maps file paths to document IDs
- Providers own the full sync cycle (fetch, merge, push)
- Background save chains ensure ordered persistence
- Sync is debounced (2s) to batch rapid edits

See [spec/SYSTEM.md](spec/SYSTEM.md) for the full system specification.

### On-Disk Layout

```
~/.stash/
├── config.json                    # Global config (GitHub token)
├── my-notes/                      # A stash
│   ├── meta.json                  # Metadata (name, provider, key, actorId)
│   ├── structure.automerge        # File index (Automerge binary)
│   └── docs/
│       ├── 01HX....automerge      # File content (Automerge binary)
│       └── ...
└── another-stash/
    └── ...
```

### GitHub Repo Layout

When synced to GitHub, the repository contains both the authoritative CRDT data and human-readable renderings:

```
repo/
├── .stash/                        # Binary Automerge documents (authoritative)
│   ├── structure.automerge
│   └── docs/
│       └── *.automerge
├── todo.md                        # Plain-text rendering (for browsing on GitHub)
├── notes/
│   └── meeting.md
└── ...
```

## Development

```bash
npm install           # install dependencies
npm run build         # compile TypeScript to dist/
npm test              # run tests
npm run test:watch    # run tests in watch mode
```

### Project Structure

```
src/
├── cli.ts                     # CLI entry point (Commander.js)
├── cli/
│   ├── prompts.ts             # Interactive prompt utilities
│   └── commands/              # CLI command implementations
│       ├── auth.ts
│       ├── create.ts
│       ├── connect.ts
│       ├── list.ts
│       ├── delete.ts
│       ├── sync.ts
│       ├── status.ts
│       ├── start.ts
│       ├── stop.ts
│       └── install.ts
├── core/
│   ├── stash.ts               # Stash class (file operations, save/sync)
│   ├── manager.ts             # StashManager (multi-stash orchestration)
│   ├── structure.ts           # StructureDoc (Automerge file index)
│   ├── file.ts                # FileDoc (Automerge text content)
│   ├── config.ts              # Configuration and token management
│   └── errors.ts              # SyncError and retry logic
├── providers/
│   ├── types.ts               # SyncProvider interface
│   └── github.ts              # GitHub sync implementation
├── daemon.ts                  # Background daemon (Express + file watcher)
├── mcp.ts                     # MCP tool definitions and handlers
└── mcp-server.ts              # Stdio MCP server entry point
```

## Requirements

- Node.js 18+
- GitHub personal access token with `repo` scope (for GitHub sync)

## License

MIT
