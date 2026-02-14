# Stash

A local-first collaborative folder service with MCP interface for AI agents and humans. Stash lets you create synced folders that multiple AI agents and humans can collaborate on, with automatic conflict resolution powered by Automerge CRDTs.

## Features

- **Local-first**: Files are stored locally and always available offline
- **Conflict-free sync**: Uses Automerge CRDTs to automatically merge concurrent edits
- **MCP interface**: AI agents can read and write files via the Model Context Protocol
- **GitHub sync**: Optionally sync stashes to GitHub repositories
- **CLI management**: Create, join, and manage stashes from the command line

## Installation

```bash
npm install
npm run build
npm link  # Optional: makes 'stash' available globally
```

## Quick Start

### Create a local stash

```bash
stash create my-notes
```

### Create a synced stash (with GitHub)

```bash
# First, configure your GitHub token
stash auth github

# Create a stash synced to GitHub
stash create my-project
# Select "github" when prompted, then enter your repo name (e.g., username/my-stash)
```

### Join an existing stash

```bash
stash join github:username/repo-name --name local-name
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `stash create <name>` | Create a new stash |
| `stash join <key> --name <name>` | Join an existing stash by its sync key |
| `stash list` | List all local stashes |
| `stash delete <name>` | Delete a local stash |
| `stash sync <name>` | Manually sync a stash |
| `stash start` | Start the background daemon |
| `stash stop` | Stop the background daemon |
| `stash status` | Show daemon status |
| `stash auth github` | Configure GitHub personal access token |
| `stash install` | Install MCP server for AI assistants |

## MCP Server

Stash includes an MCP server that AI agents can use to interact with stashes. The daemon exposes these tools:

| Tool | Description |
|------|-------------|
| `stash_list` | List stashes or files within a stash |
| `stash_glob` | Find files matching a glob pattern |
| `stash_read` | Read file content |
| `stash_write` | Write or patch file content |
| `stash_delete` | Delete a file |
| `stash_move` | Move or rename a file |

### Path format

MCP tools use the format `stash-name:filepath`:

- `stash_list({})` - List all stashes
- `stash_list({ path: "my-stash:" })` - List files in stash root
- `stash_list({ path: "my-stash:notes/" })` - List files in a subdirectory
- `stash_read({ path: "my-stash:notes/todo.md" })` - Read a specific file

Each tool call syncs with remote storage before executing, so the daemon is optional.

### Installing the MCP server

Run the install command to automatically configure the MCP server:

```bash
stash install
# Select which AI assistants to configure (e.g., Claude Code)
```

This writes the MCP configuration to the appropriate config file for each selected assistant.

#### Manual configuration (Claude Desktop)

Alternatively, add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "stash": {
      "command": "node",
      "args": ["/path/to/stash/dist/daemon.js"]
    }
  }
}
```

## How It Works

1. **Local storage**: Each stash is a folder containing your files plus Automerge binary state
2. **CRDT sync**: File changes are tracked as Automerge operations, enabling automatic conflict resolution
3. **GitHub backend**: Synced stashes push Automerge state to `.stash/docs/` and readable files to the repo root
4. **Daemon**: The background daemon handles periodic syncing and serves the MCP interface

## Development

```bash
# Build
npm run build

# Watch mode
npm run dev

# Run tests
npm test
```

## Requirements

- Node.js 18+
- GitHub personal access token (for GitHub sync, requires `repo` scope)

## License

MIT
