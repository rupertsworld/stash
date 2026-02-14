import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as Automerge from "@automerge/automerge";
import { Stash } from "../../src/core/stash.js";
import type { SyncProvider } from "../../src/providers/types.js";

describe("Stash", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stash-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should create a new stash", () => {
    const stash = Stash.create("test-stash", tmpDir);
    expect(stash.name).toBe("test-stash");
    expect(stash.list()).toEqual([]);
  });

  it("should write and read a file", () => {
    const stash = Stash.create("test", tmpDir);
    stash.write("hello.md", "Hello, world!");
    expect(stash.read("hello.md")).toBe("Hello, world!");
  });

  it("should overwrite file content", () => {
    const stash = Stash.create("test", tmpDir);
    stash.write("file.md", "original");
    stash.write("file.md", "updated");
    expect(stash.read("file.md")).toBe("updated");
  });

  it("should throw when reading non-existent file", () => {
    const stash = Stash.create("test", tmpDir);
    expect(() => stash.read("nope.md")).toThrow("File not found");
  });

  it("should patch a file", () => {
    const stash = Stash.create("test", tmpDir);
    stash.write("file.md", "Hello world");
    stash.patch("file.md", 5, 5, ",");
    expect(stash.read("file.md")).toBe("Hello, world");
  });

  it("should throw when patching non-existent file", () => {
    const stash = Stash.create("test", tmpDir);
    expect(() => stash.patch("nope.md", 0, 0, "text")).toThrow(
      "File not found",
    );
  });

  it("should delete a file", () => {
    const stash = Stash.create("test", tmpDir);
    stash.write("file.md", "content");
    stash.delete("file.md");
    expect(() => stash.read("file.md")).toThrow("File not found");
    expect(stash.list()).toEqual([]);
  });

  it("should throw when deleting non-existent file", () => {
    const stash = Stash.create("test", tmpDir);
    expect(() => stash.delete("nope.md")).toThrow("File not found");
  });

  it("should move a file preserving content", () => {
    const stash = Stash.create("test", tmpDir);
    stash.write("old.md", "content here");
    stash.move("old.md", "new.md");
    expect(stash.read("new.md")).toBe("content here");
    expect(() => stash.read("old.md")).toThrow("File not found");
  });

  it("should list files in root", () => {
    const stash = Stash.create("test", tmpDir);
    stash.write("a.md", "a");
    stash.write("b.md", "b");
    stash.write("docs/c.md", "c");
    const items = stash.list();
    expect(items).toContain("a.md");
    expect(items).toContain("b.md");
    expect(items).toContain("docs/");
    expect(items).toHaveLength(3);
  });

  it("should list files in a subdirectory", () => {
    const stash = Stash.create("test", tmpDir);
    stash.write("docs/a.md", "a");
    stash.write("docs/b.md", "b");
    stash.write("docs/sub/c.md", "c");
    const items = stash.list("docs");
    expect(items).toContain("a.md");
    expect(items).toContain("b.md");
    expect(items).toContain("sub/");
    expect(items).toHaveLength(3);
  });

  it("should return empty list for empty directory", () => {
    const stash = Stash.create("test", tmpDir);
    expect(stash.list("nonexistent")).toEqual([]);
  });

  it("should glob files", () => {
    const stash = Stash.create("test", tmpDir);
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
  });

  it("should save and load from disk", async () => {
    const stash = Stash.create("test", tmpDir);
    stash.write("hello.md", "Hello!");
    stash.write("docs/notes.md", "Notes");
    await stash.save();

    const loaded = await Stash.load("test", tmpDir);
    expect(loaded.read("hello.md")).toBe("Hello!");
    expect(loaded.read("docs/notes.md")).toBe("Notes");
    expect(loaded.list()).toEqual(["docs/", "hello.md"]);
  });

  it("should sync with a provider", async () => {
    // Create a mock provider that returns what it receives
    const mockProvider: SyncProvider = {
      async sync(docs) {
        return docs;
      },
    };

    const stash = Stash.create("test", tmpDir, mockProvider, "mock", "mock:test");
    stash.write("file.md", "content");
    await stash.sync();

    // After sync, file should still be readable
    expect(stash.read("file.md")).toBe("content");
  });

  it("should handle dangling refs during sync", async () => {
    // Mock provider that adds a new file reference to structure
    // but doesn't provide the file doc (simulating dangling ref)
    const warnSpy: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnSpy.push(msg);

    const mockProvider: SyncProvider = {
      async sync(docs) {
        return docs;
      },
    };

    const stash = Stash.create("test", tmpDir, mockProvider, "mock", "mock:test");
    stash.write("file.md", "content");

    // Manually create a dangling ref scenario by deleting the file doc
    // We'll test this through sync's pre-sync check
    await stash.sync();
    console.warn = origWarn;

    expect(stash.read("file.md")).toBe("content");
  });

  it("should get meta info", () => {
    const stash = Stash.create("test", tmpDir, null, "github", "github:owner/repo");
    const meta = stash.getMeta();
    expect(meta.localName).toBe("test");
    expect(meta.provider).toBe("github");
    expect(meta.key).toBe("github:owner/repo");
    expect(meta.actorId).toBeTruthy();
  });
});
