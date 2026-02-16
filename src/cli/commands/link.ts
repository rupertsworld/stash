import * as fs from "node:fs/promises";
import * as path from "node:path";
import { StashManager } from "../../core/manager.js";

interface ProjectConfig {
  links: Record<string, string>;
}

export async function linkStash(
  stashName?: string,
  linkPath?: string,
): Promise<void> {
  const manager = await StashManager.load();

  if (!stashName) {
    // Read .stash.json and create all links
    await linkFromConfig(manager);
    return;
  }

  const stash = manager.get(stashName);
  if (!stash) {
    console.error(`Stash not found: ${stashName}`);
    process.exit(1);
  }

  const target = stash.path;
  const link = path.resolve(linkPath ?? `./${stashName}`);

  // Check if path already exists
  try {
    await fs.lstat(link);
    console.error(`Path already exists: ${link}`);
    process.exit(1);
  } catch {
    // Path doesn't exist, good
  }

  await fs.symlink(target, link);
  console.log(`Linked: ${link} → ${target}`);
}

async function linkFromConfig(manager: StashManager): Promise<void> {
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

  for (const [stashName, linkPath] of Object.entries(config.links)) {
    const stash = manager.get(stashName);
    if (!stash) {
      console.warn(`Stash not found: ${stashName}, skipping.`);
      continue;
    }

    const resolved = path.resolve(linkPath);
    try {
      await fs.lstat(resolved);
      console.warn(`Path already exists: ${resolved}, skipping.`);
      continue;
    } catch {
      // Doesn't exist, proceed
    }

    await fs.symlink(stash.path, resolved);
    console.log(`Linked: ${resolved} → ${stash.path}`);
  }
}
