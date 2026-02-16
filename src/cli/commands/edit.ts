import { StashManager } from "../../core/manager.js";

interface EditOptions {
  description?: string;
  remote?: string;
}

export async function editStash(
  name: string,
  opts: EditOptions,
): Promise<void> {
  const manager = await StashManager.load();
  const stash = manager.get(name);

  if (!stash) {
    console.error(`Stash not found: ${name}`);
    process.exit(1);
  }

  if (opts.description !== undefined) {
    stash.setMeta({ description: opts.description });
  }

  if (opts.remote !== undefined) {
    const remote = opts.remote === "none" ? null : opts.remote;
    stash.setMeta({ remote });
  }

  try {
    await stash.save();
    console.log(`Stash "${name}" updated.`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
