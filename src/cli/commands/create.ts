import { StashManager } from "../../core/manager.js";
import { getGitHubToken } from "../../core/config.js";
import { GitHubProvider } from "../../providers/github.js";
import { promptChoice, prompt } from "../prompts.js";

interface CreateOptions {
  path?: string;
  description?: string;
}

export async function createStash(
  name: string,
  opts: CreateOptions,
): Promise<void> {
  const manager = await StashManager.load();

  const providerChoice = await promptChoice("Sync provider?", [
    "None",
    "GitHub",
  ]);

  let provider = null;
  let remote: string | null = null;

  if (providerChoice === "GitHub") {
    const token = await getGitHubToken();
    if (!token) {
      console.error(
        "No GitHub token found. Run `stash auth github` first.",
      );
      process.exit(1);
    }

    const repoName = await prompt("GitHub repo (owner/repo): ");
    if (!repoName.includes("/")) {
      console.error("Invalid repo format. Use owner/repo.");
      process.exit(1);
    }

    const [owner, repo] = repoName.split("/");
    provider = new GitHubProvider(token, owner, repo);

    const remoteExists = await provider.exists();
    if (!remoteExists) {
      console.log(`Creating ${repoName}...`);
      try {
        await provider.create();
      } catch (err) {
        console.error(`Failed to create remote: ${(err as Error).message}`);
        process.exit(1);
      }
    }

    remote = `github:${repoName}`;
  }

  try {
    const stash = await manager.create(
      name,
      opts.path,
      provider,
      remote,
      opts.description,
    );
    console.log(`Stash "${name}" created.`);
    if (remote) console.log(`Remote: ${remote}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
