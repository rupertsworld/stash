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

  it("should register stash in global config", async () => {
    const manager = await StashManager.load(tmpDir);
    await manager.create("my-project");
    const cfg = await config.readConfig(tmpDir);
    expect(cfg.stashes["my-project"]).toBeTruthy();
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
    // Should also be removed from global config
    const cfg = await config.readConfig(tmpDir);
    expect(cfg.stashes["test"]).toBeUndefined();
  });

  it("should delete locally when provider has no delete()", async () => {
    const manager = await StashManager.load(tmpDir);
    const provider: SyncProvider = {
      async fetch() {
        return new Map();
      },
      async push() {},
    };

    await manager.create("local-only-delete", undefined, provider, "mock:remote");
    await expect(manager.delete("local-only-delete", true)).resolves.toBeUndefined();
    expect(manager.get("local-only-delete")).toBeUndefined();
  });

  it("should call provider.delete() before local deletion when available", async () => {
    const deleteSpy = vi.fn().mockResolvedValue(undefined);
    const manager = await StashManager.load(tmpDir);
    const provider: SyncProvider = {
      async fetch() {
        return new Map();
      },
      async push() {},
      delete: deleteSpy,
    };

    await manager.create("remote-delete", undefined, provider, "mock:remote");
    await manager.delete("remote-delete", true);

    expect(deleteSpy).toHaveBeenCalledOnce();
    expect(manager.get("remote-delete")).toBeUndefined();
  });

  it("should throw when deleting non-existent stash", async () => {
    const manager = await StashManager.load(tmpDir);
    await expect(manager.delete("nope")).rejects.toThrow("Stash not found");
  });

  it("should load stashes from disk", async () => {
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
      async create() {},
      async delete() {},
    };

    const manager = await StashManager.load(tmpDir);
    const s1 = await manager.create(
      "a",
      undefined,
      mockProvider,
      "mock:a",
    );
    s1.write("file.md", "content");
    await s1.flush();
    const s2 = await manager.create(
      "b",
      undefined,
      mockProvider,
      "mock:b",
    );
    s2.write("file.md", "content");
    await s2.flush();

    await manager.sync();
    expect(syncCalls).toHaveLength(2);
  });

  it("should restore github provider when loading stash with token", async () => {
    vi.spyOn(config, "getGitHubToken").mockResolvedValue("ghp_test123");

    const manager1 = await StashManager.load(tmpDir);
    const mockProvider: SyncProvider = {
      async fetch() {
        return new Map();
      },
      async push() {},
      async create() {},
      async delete() {},
    };
    const stash = await manager1.create(
      "test",
      undefined,
      mockProvider,
      "github:owner/repo",
    );
    stash.write("file.md", "content");
    await stash.flush();

    // Load fresh - should restore provider from meta.remote
    const manager2 = await StashManager.load(tmpDir);
    const loaded = manager2.get("test")!;

    const meta = loaded.getMeta();
    expect(meta.name).toBe("test");
    expect(meta.remote).toBe("github:owner/repo");

    vi.restoreAllMocks();
  });

  it("should create stash at custom path", async () => {
    const manager = await StashManager.load(tmpDir);
    const customPath = path.join(tmpDir, "custom-location");
    const stash = await manager.create("my-stash", customPath);
    expect(stash.path).toBe(customPath);
    expect(stash.name).toBe("my-stash");

    // Verify it's registered in config
    const cfg = await config.readConfig(tmpDir);
    expect(cfg.stashes["my-stash"]).toBe(customPath);
  });

  describe("import existing files", () => {
    it("should import existing text files", async () => {
      const existingDir = path.join(tmpDir, "existing-folder");
      await fs.mkdir(existingDir, { recursive: true });
      await fs.writeFile(path.join(existingDir, "readme.md"), "# Hello");
      await fs.writeFile(path.join(existingDir, "notes.txt"), "Some notes");

      const manager = await StashManager.load(tmpDir);
      const stash = await manager.create("imported", existingDir);
      await stash.flush();

      expect(stash.read("readme.md")).toBe("# Hello");
      expect(stash.read("notes.txt")).toBe("Some notes");
      expect(stash.listAllFiles()).toHaveLength(2);
    });

    it("should import nested directories", async () => {
      const existingDir = path.join(tmpDir, "nested-folder");
      await fs.mkdir(path.join(existingDir, "docs", "api"), { recursive: true });
      await fs.writeFile(path.join(existingDir, "root.md"), "root");
      await fs.writeFile(path.join(existingDir, "docs", "guide.md"), "guide");
      await fs.writeFile(path.join(existingDir, "docs", "api", "ref.md"), "ref");

      const manager = await StashManager.load(tmpDir);
      const stash = await manager.create("nested", existingDir);
      await stash.flush();

      expect(stash.read("root.md")).toBe("root");
      expect(stash.read("docs/guide.md")).toBe("guide");
      expect(stash.read("docs/api/ref.md")).toBe("ref");
      expect(stash.listAllFiles()).toHaveLength(3);
    });

    it("should skip hidden files", async () => {
      const existingDir = path.join(tmpDir, "with-hidden");
      await fs.mkdir(existingDir, { recursive: true });
      await fs.writeFile(path.join(existingDir, "visible.md"), "visible");
      await fs.writeFile(path.join(existingDir, ".hidden"), "hidden");
      await fs.writeFile(path.join(existingDir, ".gitignore"), "*.log");

      const manager = await StashManager.load(tmpDir);
      const stash = await manager.create("no-hidden", existingDir);
      await stash.flush();

      expect(stash.listAllFiles()).toHaveLength(1);
      expect(stash.read("visible.md")).toBe("visible");
    });

    it("should skip .stash directory if it exists", async () => {
      const existingDir = path.join(tmpDir, "has-stash-dir");
      await fs.mkdir(path.join(existingDir, ".stash"), { recursive: true });
      await fs.writeFile(path.join(existingDir, "file.md"), "content");
      await fs.writeFile(path.join(existingDir, ".stash", "junk.txt"), "junk");

      const manager = await StashManager.load(tmpDir);
      // This should work - we import files but ignore existing .stash contents
      const stash = await manager.create("with-stash-dir", existingDir);
      await stash.flush();

      expect(stash.listAllFiles()).toHaveLength(1);
      expect(stash.read("file.md")).toBe("content");
    });

    it("should import binary files", async () => {
      const existingDir = path.join(tmpDir, "with-binary");
      await fs.mkdir(existingDir, { recursive: true });
      await fs.writeFile(path.join(existingDir, "text.md"), "text");
      // Create a binary file (PNG header bytes)
      const binaryContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      await fs.writeFile(path.join(existingDir, "image.png"), binaryContent);

      const manager = await StashManager.load(tmpDir);
      const stash = await manager.create("with-binary", existingDir);
      await stash.flush();

      expect(stash.listAllFiles()).toHaveLength(2);
      expect(stash.read("text.md")).toBe("text");

      // Binary file should be tracked
      const files = stash.listAllFiles();
      const binaryFile = files.find(([p]) => p === "image.png");
      expect(binaryFile).toBeDefined();
    });

    it("should work with empty existing folder", async () => {
      const existingDir = path.join(tmpDir, "empty-folder");
      await fs.mkdir(existingDir, { recursive: true });

      const manager = await StashManager.load(tmpDir);
      const stash = await manager.create("empty", existingDir);
      await stash.flush();

      expect(stash.listAllFiles()).toHaveLength(0);
    });

    it("should work when folder does not exist", async () => {
      const newDir = path.join(tmpDir, "new-folder");

      const manager = await StashManager.load(tmpDir);
      const stash = await manager.create("new", newDir);
      await stash.flush();

      expect(stash.listAllFiles()).toHaveLength(0);
      // Folder should be created
      const stat = await fs.stat(newDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it("should skip symlinks", async () => {
      const existingDir = path.join(tmpDir, "with-symlinks");
      const targetDir = path.join(tmpDir, "symlink-target");
      await fs.mkdir(existingDir, { recursive: true });
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(path.join(existingDir, "real.md"), "real");
      await fs.writeFile(path.join(targetDir, "linked.md"), "linked");
      await fs.symlink(targetDir, path.join(existingDir, "link"));

      const manager = await StashManager.load(tmpDir);
      const stash = await manager.create("no-symlinks", existingDir);
      await stash.flush();

      expect(stash.listAllFiles()).toHaveLength(1);
      expect(stash.read("real.md")).toBe("real");
    });
  });

  describe("reloadIfStale", () => {
    it("should reload on first call", async () => {
      const manager = await StashManager.load(tmpDir);
      await manager.create("test");
      expect(manager.list()).toEqual(["test"]);

      // Delete the stash from manager's view (simulate external change)
      // by creating a second manager and deleting
      const manager2 = await StashManager.load(tmpDir);
      await manager2.delete("test");

      // First manager should still see "test" until reload
      expect(manager.list()).toEqual(["test"]);

      // reloadIfStale should reload on first call
      await manager.reloadIfStale();
      expect(manager.list()).toEqual([]);
    });

    it("should skip reload if called again within threshold", async () => {
      const manager = await StashManager.load(tmpDir);
      await manager.create("test");

      // Force a reload
      await manager.reloadIfStale();
      expect(manager.list()).toEqual(["test"]);

      // Create another stash via second manager
      const manager2 = await StashManager.load(tmpDir);
      await manager2.create("other");

      // Second call within threshold should skip reload
      await manager.reloadIfStale();
      expect(manager.list()).toEqual(["test"]); // Should not see "other" yet

      // Wait for threshold and reload again
      await new Promise(r => setTimeout(r, 2100));
      await manager.reloadIfStale();
      expect(manager.list()).toContain("other");
    });
  });

  describe("name validation", () => {
    it("should accept valid names", async () => {
      const manager = await StashManager.load(tmpDir);

      await expect(manager.create("my-stash")).resolves.toBeDefined();
      await expect(manager.create("stash.v2")).resolves.toBeDefined();
      await expect(manager.create("Notes_2026")).resolves.toBeDefined();
      await expect(manager.create("a")).resolves.toBeDefined();
      await expect(manager.create("A1")).resolves.toBeDefined();
    });

    it("should reject path traversal attempts", async () => {
      const manager = await StashManager.load(tmpDir);

      await expect(manager.create("../etc")).rejects.toThrow();
      await expect(manager.create("foo/bar")).rejects.toThrow();
      await expect(manager.create("..")).rejects.toThrow();
      await expect(manager.create("foo/../bar")).rejects.toThrow();
    });

    it("should reject hidden names (starting with dot)", async () => {
      const manager = await StashManager.load(tmpDir);

      await expect(manager.create(".hidden")).rejects.toThrow();
      await expect(manager.create(".")).rejects.toThrow();
    });

    it("should reject names starting with dash", async () => {
      const manager = await StashManager.load(tmpDir);

      await expect(manager.create("-dash")).rejects.toThrow();
    });

    it("should reject empty names", async () => {
      const manager = await StashManager.load(tmpDir);

      await expect(manager.create("")).rejects.toThrow();
    });

    it("should reject overly long names", async () => {
      const manager = await StashManager.load(tmpDir);
      const longName = "a".repeat(65);

      await expect(manager.create(longName)).rejects.toThrow();
    });
  });
});
