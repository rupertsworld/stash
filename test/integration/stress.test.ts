import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Stash } from "../../src/core/stash.js";
import { StashReconciler } from "../../src/core/reconciler.js";
import { StashManager } from "../../src/core/manager.js";
import type { SyncProvider } from "../../src/providers/types.js";

const TEST_ACTOR_ID = "stress-test-actor";

async function settle(ms = 800): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("Integration: end-to-end workflows", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stash-integration-"));
  });

  afterEach(async () => {
    await settle(200);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("round-trip: write via stash, flush to disk, read back via fresh load", async () => {
    const stash = Stash.create("rt", tmpDir, TEST_ACTOR_ID);
    stash.write("readme.md", "Hello from stash");
    stash.write("src/index.ts", "export default 42;");
    stash.write("docs/guide.md", "# Guide\nStep 1");
    await stash.flush();

    const reconciler = new StashReconciler(stash);
    await reconciler.flush();
    await reconciler.close();

    // Verify files exist on disk
    expect(
      await fs.readFile(path.join(tmpDir, "readme.md"), "utf-8"),
    ).toBe("Hello from stash");
    expect(
      await fs.readFile(path.join(tmpDir, "src", "index.ts"), "utf-8"),
    ).toBe("export default 42;");

    // Load stash from disk
    const loaded = await Stash.load("rt", tmpDir, TEST_ACTOR_ID);
    expect(loaded.read("readme.md")).toBe("Hello from stash");
    expect(loaded.read("src/index.ts")).toBe("export default 42;");
    expect(loaded.read("docs/guide.md")).toBe("# Guide\nStep 1");
  });

  it("manager creates stash, writes files, reconciler flushes to disk", async () => {
    const manager = await StashManager.load(tmpDir);
    const stash = await manager.create("project");
    stash.write("README.md", "# My Project");
    stash.write("src/main.ts", "console.log('hi');");
    await stash.flush();

    const reconciler = new StashReconciler(stash);
    await reconciler.flush();
    await reconciler.close();

    // Reload manager
    const manager2 = await StashManager.load(tmpDir);
    const loaded = manager2.get("project")!;
    expect(loaded.read("README.md")).toBe("# My Project");

    // Also on disk
    const diskContent = await fs.readFile(
      path.join(stash.path, "src", "main.ts"),
      "utf-8",
    );
    expect(diskContent).toBe("console.log('hi');");
  });

  it("disk edit picked up by watcher, persisted to automerge", async () => {
    const stash = Stash.create("watch", tmpDir, TEST_ACTOR_ID);
    stash.write("file.md", "initial");
    await stash.flush();

    const reconciler = new StashReconciler(stash);
    await reconciler.flush();
    await reconciler.start();

    // Edit on disk
    await fs.writeFile(path.join(tmpDir, "file.md"), "edited on disk");
    await settle();

    expect(stash.read("file.md")).toBe("edited on disk");

    // Save and reload to verify persistence
    await stash.save();
    await reconciler.close();

    const loaded = await Stash.load("watch", tmpDir, TEST_ACTOR_ID);
    expect(loaded.read("file.md")).toBe("edited on disk");
  });

  it("multiple stashes with manager, independent reconcilers", async () => {
    const manager = await StashManager.load(tmpDir);
    const stash1 = await manager.create("alpha");
    const stash2 = await manager.create("beta");

    stash1.write("a.md", "alpha content");
    stash2.write("b.md", "beta content");
    await stash1.flush();
    await stash2.flush();

    const r1 = new StashReconciler(stash1);
    const r2 = new StashReconciler(stash2);
    await r1.flush();
    await r2.flush();
    await r1.close();
    await r2.close();

    expect(
      await fs.readFile(path.join(stash1.path, "a.md"), "utf-8"),
    ).toBe("alpha content");
    expect(
      await fs.readFile(path.join(stash2.path, "b.md"), "utf-8"),
    ).toBe("beta content");
  });

  it("sync round-trip with mock provider", async () => {
    const remoteStore = new Map<string, Uint8Array>();

    const mockProvider: SyncProvider = {
      async fetch() {
        return new Map(remoteStore);
      },
      async push(docs, _files) {
        for (const [key, data] of docs) {
          remoteStore.set(key, data);
        }
      },
      async create() {},
      async delete() {},
    };

    const stash = Stash.create(
      "sync-test",
      tmpDir,
      TEST_ACTOR_ID,
      mockProvider,
      "mock:test",
    );
    stash.write("file.md", "synced content");
    await stash.flush();

    await stash.sync();

    // Remote should have the data
    expect(remoteStore.size).toBeGreaterThan(0);

    // Load a fresh stash, sync from remote
    const stash2Path = path.join(tmpDir, "clone");
    const stash2 = Stash.create(
      "sync-test-clone",
      stash2Path,
      "other-actor",
      mockProvider,
      "mock:test",
    );
    stash2.write("file.md", "synced content");
    await stash2.flush();
    await stash2.sync();

    expect(stash2.read("file.md")).toBe("synced content");
  });
});

