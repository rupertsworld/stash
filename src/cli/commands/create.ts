import { StashManager } from "../../core/manager.js";
import { getGitHubToken } from "../../core/config.js";
import { GitHubProvider } from "../../providers/github.js";
import { promptChoice, prompt } from "../prompts.js";

export async function createStash(
  name: string,
  baseDir?: string,
): Promise<void> {
  const manager = await StashManager.load(baseDir);

  const providerChoice = await promptChoice("Sync provider?", [
    "None",
    "GitHub",
  ]);

  let provider = null;
  let providerType: string | null = null;
  let key: string | null = null;

  if (providerChoice === "GitHub") {
    const token = await getGitHubToken(baseDir);
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
    providerType = "github";
    key = `github:${repoName}`;
  }

  try {
    const stash = await manager.create(name, provider, providerType, key);
    console.log(`Stash "${name}" created.`);
    if (key) console.log(`Key: ${key}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
