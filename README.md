# Stash

Conflict-free synced folders for humans and agents. Multiple editors can read and write to the same files simultaneously & changes merge automatically.

## The Problem

When multiple people or agents work on shared files:

- **Git** requires manual conflict resolution and pull/push workflows
- **SyncThing** (and other solutions) can conflict
- **No good solution** for concurrent editing across humans and agents

## How Stash Solves It

Stash uses CRDTs (Automerge) to automatically merge edits—no conflicts, no manual intervention. Changes sync in the background to GitHub (or other providers in future).

- **Conflict-free**: Concurrent edits merge automatically
- **Auto-sync**: No pull/push, changes sync in background
- **MCP tools**: Agents read/write via Model Context Protocol
- **Local-first**: Always available offline, syncs when connected

## Quick Start

```bash
npm install && npm run build
npm link  # makes 'stash' available globally

# Create a synced stash
stash auth github           # configure GitHub token
stash create my-stash       # select "github" when prompted

# Start background sync
stash start
```

## CLI Commands

```
stash create <name>     Create a new stash
stash connect <key>     Connect to an existing stash (e.g., github:user/repo)
stash list              List all stashes
stash delete <name>     Delete a stash
stash start             Start background daemon
stash stop              Stop daemon
stash auth github       Configure GitHub token
stash install           Show MCP server config
```

## MCP Tools

Add to Claude Code:
```bash
claude mcp add stash node /path/to/stash/dist/mcp-server.js
```

Available tools:

| Tool | Description |
|------|-------------|
| `stash_list` | List stashes or files in a directory |
| `stash_glob` | Find files matching a pattern |
| `stash_read` | Read file content |
| `stash_write` | Write or patch a file |
| `stash_delete` | Delete a file |
| `stash_move` | Move/rename a file |
| `stash_edit` | Replace text in a file |
| `stash_grep` | Search file contents |

Example usage:
```
stash_list({})                                       // list all stashes
stash_list({ stash: "notes" })                       // list files in stash root
stash_list({ stash: "notes", path: "subdir/" })      // list files in subdir
stash_read({ stash: "notes", path: "todo.md" })      // read a file
stash_write({ stash: "notes", path: "todo.md", content: "..." })
```

## Architecture

See [spec/index.md](spec/index.md) for detailed system documentation.

Key features:
- **Filesystem-first**: Edit files normally, reconciler syncs to CRDTs
- **Soft-delete**: Deleted files become tombstones for proper sync
- **Content-wins**: When conflicts arise, content beats deletion

## Requirements

- Node.js 18+
- GitHub token with `repo` scope (for GitHub sync)

## License

MIT
