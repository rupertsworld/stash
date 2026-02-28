import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Stash } from "../../src/core/stash.js";
import { StashReconciler } from "../../src/core/reconciler.js";

const TEST_ACTOR_ID = "test-actor-id";

async function settle(ms = 1200): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("StashReconciler", { timeout: 15000 }, () => {
  let tmpDir: string;
  let stash: Stash;
  let reconciler: StashReconciler;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "reconciler-test-"));
    stash = Stash.create("test", tmpDir, TEST_ACTOR_ID);
    // Ensure .stash/ directory exists on disk before any operations
    await stash.save();
    reconciler = new StashReconciler(stash);
  });

  afterEach(async () => {
    await reconciler.close();
    await settle(200);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("flush", () => {
    it("should write automerge text files to disk", async () => {
      stash.write("hello.md", "Hello, world!");
      await stash.flush();
      await reconciler.flush();

      const content = await fs.readFile(
        path.join(tmpDir, "hello.md"),
        "utf-8",
      );
      expect(content).toBe("Hello, world!");
    });

    it("should write files in subdirectories", async () => {
      stash.write("docs/guide.md", "Guide content");
      stash.write("docs/api/ref.md", "API ref");
      await stash.flush();
      await reconciler.flush();

      const guide = await fs.readFile(
        path.join(tmpDir, "docs", "guide.md"),
        "utf-8",
      );
      expect(guide).toBe("Guide content");

      const ref = await fs.readFile(
        path.join(tmpDir, "docs", "api", "ref.md"),
        "utf-8",
      );
      expect(ref).toBe("API ref");
    });

    it("should not rewrite file if content matches disk", async () => {
      stash.write("file.md", "unchanged");
      await stash.flush();
      await reconciler.flush();

      const stat1 = await fs.stat(path.join(tmpDir, "file.md"));

      await settle(50);
      await reconciler.flush();

      const stat2 = await fs.stat(path.join(tmpDir, "file.md"));
      expect(stat2.mtimeMs).toBe(stat1.mtimeMs);
    });

    it("should overwrite disk when automerge content differs", async () => {
      stash.write("file.md", "v1");
      await stash.flush();
      await reconciler.flush();

      stash.write("file.md", "v2");
      await stash.flush();
      await reconciler.flush();

      const content = await fs.readFile(
        path.join(tmpDir, "file.md"),
        "utf-8",
      );
      expect(content).toBe("v2");
    });

    it("should import untracked files from disk during flush (filesystem-first)", async () => {
      stash.write("keep.md", "keep");
      await stash.flush();
      await reconciler.flush();

      // Create a new file on disk that isn't tracked
      await fs.writeFile(path.join(tmpDir, "new.md"), "new content");

      await reconciler.flush();

      // With filesystem-first, the file should be imported, not deleted
      const newContent = await fs.readFile(
        path.join(tmpDir, "new.md"),
        "utf-8",
      );
      expect(newContent).toBe("new content");
      expect(stash.read("new.md")).toBe("new content");
      const keep = await fs.readFile(
        path.join(tmpDir, "keep.md"),
        "utf-8",
      );
      expect(keep).toBe("keep");
    });

    it("should delete known tombstoned files during flush", async () => {
      // Create file via automerge, flush to disk
      stash.write("toDelete.md", "will be deleted");
      await stash.flush();
      await reconciler.flush();

      // Delete via automerge (creates tombstone)
      stash.delete("toDelete.md");
      await stash.flush();
      await reconciler.flush();

      // File should be removed from disk
      await expect(
        fs.access(path.join(tmpDir, "toDelete.md")),
      ).rejects.toThrow();
    });

    it("should skip .stash directory during orphan cleanup", async () => {
      stash.write("file.md", "content");
      await stash.flush();
      await reconciler.flush();

      const stashDir = await fs.stat(path.join(tmpDir, ".stash"));
      expect(stashDir.isDirectory()).toBe(true);
    });
  });

  describe("file watching - creation", () => {
    it("should detect new text file created on disk", async () => {
      await reconciler.start();

      await fs.writeFile(path.join(tmpDir, "new.md"), "new content");
      await settle();

      expect(stash.read("new.md")).toBe("new content");
    });

    it("should detect new file in subdirectory", async () => {
      await reconciler.start();

      await fs.mkdir(path.join(tmpDir, "docs"), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, "docs", "new.md"),
        "sub content",
      );
      await settle();

      expect(stash.read("docs/new.md")).toBe("sub content");
    });
  });

  describe("file watching - modification", () => {
    it("should detect text file modification", async () => {
      stash.write("file.md", "original");
      await stash.flush();
      await reconciler.flush();
      await reconciler.start();

      await fs.writeFile(path.join(tmpDir, "file.md"), "modified");
      await settle();

      expect(stash.read("file.md")).toBe("modified");
    });

    it("should preserve automerge history through edits", async () => {
      stash.write("file.md", "hello world");
      await stash.flush();
      await reconciler.flush();
      await reconciler.start();

      await fs.writeFile(path.join(tmpDir, "file.md"), "hello, world!");
      await settle();

      expect(stash.read("file.md")).toBe("hello, world!");
    });
  });

  describe("file watching - deletion", () => {
    it("should detect file deletion", async () => {
      stash.write("file.md", "content");
      await stash.flush();
      await reconciler.flush();
      await reconciler.start();

      await fs.unlink(path.join(tmpDir, "file.md"));
      // 500ms delete debounce + processing time
      await settle(1200);

      expect(stash.list()).toEqual([]);
    });

    it("should remove empty parent directory after file deletion", async () => {
      stash.write("docs/guide.md", "content");
      await stash.flush();
      await reconciler.flush();
      await reconciler.start();

      // Verify directory exists
      const docsDir = path.join(tmpDir, "docs");
      await expect(fs.access(docsDir)).resolves.toBeUndefined();

      // Delete the only file
      await fs.unlink(path.join(tmpDir, "docs/guide.md"));
      await settle(1200);

      // Directory should be removed
      await expect(fs.access(docsDir)).rejects.toThrow();
    });

    it("should remove nested empty directories after file deletion", async () => {
      stash.write("a/b/c/deep.md", "content");
      await stash.flush();
      await reconciler.flush();
      await reconciler.start();

      // Delete the file
      await fs.unlink(path.join(tmpDir, "a/b/c/deep.md"));
      await settle(1200);

      // All empty parent dirs should be removed
      await expect(fs.access(path.join(tmpDir, "a/b/c"))).rejects.toThrow();
      await expect(fs.access(path.join(tmpDir, "a/b"))).rejects.toThrow();
      await expect(fs.access(path.join(tmpDir, "a"))).rejects.toThrow();
    });

    it("should not remove directory if other files remain", async () => {
      stash.write("docs/guide.md", "guide");
      stash.write("docs/api.md", "api");
      await stash.flush();
      await reconciler.flush();
      await reconciler.start();

      // Delete one file
      await fs.unlink(path.join(tmpDir, "docs/guide.md"));
      await settle(1200);

      // Directory should still exist (api.md is still there)
      const docsDir = path.join(tmpDir, "docs");
      await expect(fs.access(docsDir)).resolves.toBeUndefined();

      // Other file should still exist
      const content = await fs.readFile(path.join(tmpDir, "docs/api.md"), "utf-8");
      expect(content).toBe("api");
    });

    it("should stop cleanup at stash root", async () => {
      stash.write("only-file.md", "content");
      await stash.flush();
      await reconciler.flush();
      await reconciler.start();

      await fs.unlink(path.join(tmpDir, "only-file.md"));
      await settle(1200);

      // Stash root should still exist
      await expect(fs.access(tmpDir)).resolves.toBeUndefined();
    });
  });

  describe("rename detection", () => {
    it("should detect rename via delete+create with same content and basename", async () => {
      stash.write("old.md", "rename me");
      await stash.flush();
      await reconciler.flush();
      await reconciler.start();

      // Simulate rename: delete then quickly create with same basename
      await fs.mkdir(path.join(tmpDir, "sub"), { recursive: true });
      await fs.unlink(path.join(tmpDir, "old.md"));
      // Create with same basename within the 500ms rename window
      await fs.writeFile(path.join(tmpDir, "sub", "old.md"), "rename me");
      await settle(1800);

      expect(() => stash.read("old.md")).toThrow("File not found");
      expect(stash.read("sub/old.md")).toBe("rename me");
    });
  });

  describe("snapshot-based merge", () => {
    it("should apply user edits as automerge patches via diff", async () => {
      stash.write("file.md", "The quick brown fox");
      await stash.flush();
      await reconciler.flush();
      await reconciler.start();

      await fs.writeFile(
        path.join(tmpDir, "file.md"),
        "The quick red fox jumps",
      );
      await settle();

      expect(stash.read("file.md")).toBe("The quick red fox jumps");
    });

    it("should handle insert at beginning", async () => {
      stash.write("file.md", "world");
      await stash.flush();
      await reconciler.flush();
      await reconciler.start();

      await fs.writeFile(path.join(tmpDir, "file.md"), "hello world");
      await settle();

      expect(stash.read("file.md")).toBe("hello world");
    });

    it("should handle delete at end", async () => {
      stash.write("file.md", "hello world!!!");
      await stash.flush();
      await reconciler.flush();
      await reconciler.start();

      await fs.writeFile(path.join(tmpDir, "file.md"), "hello world");
      await settle();

      expect(stash.read("file.md")).toBe("hello world");
    });

    it("should handle complete content replacement", async () => {
      stash.write("file.md", "old content here");
      await stash.flush();
      await reconciler.flush();
      await reconciler.start();

      await fs.writeFile(
        path.join(tmpDir, "file.md"),
        "completely new content",
      );
      await settle();

      expect(stash.read("file.md")).toBe("completely new content");
    });

    it("should handle replacing with minimal content", async () => {
      stash.write("file.md", "some content here");
      await stash.flush();
      await reconciler.flush();
      await reconciler.start();

      await fs.writeFile(path.join(tmpDir, "file.md"), "x");
      await settle();

      expect(stash.read("file.md")).toBe("x");
    });
  });

  describe("binary file support", () => {
    it("should detect new binary file on disk", async () => {
      await reconciler.start();

      const binaryContent = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe,
      ]);
      await fs.writeFile(path.join(tmpDir, "image.png"), binaryContent);
      await settle();

      const files = stash.listAllFiles();
      const imagePaths = files.map(([p]) => p);
      expect(imagePaths).toContain("image.png");

      const doc = stash.getFileDocByPath("image.png");
      expect(doc).not.toBeNull();
      expect(doc!.type).toBe("binary");
    });

    it("should store binary blob in .stash/blobs", async () => {
      await reconciler.start();

      const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
      await fs.writeFile(path.join(tmpDir, "data.bin"), binaryContent);
      await settle();

      const blobDir = path.join(tmpDir, ".stash", "blobs");
      const blobs = await fs.readdir(blobDir);
      expect(blobs.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("ignored paths", () => {
    it("should ignore changes in .stash directory", async () => {
      stash.write("file.md", "content");
      await stash.flush();
      await reconciler.flush();
      await reconciler.start();

      await fs.writeFile(
        path.join(tmpDir, ".stash", "test.txt"),
        "ignored",
      );
      await settle();

      expect(stash.list()).toEqual(["file.md"]);
    });

    it("should ignore dotfiles", async () => {
      await reconciler.start();

      await fs.writeFile(path.join(tmpDir, ".gitignore"), "node_modules");
      await settle();

      expect(stash.list()).toEqual([]);
    });
  });

  describe("close", () => {
    it("should stop watching after close", async () => {
      await reconciler.start();
      await reconciler.close();

      await fs.writeFile(path.join(tmpDir, "after-close.md"), "nope");
      await settle();

      expect(stash.list()).toEqual([]);
    });

    it("should clear pending delete timers on close", async () => {
      stash.write("file.md", "content");
      await stash.flush();
      await reconciler.flush();
      await reconciler.start();

      await fs.unlink(path.join(tmpDir, "file.md"));
      await settle(100);

      await reconciler.close();
    });
  });

  describe("concurrent operations", () => {
    it("should handle rapid successive writes", async () => {
      stash.write("file.md", "start");
      await stash.flush();
      await reconciler.flush();
      await reconciler.start();

      for (let i = 0; i < 5; i++) {
        await fs.writeFile(
          path.join(tmpDir, "file.md"),
          `version ${i}`,
        );
        await settle(150);
      }
      await settle();

      const content = stash.read("file.md");
      expect(content).toBe("version 4");
    });

    it("should handle multiple files created simultaneously", async () => {
      await reconciler.start();

      await Promise.all([
        fs.writeFile(path.join(tmpDir, "a.md"), "content a"),
        fs.writeFile(path.join(tmpDir, "b.md"), "content b"),
        fs.writeFile(path.join(tmpDir, "c.md"), "content c"),
      ]);
      await settle();

      expect(stash.read("a.md")).toBe("content a");
      expect(stash.read("b.md")).toBe("content b");
      expect(stash.read("c.md")).toBe("content c");
    });
  });

  describe("scan", () => {
    it("should import existing files from disk", async () => {
      // Create file on disk before scan
      await fs.writeFile(path.join(tmpDir, "existing.md"), "from disk");

      await reconciler.scan();

      expect(stash.read("existing.md")).toBe("from disk");
      expect(stash.listAllFiles()).toHaveLength(1);
    });

    it("should import nested directories", async () => {
      await fs.mkdir(path.join(tmpDir, "docs"), { recursive: true });
      await fs.writeFile(path.join(tmpDir, "root.md"), "root");
      await fs.writeFile(path.join(tmpDir, "docs", "guide.md"), "guide");

      await reconciler.scan();

      expect(stash.read("root.md")).toBe("root");
      expect(stash.read("docs/guide.md")).toBe("guide");
      expect(stash.listAllFiles()).toHaveLength(2);
    });

    it("should skip hidden files", async () => {
      await fs.writeFile(path.join(tmpDir, "visible.md"), "visible");
      await fs.writeFile(path.join(tmpDir, ".hidden"), "hidden");

      await reconciler.scan();

      expect(stash.listAllFiles()).toHaveLength(1);
      expect(stash.read("visible.md")).toBe("visible");
    });

    it("should skip .stash directory", async () => {
      await fs.writeFile(path.join(tmpDir, "file.md"), "content");
      // .stash already exists from beforeEach

      await reconciler.scan();

      expect(stash.listAllFiles()).toHaveLength(1);
    });

    it("should not re-import already tracked files", async () => {
      stash.write("tracked.md", "from automerge");
      await stash.flush();

      // Same file exists on disk with different content
      await fs.writeFile(path.join(tmpDir, "tracked.md"), "from disk");

      await reconciler.scan();

      // Should keep automerge version, not overwrite
      expect(stash.read("tracked.md")).toBe("from automerge");
    });

    it("should import binary files", async () => {
      const binaryContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
      await fs.writeFile(path.join(tmpDir, "image.png"), binaryContent);

      await reconciler.scan();

      const files = stash.listAllFiles();
      expect(files).toHaveLength(1);
      expect(files[0][0]).toBe("image.png");
    });

    it("should delete files from automerge that are missing from disk", async () => {
      // Create file via stash API and write to disk
      stash.write("will-delete.md", "content");
      await stash.flush();
      await reconciler.flush();

      // Verify it's tracked and on disk
      expect(stash.listAllFiles()).toHaveLength(1);

      // Delete file from disk (not via stash API)
      await fs.unlink(path.join(tmpDir, "will-delete.md"));

      // Scan should detect the deletion
      await reconciler.scan();

      expect(stash.listAllFiles()).toHaveLength(0);
    });

    it("should handle mixed additions and deletions", async () => {
      // Start with one file
      stash.write("old.md", "old content");
      await stash.flush();
      await reconciler.flush();

      // Delete old file from disk, add new file
      await fs.unlink(path.join(tmpDir, "old.md"));
      await fs.writeFile(path.join(tmpDir, "new.md"), "new content");

      await reconciler.scan();

      expect(stash.listAllFiles()).toHaveLength(1);
      expect(() => stash.read("old.md")).toThrow("File not found");
      expect(stash.read("new.md")).toBe("new content");
    });
  });
});
