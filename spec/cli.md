# CLI

Command-line interface for stashes. Source: `cli.ts`, `cli/`. Program: `stash`, version from package.

## Options (global)

`--path`, `--description`, `--force`, `--remote`, `--create` (used where relevant per command).

## Commands

`stash auth github` — prompt for GitHub token, save to config.  
`stash create <name>` — create stash (optional import from disk); optional remote; `--create` with `--remote` creates the remote if missing; when remote is configured, run initial sync after create (even if local file count is zero).  
`stash connect <remote>` — connect to existing remote; requires `--name`; pulls into new local stash.  
`stash list` — list stashes with name, description, path, remote.  
`stash edit <name>` — update description/remote; `--remote none` disconnects.  
`stash delete <name>` — delete local (optional remote deletion with extra confirm).  
`stash sync [name]` — scan disk then sync; optional single stash by name.  
`stash status` — daemon running/stopped, stashes summary.  
`stash start` — start daemon (no-op if running).  
`stash stop` — stop daemon (SIGTERM via PID file or health check).

Command options and prompts: see `cli.ts` and `cli/` commands.
