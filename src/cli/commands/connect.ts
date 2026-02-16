import { StashManager } from "../../core/manager.js";
import { getGitHubToken } from "../../core/config.js";
import { GitHubProvider, parseGitHubRemote } from "../../providers/github.js";

interface ConnectOptions {
  name: string;
  path?: string;
}

export async function connectStash(
  remote: string,
  opts: ConnectOptions,
): Promise<void> {
  const manager = await StashManager.load();

  const parsed = parseGitHubRemote(remote);
  if (!parsed) {
    console.error("Invalid remote format. Expected: github:owner/repo or github:owner/repo/folder");
    process.exit(1);
  }

  const token = await getGitHubToken();
  if (!token) {
    console.error("No GitHub token found. Run `stash auth github` first.");
    process.exit(1);
  }

  const provider = new GitHubProvider(token, parsed.owner, parsed.repo, parsed.pathPrefix);

  try {
    await manager.connect(remote, opts.name, provider, opts.path);
    console.log(`Connected stash "${opts.name}" from ${remote}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
