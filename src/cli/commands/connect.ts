import { StashManager } from "../../core/manager.js";
import { getGitHubToken } from "../../core/config.js";
import { GitHubProvider } from "../../providers/github.js";

interface ConnectOptions {
  name: string;
  path?: string;
}

export async function connectStash(
  remote: string,
  opts: ConnectOptions,
): Promise<void> {
  const manager = await StashManager.load();

  const [providerType, ...rest] = remote.split(":");
  const providerKey = rest.join(":");

  if (providerType !== "github") {
    console.error(`Unsupported provider: ${providerType}`);
    process.exit(1);
  }

  const token = await getGitHubToken();
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
    await manager.connect(remote, opts.name, provider, opts.path);
    console.log(`Connected stash "${opts.name}" from ${remote}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
