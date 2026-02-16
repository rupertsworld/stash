import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as Automerge from "@automerge/automerge";
import { Stash } from "../../src/core/stash.js";
import type { SyncProvider } from "../../src/providers/types.js";

const TEST_ACTOR_ID = "test-actor-id";

describe("Stash", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stash-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should create a new stash", () => {
    const stash = Stash.create("test-stash", tmpDir, TEST_ACTOR_ID);
    expect(stash.name).toBe("test-stash");
    expect(stash.path).toBe(tmpDir);
    expect(stash.list()).toEqual([]);
  });

  it("should write and read a file", async () => {
    const stash = Stash.create("test", tmpDir, TEST_ACTOR_ID);
    stash.write("hello.md", "Hello, world!");
    expect(stash.read("hello.md")).toBe("Hello, world!");
    await stash.flush();
  });

  it("should overwrite file content", async () => {
    const stash = Stash.create("test", tmpDir, TEST_ACTOR_ID);
    stash.write("file.md", "original");
    stash.write("file.md", "updated");
    expect(stash.read("file.md")).toBe("updated");
    await stash.flush();
  });

  it("should throw when reading non-existent file", () => {
    const stash = Stash.create("test", tmpDir, TEST_ACTOR_ID);
    expect(() => stash.read("nope.md")).toThrow("File not found");
  });

  it("should patch a file", async () => {
    const stash = Stash.create("test", tmpDir, TEST_ACTOR_ID);
    stash.write("file.md", "Hello world");
    stash.patch("file.md", 5, 5, ",");
    expect(stash.read("file.md")).toBe("Hello, world");
    await stash.flush();
  });

  it("should throw when patching non-existent file", () => {
    const stash = Stash.create("test", tmpDir, TEST_ACTOR_ID);
    expect(() => stash.patch("nope.md", 0, 0, "text")).toThrow(
      "File not found",
    );
  });

  it("should delete a file", async () => {
    const stash = Stash.create("test", tmpDir, TEST_ACTOR_ID);
    stash.write("file.md", "content");
    stash.delete("file.md");
    expect(() => stash.read("file.md")).toThrow("File not found");
    expect(stash.list()).toEqual([]);
    await stash.flush();
  });

  it("should throw when deleting non-existent file", () => {
    const stash = Stash.create("test", tmpDir, TEST_ACTOR_ID);
    expect(() => stash.delete("nope.md")).toThrow("File not found");
  });

  it("should move a file preserving content", async () => {
    const stash = Stash.create("test", tmpDir, TEST_ACTOR_ID);
    stash.write("old.md", "content here");
    stash.move("old.md", "new.md");
    expect(stash.read("new.md")).toBe("content here");
    expect(() => stash.read("old.md")).toThrow("File not found");
    await stash.flush();
  });

  it("should list files in root", async () => {
    const stash = Stash.create("test", tmpDir, TEST_ACTOR_ID);
    stash.write("a.md", "a");
    stash.write("b.md", "b");
    stash.write("docs/c.md", "c");
    const items = stash.list();
    expect(items).toContain("a.md");
    expect(items).toContain("b.md");
    expect(items).toContain("docs/");
    expect(items).toHaveLength(3);
    await stash.flush();
  });

  it("should list files in a subdirectory", async () => {
    const stash = Stash.create("test", tmpDir, TEST_ACTOR_ID);
    stash.write("docs/a.md", "a");
    stash.write("docs/b.md", "b");
    stash.write("docs/sub/c.md", "c");
    const items = stash.list("docs");
    expect(items).toContain("a.md");
    expect(items).toContain("b.md");
    expect(items).toContain("sub/");
    expect(items).toHaveLength(3);
    await stash.flush();
  });

  it("should return empty list for empty directory", () => {
    const stash = Stash.create("test", tmpDir, TEST_ACTOR_ID);
    expect(stash.list("nonexistent")).toEqual([]);
  });

  it("should glob files", async () => {
    const stash = Stash.create("test", tmpDir, TEST_ACTOR_ID);
    stash.write("readme.md", "r");
    stash.write("docs/guide.md", "g");
    stash.write("docs/api/auth.md", "a");
    stash.write("src/index.ts", "i");

    expect(stash.glob("**/*.md")).toEqual([
      "docs/api/auth.md",
      "docs/guide.md",
      "readme.md",
    ]);
    expect(stash.glob("docs/*.md")).toEqual(["docs/guide.md"]);
    expect(stash.glob("**/*.ts")).toEqual(["src/index.ts"]);
    await stash.flush();
  });

  it("should save and load from disk", async () => {
    const stash = Stash.create("test", tmpDir, TEST_ACTOR_ID);
    stash.write("hello.md", "Hello!");
    stash.write("docs/notes.md", "Notes");
    await stash.flush();

    const loaded = await Stash.load("test", tmpDir, TEST_ACTOR_ID);
    expect(loaded.read("hello.md")).toBe("Hello!");
    expect(loaded.read("docs/notes.md")).toBe("Notes");
    expect(loaded.list()).toEqual(["docs/", "hello.md"]);
  });

  it("should sync with a provider", async () => {
    let stored = new Map<string, Uint8Array>();
    const mockProvider: SyncProvider = {
      async fetch() {
        return new Map(stored);
      },
      async push(docs, _files) {
        stored = new Map(docs);
      },
      async create() {},
      async delete() {},
    };

    const stash = Stash.create(
      "test",
      tmpDir,
      TEST_ACTOR_ID,
      mockProvider,
      "mock:test",
    );
    stash.write("file.md", "content");
    await stash.flush();
    await stash.sync();

    expect(stash.read("file.md")).toBe("content");
  });

  it("should handle dangling refs during sync", async () => {
    const warnSpy: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnSpy.push(msg);

    let stored = new Map<string, Uint8Array>();
    const mockProvider: SyncProvider = {
      async fetch() {
        return new Map(stored);
      },
      async push(docs, _files) {
        stored = new Map(docs);
      },
      async create() {},
      async delete() {},
    };

    const stash = Stash.create(
      "test",
      tmpDir,
      TEST_ACTOR_ID,
      mockProvider,
      "mock:test",
    );
    stash.write("file.md", "content");
    await stash.flush();

    await stash.sync();
    console.warn = origWarn;

    expect(stash.read("file.md")).toBe("content");
  });

  it("should get meta info", () => {
    const stash = Stash.create(
      "test",
      tmpDir,
      TEST_ACTOR_ID,
      null,
      "github:owner/repo",
    );
    const meta = stash.getMeta();
    expect(meta.name).toBe("test");
    expect(meta.remote).toBe("github:owner/repo");
  });

  it("should list all files with doc IDs", async () => {
    const stash = Stash.create("test", tmpDir, TEST_ACTOR_ID);
    stash.write("a.md", "content a");
    stash.write("b.md", "content b");
    await stash.flush();

    const files = stash.listAllFiles();
    expect(files).toHaveLength(2);
    expect(files.map(([p]) => p).sort()).toEqual(["a.md", "b.md"]);
    // Each entry should have a docId
    for (const [, docId] of files) {
      expect(docId).toBeTruthy();
    }
  });

  it("should get and set meta", () => {
    const stash = Stash.create("test", tmpDir, TEST_ACTOR_ID);
    stash.setMeta({ description: "My test stash" });
    expect(stash.getMeta().description).toBe("My test stash");
  });

  describe("auto-save and sync", () => {
    it("should persist to disk after write", async () => {
      const stash = Stash.create("test", tmpDir, TEST_ACTOR_ID);
      stash.write("file.md", "content");
      await stash.flush();

      const loaded = await Stash.load("test", tmpDir, TEST_ACTOR_ID);
      expect(loaded.read("file.md")).toBe("content");
    });

    it("should persist to disk after patch", async () => {
      const stash = Stash.create("test", tmpDir, TEST_ACTOR_ID);
      stash.write("file.md", "hello world");
      await stash.flush();

      stash.patch("file.md", 5, 5, ",");
      await stash.flush();

      const loaded = await Stash.load("test", tmpDir, TEST_ACTOR_ID);
      expect(loaded.read("file.md")).toBe("hello, world");
    });

    it("should persist to disk after delete", async () => {
      const stash = Stash.create("test", tmpDir, TEST_ACTOR_ID);
      stash.write("file.md", "content");
      await stash.flush();

      stash.delete("file.md");
      await stash.flush();

      const loaded = await Stash.load("test", tmpDir, TEST_ACTOR_ID);
      expect(loaded.list()).toEqual([]);
    });

    it("should persist to disk after move", async () => {
      const stash = Stash.create("test", tmpDir, TEST_ACTOR_ID);
      stash.write("old.md", "content");
      await stash.flush();

      stash.move("old.md", "new.md");
      await stash.flush();

      const loaded = await Stash.load("test", tmpDir, TEST_ACTOR_ID);
      expect(loaded.read("new.md")).toBe("content");
      expect(() => loaded.read("old.md")).toThrow("File not found");
    });

    it("should schedule sync after mutation", async () => {
      let syncCalled = false;
      const mockProvider: SyncProvider = {
        async fetch() {
          syncCalled = true;
          return new Map();
        },
        async push(_docs, _files) {},
        async create() {},
        async delete() {},
      };

      const stash = Stash.create(
        "test",
        tmpDir,
        TEST_ACTOR_ID,
        mockProvider,
        "mock:test",
      );
      stash.write("file.md", "content");
      await stash.flush();

      expect(syncCalled).toBe(false);

      // Wait for debounce + sync
      await new Promise((r) => setTimeout(r, 2500));
      expect(syncCalled).toBe(true);
    });

    it("should report isSyncing() during sync", async () => {
      let resolveFetch: () => void;
      const fetchPromise = new Promise<void>((r) => {
        resolveFetch = r;
      });

      const mockProvider: SyncProvider = {
        async fetch() {
          await fetchPromise;
          return new Map();
        },
        async push(_docs, _files) {},
        async create() {},
        async delete() {},
      };

      const stash = Stash.create(
        "test",
        tmpDir,
        TEST_ACTOR_ID,
        mockProvider,
        "mock:test",
      );
      stash.write("file.md", "content");
      await stash.flush();

      expect(stash.isSyncing()).toBe(false);

      const syncOp = stash.sync();
      await new Promise((r) => setTimeout(r, 10));

      expect(stash.isSyncing()).toBe(true);

      resolveFetch!();
      await syncOp;

      expect(stash.isSyncing()).toBe(false);
    });

    it("should skip concurrent sync calls", async () => {
      let syncCount = 0;
      let resolveFetch: () => void;
      const fetchPromise = new Promise<void>((r) => {
        resolveFetch = r;
      });

      const mockProvider: SyncProvider = {
        async fetch() {
          syncCount++;
          await fetchPromise;
          return new Map();
        },
        async push(_docs, _files) {},
        async create() {},
        async delete() {},
      };

      const stash = Stash.create(
        "test",
        tmpDir,
        TEST_ACTOR_ID,
        mockProvider,
        "mock:test",
      );
      stash.write("file.md", "content");
      await stash.flush();

      const sync1 = stash.sync();
      await new Promise((r) => setTimeout(r, 10));

      const sync2 = stash.sync();
      await sync2;

      expect(stash.isSyncing()).toBe(true);
      expect(syncCount).toBe(1);

      resolveFetch!();
      await sync1;

      expect(syncCount).toBe(1);
    });
  });
});