describe("Stress: many files", { timeout: 30000 }, () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stash-stress-"));
  });

  afterEach(async () => {
    await settle(500);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should handle 50 files written to stash and flushed to disk", async () => {
    const stash = Stash.create("bulk", tmpDir, TEST_ACTOR_ID);

    for (let i = 0; i < 50; i++) {
      stash.write(`file-${i.toString().padStart(3, "0")}.md`, `Content ${i}`);
    }
    await stash.flush();

    const reconciler = new StashReconciler(stash);
    await reconciler.flush();
    await reconciler.close();

    // Verify all files exist on disk
    for (let i = 0; i < 50; i++) {
      const name = `file-${i.toString().padStart(3, "0")}.md`;
      const content = await fs.readFile(
        path.join(tmpDir, name),
        "utf-8",
      );
      expect(content).toBe(`Content ${i}`);
    }

    expect(stash.listAllFiles()).toHaveLength(50);
  });

  it("should handle 20 files created on disk detected by watcher", async () => {
    const stash = Stash.create("watch-bulk", tmpDir, TEST_ACTOR_ID);
    await stash.save();

    const reconciler = new StashReconciler(stash);
    await reconciler.start();

    // Create files on disk
    for (let i = 0; i < 20; i++) {
      await fs.writeFile(
        path.join(tmpDir, `disk-${i.toString().padStart(3, "0")}.md`),
        `Disk content ${i}`,
      );
    }

    // Wait for all events to settle
    await settle(3000);
    await reconciler.close();

    const allFiles = stash.listAllFiles();
    expect(allFiles.length).toBe(20);

    for (let i = 0; i < 20; i++) {
      const name = `disk-${i.toString().padStart(3, "0")}.md`;
      expect(stash.read(name)).toBe(`Disk content ${i}`);
    }
  });

  it("should handle rapid sequential edits to same file", async () => {
    const stash = Stash.create("rapid", tmpDir, TEST_ACTOR_ID);
    stash.write("counter.md", "0");
    await stash.flush();

    const reconciler = new StashReconciler(stash);
    await reconciler.flush();
    await reconciler.start();

    for (let i = 1; i <= 20; i++) {
      await fs.writeFile(path.join(tmpDir, "counter.md"), String(i));
      await settle(100);
    }
    await settle(1000);
    await reconciler.close();

    const finalContent = stash.read("counter.md");
    expect(finalContent).toBe("20");
  });

  it("should handle files in deeply nested directories", async () => {
    const stash = Stash.create("deep", tmpDir, TEST_ACTOR_ID);

    for (let depth = 1; depth <= 5; depth++) {
      const segments = Array.from({ length: depth }, (_, i) => `d${i}`);
      const filePath = [...segments, "file.md"].join("/");
      stash.write(filePath, `Depth ${depth}`);
    }
    await stash.flush();

    const reconciler = new StashReconciler(stash);
    await reconciler.flush();
    await reconciler.close();

    const deepPath = path.join(tmpDir, "d0", "d1", "d2", "d3", "d4", "file.md");
    const content = await fs.readFile(deepPath, "utf-8");
    expect(content).toBe("Depth 5");

    const loaded = await Stash.load("deep", tmpDir, TEST_ACTOR_ID);
    expect(loaded.read("d0/d1/d2/d3/d4/file.md")).toBe("Depth 5");
  });

  it("should handle large file content", async () => {
    const stash = Stash.create("large", tmpDir, TEST_ACTOR_ID);

    const largeContent = "x".repeat(100_000);
    stash.write("large.md", largeContent);
    await stash.flush();

    const reconciler = new StashReconciler(stash);
    await reconciler.flush();
    await reconciler.close();

    const diskContent = await fs.readFile(
      path.join(tmpDir, "large.md"),
      "utf-8",
    );
    expect(diskContent.length).toBe(100_000);

    const loaded = await Stash.load("large", tmpDir, TEST_ACTOR_ID);
    expect(loaded.read("large.md").length).toBe(100_000);
  });
});

describe("Stress: concurrent operations", { timeout: 15000 }, () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stash-concurrent-"));
  });

  afterEach(async () => {
    await settle(500);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should handle interleaved create and delete", async () => {
    const stash = Stash.create("churn", tmpDir, TEST_ACTOR_ID);
    await stash.save();

    const reconciler = new StashReconciler(stash);
    await reconciler.start();

    // Create files
    for (let i = 0; i < 10; i++) {
      await fs.writeFile(path.join(tmpDir, `file${i}.md`), `content ${i}`);
    }
    await settle(1000);

    // Delete half
    for (let i = 0; i < 10; i += 2) {
      await fs.unlink(path.join(tmpDir, `file${i}.md`));
    }
    // 500ms delete debounce + settle
    await settle(1500);

    await reconciler.close();

    const files = stash.listAllFiles().map(([p]) => p).sort();
    expect(files).toEqual([
      "file1.md",
      "file3.md",
      "file5.md",
      "file7.md",
      "file9.md",
    ]);
  });

  it("should survive flush during active watching", async () => {
    const stash = Stash.create("flush-watch", tmpDir, TEST_ACTOR_ID);
    stash.write("initial.md", "v1");
    await stash.flush();

    const reconciler = new StashReconciler(stash);
    await reconciler.flush();
    await reconciler.start();

    // Create a new file on disk while watching
    await fs.writeFile(path.join(tmpDir, "external.md"), "external");
    await settle();

    // Flush should not corrupt state
    stash.write("initial.md", "v2");
    await stash.flush();
    await reconciler.flush();

    await reconciler.close();

    expect(stash.read("initial.md")).toBe("v2");
    expect(stash.read("external.md")).toBe("external");
  });

  it("should handle save/load cycle under concurrent mutations", async () => {
    const stash = Stash.create("saveload", tmpDir, TEST_ACTOR_ID);
    stash.write("a.md", "alpha");
    stash.write("b.md", "beta");
    await stash.flush();

    for (let i = 0; i < 10; i++) {
      stash.write("a.md", `alpha-v${i}`);
      await stash.flush();
    }

    const loaded = await Stash.load("saveload", tmpDir, TEST_ACTOR_ID);
    expect(loaded.read("a.md")).toBe("alpha-v9");
    expect(loaded.read("b.md")).toBe("beta");
  });
});
