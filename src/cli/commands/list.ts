import { StashManager } from "../../core/manager.js";

export async function listStashes(): Promise<void> {
  const manager = await StashManager.load();
  const stashes = manager.list();

  if (stashes.length === 0) {
    console.log("No stashes. Create one with: stash create <name>");
    return;
  }

  for (const name of stashes) {
    const stash = manager.get(name)!;
    const meta = stash.getMeta();
    const desc = meta.description ? `"${meta.description}"` : "";
    const remote = meta.remote ? meta.remote : "(local only)";
    const parts = [name];
    if (desc) parts.push(desc);
    parts.push(stash.path);
    parts.push(remote);
    console.log(`  ${parts.join("  ")}`);
  }
}
