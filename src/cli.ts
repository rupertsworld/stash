#!/usr/bin/env node

import { Command } from "commander";
import { authGitHub } from "./cli/commands/auth.js";
import { createStash } from "./cli/commands/create.js";
import { connectStash } from "./cli/commands/connect.js";
import { listStashes } from "./cli/commands/list.js";
import { editStash } from "./cli/commands/edit.js";
import { deleteStash } from "./cli/commands/delete.js";
import { linkStash } from "./cli/commands/link.js";
import { unlinkStash } from "./cli/commands/unlink.js";
import { syncStashes } from "./cli/commands/sync.js";
import { showStatus } from "./cli/commands/status.js";
import { startDaemon } from "./cli/commands/start.js";
import { stopDaemon } from "./cli/commands/stop.js";
import { install } from "./cli/commands/install.js";
import {
  pathOption,
  descriptionOption,
  forceOption,
  remoteOption,
} from "./cli/options.js";

const program = new Command();

program
  .name("stash")
  .description(
    "A local-first collaborative folder service with MCP interface",
  )
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
  .addOption(pathOption)
  .addOption(descriptionOption)
  .addOption(remoteOption)
  .action((name, opts) => createStash(name, opts));

program
  .command("connect <remote>")
  .description("Connect to an existing remote stash")
  .requiredOption("--name <name>", "Local name for the stash")
  .addOption(pathOption)
  .action((remote, opts) => connectStash(remote, opts));

program
  .command("list")
  .description("List all stashes")
  .action(listStashes);

program
  .command("edit <name>")
  .description("Update stash metadata")
  .addOption(descriptionOption)
  .option("--remote <remote>", "change remote (use 'none' to disconnect)")
  .action((name, opts) => editStash(name, opts));

program
  .command("delete <name>")
  .description("Delete a stash")
  .option("--remote", "also delete from remote provider")
  .addOption(forceOption)
  .action((name, opts) => deleteStash(name, opts));

program
  .command("link [stash] [path]")
  .description("Create symlink to a stash")
  .action((stash, linkPath) => linkStash(stash, linkPath));

program
  .command("unlink [path]")
  .description("Remove stash symlink")
  .action((linkPath) => unlinkStash(linkPath));

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
