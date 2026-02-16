import { StashManager } from "../../core/manager.js";
import { confirm } from "../prompts.js";

interface DeleteOptions {
  remote?: boolean;
  force?: boolean;
}

export async function deleteStash(
  name: string,
  opts: DeleteOptions,
): Promise<void> {
  const manager = await StashManager.load();
  const stash = manager.get(name);

  if (!stash) {
    console.error(`Stash not found: ${name}`);
    process.exit(1);
  }

  // Confirm unless --force
  if (!opts.force) {
    const confirmed = await confirm(`Delete stash "${name}"?`);
    if (!confirmed) {
      console.log("Cancelled.");
      return;
    }
  }

  let deleteRemote = opts.remote ?? false;

  // Extra confirmation for remote deletion
  if (deleteRemote && !opts.force) {
    const confirmed = await confirm(
      "This will permanently delete the remote. Are you sure?",
    );
    if (!confirmed) {
      deleteRemote = false;
    }
  }

  try {
    await manager.delete(name, deleteRemote);
    console.log(`Stash "${name}" deleted.`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
