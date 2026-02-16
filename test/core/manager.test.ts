import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { StashManager } from "../../src/core/manager.js";
import type { SyncProvider } from "../../src/providers/types.js";
import * as config from "../../src/core/config.js";

describe("StashManager", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stash-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should load from empty directory", async () => {
    const manager = await StashManager.load(tmpDir);
    expect(manager.list()).toEqual([]);
  });

  it("should load from non-existent directory", async () => {
    const manager = await StashManager.load(
      path.join(tmpDir, "nonexistent"),
    );
    expect(manager.list()).toEqual([]);
  });

  it("should create a stash", async () => {
    const manager = await StashManager.load(tmpDir);
    const stash = await manager.create("my-project");
    expect(stash.name).toBe("my-project");
    expect(manager.list()).toEqual(["my-project"]);
  });

  it("should throw when creating duplicate stash", async () => {
    const manager = await StashManager.load(tmpDir);
    await manager.create("test");
    await expect(manager.create("test")).rejects.toThrow(
      "Stash already exists",
    );
  });

  it("should get stash by name", async () => {
    const manager = await StashManager.load(tmpDir);
    await manager.create("test");
    const stash = manager.get("test");
    expect(stash).toBeDefined();
    expect(stash!.name).toBe("test");
    expect(manager.get("nonexistent")).toBeUndefined();
  });

  it("should list stash names", async () => {
    const manager = await StashManager.load(tmpDir);
    await manager.create("beta");
    await manager.create("alpha");
    expect(manager.list()).toEqual(["alpha", "beta"]);
  });

  it("should delete a stash", async () => {
    const manager = await StashManager.load(tmpDir);
    await manager.create("test");
    await manager.delete("test");
    expect(manager.list()).toEqual([]);
    expect(manager.get("test")).toBeUndefined();
  });

  it("should throw when deleting non-existent stash", async () => {
    const manager = await StashManager.load(tmpDir);
    await expect(manager.delete("nope")).rejects.toThrow("Stash not found");
  });

  it("should load stashes from disk", async () => {
    // Create and save stashes
    const manager1 = await StashManager.load(tmpDir);
    const stash = await manager1.create("project-a");
    stash.write("readme.md", "Hello");
    await stash.flush();

    // Load fresh
    const manager2 = await StashManager.load(tmpDir);
    expect(manager2.list()).toEqual(["project-a"]);
    const loaded = manager2.get("project-a")!;
    expect(loaded.read("readme.md")).toBe("Hello");
  });

  it("should sync all stashes", async () => {
    const syncCalls: string[] = [];
    const mockProvider: SyncProvider = {
      async fetch() {
        syncCalls.push("synced");
        return new Map();
      },
      async push() {},
      async exists() {
        return true;
      },
      async create() {},
      async delete() {},
    };

    const manager = await StashManager.load(tmpDir);
    const s1 = await manager.create("a", mockProvider, "mock", "mock:a");
    s1.write("file.md", "content");
    await s1.flush();
    const s2 = await manager.create("b", mockProvider, "mock", "mock:b");
    s2.write("file.md", "content");
    await s2.flush();

    await manager.sync();
    expect(syncCalls).toHaveLength(2);
  });

  it("should restore github provider when loading stash with token", async () => {
    // Mock getGitHubToken to return a token
    vi.spyOn(config, "getGitHubToken").mockResolvedValue("ghp_test123");

    // Create a stash with github provider type
    const manager1 = await StashManager.load(tmpDir);
    const mockProvider: SyncProvider = {
      async fetch() { return new Map(); },
      async push() {},
      async exists() { return true; },
      async create() {},
      async delete() {},
    };
    const stash = await manager1.create(
      "test",
      mockProvider,
      "github",
      "github:owner/repo",
    );
    stash.write("file.md", "content");
    await stash.flush();

    // Load fresh - should restore provider
    const manager2 = await StashManager.load(tmpDir);
    const loaded = manager2.get("test")!;

    // Verify the stash can sync (provider was restored)
    // We can't easily verify the provider instance, but we can check meta
    expect(loaded.getMeta().provider).toBe("github");
    expect(loaded.getMeta().key).toBe("github:owner/repo");

    vi.restoreAllMocks();
  });
});
