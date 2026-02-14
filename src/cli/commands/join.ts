import { StashManager } from "../../core/manager.js";
import { getGitHubToken } from "../../core/config.js";
import { GitHubProvider } from "../../providers/github.js";

export async function joinStash(
  key: string,
  localName: string,
  baseDir?: string,
): Promise<void> {
  const manager = await StashManager.load(baseDir);

  const [providerType, ...rest] = key.split(":");
  const providerKey = rest.join(":");

  if (providerType !== "github") {
    console.error(`Unsupported provider: ${providerType}`);
    process.exit(1);
  }

  const token = await getGitHubToken(baseDir);
  if (!token) {
    console.error("No GitHub token found. Run `stash auth github` first.");
    process.exit(1);
  }

  const [owner, repo] = providerKey.split("/");
  if (!owner || !repo) {
    console.error("Invalid key format. Expected: github:owner/repo");
    process.exit(1);
  }

  const provider = new GitHubProvider(token, owner, repo);

  try {
    await manager.join(key, localName, provider);
    console.log(`Joined stash "${localName}" from ${key}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
