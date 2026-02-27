import { StashManager } from "../../core/manager.js";
import { getGitHubToken } from "../../core/config.js";
import { GitHubProvider, parseGitHubRemote } from "../../providers/github.js";
import { promptChoice, prompt } from "../prompts.js";

interface CreateOptions {
  path?: string;
  description?: string;
  remote?: string;
  create?: boolean;
}

export async function createStash(
  name: string,
  opts: CreateOptions,
): Promise<void> {
  const manager = await StashManager.load();

  let provider: GitHubProvider | null = null;
  let remote: string | null = null;

  if (opts.remote !== undefined) {
    // --remote flag provided, skip prompt
    if (opts.remote === "none") {
      // Local only, no provider
    } else if (opts.remote.startsWith("github:")) {
      const parsed = parseGitHubRemote(opts.remote);
      if (!parsed) {
        console.error("Invalid remote format. Use github:owner/repo");
        process.exit(1);
      }
      if (parsed.pathPrefix) {
        console.error("Subfolder paths are not supported. Use github:owner/repo");
        process.exit(1);
      }

      const token = await getGitHubToken();
      if (!token) {
        console.error("No GitHub token found. Run `stash auth github` first.");
        process.exit(1);
      }

      provider = new GitHubProvider(token, parsed.owner, parsed.repo);

      let remoteDocs: Map<string, Uint8Array>;
      try {
        remoteDocs = await provider.fetch();
      } catch (err) {
        const error = err as Error & { status?: number };
        if (error.status === 404) {
          if (!opts.create) {
            console.error(`Repository ${parsed.owner}/${parsed.repo} does not exist.`);
            console.error("Create the repository on GitHub first, or use --create to create it.");
            process.exit(1);
          }
          if (provider.create) {
            await provider.create();
          }
          remoteDocs = new Map();
        } else {
          throw err;
        }
      }

      if (remoteDocs.size > 0) {
        console.error(`Repository ${parsed.owner}/${parsed.repo} already has stash data.`);
        console.error("Use 'stash connect' to join an existing stash.");
        process.exit(1);
      }

      remote = opts.remote;
    } else {
      console.error("Unknown remote format. Use 'none' or 'github:owner/repo'.");
      process.exit(1);
    }
  } else {
    // No --remote flag, interactive prompt
    const providerChoice = await promptChoice("Sync provider?", [
      "None",
      "GitHub",
    ]);

    if (providerChoice === "GitHub") {
      const token = await getGitHubToken();
      if (!token) {
        console.error(
          "No GitHub token found. Run `stash auth github` first.",
        );
        process.exit(1);
      }

      const repoInput = await prompt("GitHub repo (owner/repo): ");
      const parts = repoInput.split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        console.error("Invalid repo format. Use owner/repo");
        process.exit(1);
      }

      const [owner, repo] = parts;
      provider = new GitHubProvider(token, owner, repo);

      let remoteDocs: Map<string, Uint8Array>;
      try {
        remoteDocs = await provider.fetch();
      } catch (err) {
        const error = err as Error & { status?: number };
        if (error.status === 404) {
          const createChoice = await promptChoice(
            `Repository ${owner}/${repo} does not exist. Create it on GitHub?`,
            ["Yes", "No"],
          );
          if (createChoice === "No") {
            console.log("Aborted.");
            process.exit(0);
          }
          if (provider.create) {
            await provider.create();
          }
          remoteDocs = new Map();
        } else {
          throw err;
        }
      }

      if (remoteDocs.size > 0) {
        console.error(`Repository ${owner}/${repo} already has stash data.`);
        console.error("Use 'stash connect' to join an existing stash.");
        process.exit(1);
      }

      remote = `github:${owner}/${repo}`;
    }
  }

  try {
    const stash = await manager.create(
      name,
      opts.path,
      provider,
      remote,
      opts.description,
    );

    const fileCount = stash.listAllFiles().length;
    if (fileCount > 0) {
      console.log(`Total: ${fileCount} file(s) in stash.`);
    }

    // When a remote is configured, always perform initial sync after create.
    // This guarantees remote initialization even when local file count is zero.
    if (provider) {
      console.log("Syncing to remote...");
      await stash.sync();
    }

    console.log(`Stash "${name}" created.`);
    if (remote) console.log(`Remote: ${remote}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
