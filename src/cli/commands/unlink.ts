import * as fs from "node:fs/promises";
import * as path from "node:path";

interface ProjectConfig {
  links: Record<string, string>;
}

export async function unlinkStash(linkPath?: string): Promise<void> {
  if (linkPath) {
    await removeSingleLink(path.resolve(linkPath));
    return;
  }

  // Read .stash.json and remove all links
  let config: ProjectConfig;
  try {
    const data = await fs.readFile(".stash.json", "utf-8");
    config = JSON.parse(data);
  } catch {
    console.error("No .stash.json found in current directory.");
    process.exit(1);
  }

  if (!config.links || Object.keys(config.links).length === 0) {
    console.log("No links defined in .stash.json");
    return;
  }

  for (const [, linkTarget] of Object.entries(config.links)) {
    const resolved = path.resolve(linkTarget);
    try {
      await removeSingleLink(resolved);
    } catch (err) {
      console.warn(`Could not remove ${resolved}: ${(err as Error).message}`);
    }
  }
}

async function removeSingleLink(linkPath: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(linkPath);
  } catch {
    console.error(`Path does not exist: ${linkPath}`);
    process.exit(1);
  }

  if (!stat.isSymbolicLink()) {
    console.error(`Not a symlink: ${linkPath}`);
    process.exit(1);
  }

  await fs.unlink(linkPath);
  console.log(`Removed symlink: ${linkPath}`);
}
