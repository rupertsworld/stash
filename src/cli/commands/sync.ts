import { StashManager } from "../../core/manager.js";
import { StashReconciler } from "../../core/reconciler.js";

export async function syncStashes(name?: string): Promise<void> {
  const manager = await StashManager.load();

  if (name) {
    const stash = manager.get(name);
    if (!stash) {
      console.error(`Stash not found: ${name}`);
      process.exit(1);
    }
    try {
      // Scan disk for new files before syncing
      const reconciler = new StashReconciler(stash);
      await reconciler.scan();

      await stash.sync();
      console.log(`Synced: ${name}`);
    } catch (err) {
      console.error(`Failed to sync ${name}: ${(err as Error).message}`);
      process.exit(1);
    }
  } else {
    try {
      // Scan disk for all stashes before syncing
      for (const stash of manager.getStashes().values()) {
        const reconciler = new StashReconciler(stash);
        await reconciler.scan();
      }

      await manager.sync();
      console.log("All stashes synced.");
    } catch (err) {
      if (err instanceof AggregateError) {
        for (const e of err.errors) {
          console.error((e as Error).message);
        }
      } else {
        console.error((err as Error).message);
      }
      process.exit(1);
    }
  }
}
