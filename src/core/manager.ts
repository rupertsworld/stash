import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Stash } from "./stash.js";
import { DEFAULT_STASH_DIR } from "./config.js";
import type { SyncProvider } from "../providers/types.js";

export class StashManager {
  private stashes: Map<string, Stash>;
  private baseDir: string;

  constructor(stashes: Map<string, Stash>, baseDir: string) {
    this.stashes = stashes;
    this.baseDir = baseDir;
  }

  static async load(
    baseDir: string = DEFAULT_STASH_DIR,
  ): Promise<StashManager> {
    const stashes = new Map<string, Stash>();

    try {
      const entries = await fs.readdir(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // Check if it's a stash directory (has meta.json)
        const metaPath = path.join(baseDir, entry.name, "meta.json");
        try {
          await fs.access(metaPath);
          const stash = await Stash.load(entry.name, baseDir);
          stashes.set(entry.name, stash);
        } catch {
          // Not a stash directory, skip
        }
      }
    } catch {
      // Base dir doesn't exist yet
    }

    return new StashManager(stashes, baseDir);
  }

  get(name: string): Stash | undefined {
    return this.stashes.get(name);
  }

  list(): string[] {
    return [...this.stashes.keys()].sort();
  }

  async create(
    name: string,
    provider: SyncProvider | null = null,
    providerType: string | null = null,
    key: string | null = null,
  ): Promise<Stash> {
    if (this.stashes.has(name)) {
      throw new Error(`Stash already exists: ${name}`);
    }
    const stash = Stash.create(name, this.baseDir, provider, providerType, key);
    await stash.save();
    this.stashes.set(name, stash);
    return stash;
  }

  async join(
    key: string,
    localName: string,
    provider: SyncProvider,
  ): Promise<Stash> {
    if (this.stashes.has(localName)) {
      throw new Error(`Stash already exists: ${localName}`);
    }

    // Determine provider type from key
    const providerType = key.split(":")[0];

    // Create empty stash with provider
    const stash = Stash.create(
      localName,
      this.baseDir,
      provider,
      providerType,
      key,
    );

    // Sync to pull remote content
    await stash.sync();

    this.stashes.set(localName, stash);
    return stash;
  }

  async delete(name: string, _deleteRemote: boolean = false): Promise<void> {
    const stash = this.stashes.get(name);
    if (!stash) throw new Error(`Stash not found: ${name}`);

    // Remove from disk
    const stashDir = path.join(this.baseDir, name);
    await fs.rm(stashDir, { recursive: true, force: true });

    this.stashes.delete(name);
  }

  async sync(): Promise<void> {
    const errors: Error[] = [];
    for (const [name, stash] of this.stashes) {
      try {
        await stash.sync();
      } catch (err) {
        errors.push(
          new Error(`Failed to sync ${name}: ${(err as Error).message}`),
        );
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Some stashes failed to sync");
    }
  }
}
