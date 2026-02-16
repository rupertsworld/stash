import { StashManager } from "../../core/manager.js";
import { getGitHubToken } from "../../core/config.js";
import { GitHubProvider, parseGitHubRemote } from "../../providers/github.js";
import { promptChoice, prompt } from "../prompts.js";

interface CreateOptions {
  path?: string;
  description?: string;
  remote?: string;
}

export async function createStash(
  name: string,
  opts: CreateOptions,
): Promise<void> {
  const manager = await StashManager.load();

  let provider = null;
  let remote: string | null = null;

  if (opts.remote !== undefined) {
    // --remote flag provided, skip prompt
    if (opts.remote === "none") {
      // Local only, no provider
    } else if (opts.remote.startsWith("github:")) {
      const parsed = parseGitHubRemote(opts.remote);
      if (!parsed) {
        console.error("Invalid remote format. Use github:owner/repo or github:owner/repo/folder");
        process.exit(1);
      }

      const token = await getGitHubToken();
      if (!token) {
        console.error("No GitHub token found. Run `stash auth github` first.");
        process.exit(1);
      }

      provider = new GitHubProvider(token, parsed.owner, parsed.repo, parsed.pathPrefix);

      // Check remote state using fetch()
      let remoteDocs: Map<string, Uint8Array>;
      try {
        remoteDocs = await provider.fetch();
      } catch (err) {
        const error = err as Error & { status?: number };
        if (error.status === 404) {
          console.error(`Repository ${parsed.owner}/${parsed.repo} does not exist.`);
          console.error("Create the repository on GitHub first.");
          process.exit(1);
        }
        throw err;
      }

      if (remoteDocs.size > 0) {
        console.error(`Repository ${parsed.owner}/${parsed.repo} already has stash data.`);
        console.error("Use 'stash connect' to join an existing stash.");
        process.exit(1);
      }

      // Initialize empty repo with .stash structure
      console.log("Initializing repository...");
      await provider.create();

      remote = opts.remote;
    } else {
      console.error("Unknown remote format. Use 'none' or 'github:owner/repo'");
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

      const repoInput = await prompt("GitHub repo (owner/repo or owner/repo/folder): ");
      const parts = repoInput.split("/");
      if (parts.length < 2) {
        console.error("Invalid repo format. Use owner/repo or owner/repo/folder.");
        process.exit(1);
      }

      const [owner, repo, ...pathParts] = parts;
      const pathPrefix = pathParts.join("/");
      provider = new GitHubProvider(token, owner, repo, pathPrefix);

      // Check remote state using fetch()
      let remoteDocs: Map<string, Uint8Array>;
      try {
        remoteDocs = await provider.fetch();
      } catch (err) {
        const error = err as Error & { status?: number };
        if (error.status === 404) {
          console.error(`Repository ${owner}/${repo} does not exist.`);
          console.error("Create the repository on GitHub first.");
          process.exit(1);
        }
        throw err;
      }

      if (remoteDocs.size > 0) {
        console.error(`Repository ${owner}/${repo} already has stash data.`);
        console.error("Use 'stash connect' to join an existing stash.");
        process.exit(1);
      }

      // Initialize empty repo with .stash structure
      console.log("Initializing repository...");
      await provider.create();

      remote = `github:${repoInput}`;
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
      console.log(`Imported ${fileCount} existing file(s).`);
    }

    // Sync to push imported files to remote
    if (provider && fileCount > 0) {
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
