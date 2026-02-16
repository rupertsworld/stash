import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
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
import { GitHubProvider, parseGitHubRemote } from "../providers/github.js";

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
            const parsed = parseGitHubRemote(meta.remote);
            if (parsed) {
              const token = await getGitHubToken(baseDir);
              if (token) {
                provider = new GitHubProvider(token, parsed.owner, parsed.repo, parsed.pathPrefix);
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

    // Import existing files if folder exists
    await this.importExistingFiles(stash, resolvedPath);

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

  private async importExistingFiles(
    stash: Stash,
    rootPath: string,
  ): Promise<void> {
    try {
      await fs.access(rootPath);
    } catch {
      // Folder doesn't exist yet, nothing to import
      return;
    }

    const files = await this.walkDirectory(rootPath);

    for (const relativePath of files) {
      const fullPath = path.join(rootPath, relativePath);
      const content = await fs.readFile(fullPath);

      if (this.isUtf8(content)) {
        stash.write(relativePath, content.toString("utf-8"));
      } else {
        // Binary file - store hash and blob
        const hash = this.hashBuffer(content);
        const size = content.length;
        await this.storeBinaryBlob(rootPath, hash, content);
        stash.writeBinary(relativePath, hash, size);
      }
    }
  }

  private async walkDirectory(
    rootPath: string,
    relativePath: string = "",
  ): Promise<string[]> {
    const results: string[] = [];
    const fullPath = relativePath
      ? path.join(rootPath, relativePath)
      : rootPath;

    let entries;
    try {
      entries = await fs.readdir(fullPath, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const entry of entries) {
      // Skip .stash directory and hidden files
      if (entry.name === ".stash" || entry.name.startsWith(".")) continue;

      const childRelative = relativePath
        ? `${relativePath}/${entry.name}`
        : entry.name;

      if (entry.isDirectory()) {
        const subFiles = await this.walkDirectory(rootPath, childRelative);
        results.push(...subFiles);
      } else if (entry.isFile()) {
        results.push(childRelative);
      }
      // Skip symlinks (isFile() returns false for symlinks)
    }

    return results;
  }

  private isUtf8(buffer: Buffer): boolean {
    try {
      const text = buffer.toString("utf-8");
      return !text.includes("\uFFFD");
    } catch {
      return false;
    }
  }

  private hashBuffer(buffer: Buffer): string {
    return crypto.createHash("sha256").update(buffer).digest("hex");
  }

  private async storeBinaryBlob(
    rootPath: string,
    hash: string,
    content: Buffer,
  ): Promise<void> {
    const blobDir = path.join(rootPath, ".stash", "blobs");
    await fs.mkdir(blobDir, { recursive: true });
    const blobPath = path.join(blobDir, `${hash}.bin`);
    await fs.writeFile(blobPath, content);
  }
}
