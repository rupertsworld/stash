import { StashManager } from "../../core/manager.js";

export async function syncStashes(
  name?: string,
  baseDir?: string,
): Promise<void> {
  const manager = await StashManager.load(baseDir);

  if (name) {
    const stash = manager.get(name);
    if (!stash) {
      console.error(`Stash not found: ${name}`);
      process.exit(1);
    }
    try {
      await stash.sync();
      console.log(`Synced: ${name}`);
    } catch (err) {
      console.error(`Failed to sync ${name}: ${(err as Error).message}`);
      process.exit(1);
    }
  } else {
    try {
      await manager.sync();
      console.log("All stashes synced.");
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  }
}
