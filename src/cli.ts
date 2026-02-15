#!/usr/bin/env node

import { Command } from "commander";
import { authGitHub } from "./cli/commands/auth.js";
import { createStash } from "./cli/commands/create.js";
import { connectStash } from "./cli/commands/connect.js";
import { listStashes } from "./cli/commands/list.js";
import { deleteStash } from "./cli/commands/delete.js";
import { syncStashes } from "./cli/commands/sync.js";
import { showStatus } from "./cli/commands/status.js";
import { startDaemon } from "./cli/commands/start.js";
import { stopDaemon } from "./cli/commands/stop.js";
import { install } from "./cli/commands/install.js";

const program = new Command();

program
  .name("stash")
  .description("A local-first collaborative folder service with MCP interface")
  .version("1.0.0");

// Auth
const auth = program.command("auth").description("Authentication commands");
auth
  .command("github")
  .description("Set GitHub personal access token")
  .action(authGitHub);

// Stash management
program
  .command("create <name>")
  .description("Create a new stash")
  .action(createStash);

program
  .command("connect <key>")
  .description("Connect to an existing remote stash")
  .requiredOption("--name <name>", "Local name for the stash")
  .action((key, opts) => connectStash(key, opts.name));

program
  .command("list")
  .description("List all stashes")
  .action(listStashes);

program
  .command("delete <name>")
  .description("Delete a stash")
  .action(deleteStash);

program
  .command("sync [name]")
  .description("Sync stashes (all if no name given)")
  .action(syncStashes);

program
  .command("status")
  .description("Show daemon and stash status")
  .action(showStatus);

// Daemon
program
  .command("start")
  .description("Start the background daemon")
  .action(startDaemon);

program
  .command("stop")
  .description("Stop the background daemon")
  .action(stopDaemon);

program
  .command("install")
  .description("Show MCP client configuration")
  .action(install);

program.parse();
