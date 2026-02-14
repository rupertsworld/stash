import { StashManager } from "../../core/manager.js";
import { confirm } from "../prompts.js";

export async function deleteStash(
  name: string,
  baseDir?: string,
): Promise<void> {
  const manager = await StashManager.load(baseDir);
  const stash = manager.get(name);

  if (!stash) {
    console.error(`Stash not found: ${name}`);
    process.exit(1);
  }

  const meta = stash.getMeta();
  let deleteRemote = false;

  if (meta.key) {
    deleteRemote = await confirm("Also delete remote?");
  }

  try {
    await manager.delete(name, deleteRemote);
    console.log(`Stash "${name}" deleted.`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
