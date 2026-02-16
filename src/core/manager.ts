import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Stash, type StashMeta } from "./stash.js";
import {
  DEFAULT_STASH_DIR,
  ensureConfig,
  getGitHubToken,
  registerStash,
  unregisterStash,
  type GlobalConfig,
} from "./config.js";
import type { SyncProvider } from "../providers/types.js";
import { GitHubProvider } from "../providers/github.js";

export class StashManager {
  private stashes: Map<string, Stash>;
  private config: GlobalConfig;
  private baseDir: string;

  constructor(
    stashes: Map<string, Stash>,
    config: GlobalConfig,
    baseDir: string,
  ) {
    this.stashes = stashes;
    this.config = config;
    this.baseDir = baseDir;
  }

  static async load(
    baseDir: string = DEFAULT_STASH_DIR,
  ): Promise<StashManager> {
    const config = await ensureConfig(baseDir);
    const stashes = new Map<string, Stash>();

    for (const [name, stashPath] of Object.entries(config.stashes)) {
      try {
        // Determine provider from meta
        let provider: SyncProvider | null = null;
        try {
          const metaData = await fs.readFile(
            path.join(stashPath, ".stash", "meta.json"),
            "utf-8",
          );
          const meta: StashMeta = JSON.parse(metaData);

          if (meta.remote) {
            const [providerType, ...rest] = meta.remote.split(":");
            const repoPath = rest.join(":");
            if (providerType === "github" && repoPath) {
              const token = await getGitHubToken(baseDir);
              if (token) {
                const [owner, repo] = repoPath.split("/");
                provider = new GitHubProvider(token, owner, repo);
              }
            }
          }
        } catch {
          // Meta might not exist yet
        }

        const stash = await Stash.load(name, stashPath, config.actorId, provider);
        stashes.set(name, stash);
      } catch (err) {
        console.warn(`Failed to load stash ${name}: ${(err as Error).message}`);
      }
    }

    return new StashManager(stashes, config, baseDir);
  }

  get(name: string): Stash | undefined {
    return this.stashes.get(name);
  }

  async reload(): Promise<void> {
    const fresh = await StashManager.load(this.baseDir);
    this.stashes = fresh.stashes;
    this.config = fresh.config;
  }

  list(): string[] {
    return [...this.stashes.keys()].sort();
  }

  getStashes(): Map<string, Stash> {
    return this.stashes;
  }

  getConfig(): GlobalConfig {
    return this.config;
  }

  async create(
    name: string,
    stashPath?: string,
    provider: SyncProvider | null = null,
    remote: string | null = null,
    description?: string,
  ): Promise<Stash> {
    if (this.stashes.has(name)) {
      throw new Error(`Stash already exists: ${name}`);
    }

    const resolvedPath = stashPath
      ? path.resolve(stashPath)
      : path.join(this.baseDir, name);

    const stash = Stash.create(
      name,
      resolvedPath,
      this.config.actorId,
      provider,
      remote,
      description,
    );
    await stash.save();

    // Register in global config
    await registerStash(name, resolvedPath, this.baseDir);
    this.config.stashes[name] = resolvedPath;

    this.stashes.set(name, stash);
    return stash;
  }

  async connect(
    key: string,
    localName: string,
    provider: SyncProvider,
    stashPath?: string,
    description?: string,
  ): Promise<Stash> {
    if (this.stashes.has(localName)) {
      throw new Error(`Stash already exists: ${localName}`);
    }

    const resolvedPath = stashPath
      ? path.resolve(stashPath)
      : path.join(this.baseDir, localName);

    const stash = Stash.create(
      localName,
      resolvedPath,
      this.config.actorId,
      provider,
      key,
      description,
    );

    // Sync to pull remote content
    await stash.sync();

    // Register in global config
    await registerStash(localName, resolvedPath, this.baseDir);
    this.config.stashes[localName] = resolvedPath;

    this.stashes.set(localName, stash);
    return stash;
  }

  async delete(name: string, deleteRemote: boolean = false): Promise<void> {
    const stash = this.stashes.get(name);
    if (!stash) throw new Error(`Stash not found: ${name}`);

    if (deleteRemote) {
      const provider = stash.getProvider();
      if (provider) {
        await provider.delete();
      }
    }

    // Remove from disk
    await fs.rm(stash.path, { recursive: true, force: true });

    // Unregister from global config
    await unregisterStash(name, this.baseDir);
    delete this.config.stashes[name];

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
