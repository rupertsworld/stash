import { StashManager } from "../../core/manager.js";

export async function listStashes(baseDir?: string): Promise<void> {
  const manager = await StashManager.load(baseDir);
  const stashes = manager.list();

  if (stashes.length === 0) {
    console.log("No stashes. Create one with: stash create <name>");
    return;
  }

  for (const name of stashes) {
    const stash = manager.get(name)!;
    const meta = stash.getMeta();
    const suffix = meta.key ? ` (${meta.key})` : " (local)";
    console.log(`  ${name}${suffix}`);
  }
}
