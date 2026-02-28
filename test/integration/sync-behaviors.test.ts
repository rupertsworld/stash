/**
 * Functional tests for sync behaviors.
 * Tests user-facing scenarios with a mock remote.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as Automerge from "@automerge/automerge";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Stash } from "../../src/core/stash.js";
import { StashReconciler } from "../../src/core/reconciler.js";
import type { SyncProvider, FetchResult } from "../../src/providers/types.js";
import type { StructureDoc } from "../../src/core/structure.js";

const ACTOR_A = "a".repeat(64);
const ACTOR_B = "b".repeat(64);

/**
 * Mock provider that simulates a remote with its own state.
 * Performs real Automerge merges like the GitHub provider does.
 */
class MockRemote implements SyncProvider {
  private remoteDocs: Map<string, Uint8Array> = new Map();

  async fetch(): Promise<FetchResult> {
    return { docs: new Map(this.remoteDocs), unchanged: false };
  }

  async push(payload: { docs: Map<string, Uint8Array> }): Promise<void> {
    for (const [docId, data] of payload.docs) {
      this.remoteDocs.set(docId, data);
    }
  }

  async create() {}
  async delete() {}

  // Test helpers
  getState(): Map<string, Uint8Array> {
    return new Map(this.remoteDocs);
  }

  setState(docs: Map<string, Uint8Array>): void {
    this.remoteDocs = new Map(docs);
  }

  clear(): void {
    this.remoteDocs.clear();
  }
}

async function settle(ms = 300): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Poll until predicate is true or timeout. Use for watcher-driven state changes. */
async function waitFor(
  predicate: () => boolean,
  opts: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const { timeout = 8000, interval = 50 } = opts;
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error(`Timeout after ${timeout}ms waiting for predicate`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

describe("Sync Behaviors", { timeout: 15000 }, () => {
  let tmpDirA: string;
  let tmpDirB: string;
  let remote: MockRemote;

  beforeEach(async () => {
    tmpDirA = await fs.mkdtemp(path.join(os.tmpdir(), "sync-test-a-"));
    tmpDirB = await fs.mkdtemp(path.join(os.tmpdir(), "sync-test-b-"));
    remote = new MockRemote();
  });

  afterEach(async () => {
    await settle(200); // Let watchers release handles before cleanup
    await fs.rm(tmpDirA, { recursive: true, force: true });
    await fs.rm(tmpDirB, { recursive: true, force: true });
  });

  describe("Local Actions", () => {
    it("I create a file → file syncs to remote", async () => {
      const stash = Stash.create("test", tmpDirA, ACTOR_A, remote, "mock:test");

      stash.write("hello.md", "hello world");
      await stash.flush();
      await stash.sync();

      // Remote should have the file
      const remoteState = remote.getState();
      expect(remoteState.has("structure")).toBe(true);

      // Another client syncing should see it
      const stashB = Stash.create("test", tmpDirB, ACTOR_B, remote, "mock:test");
      await stashB.sync();

      expect(stashB.read("hello.md")).toBe("hello world");
    });

    it("I edit a file → changes sync to remote", async () => {
      const stash = Stash.create("test", tmpDirA, ACTOR_A, remote, "mock:test");

      stash.write("file.md", "version 1");
      await stash.flush();
      await stash.sync();

      stash.write("file.md", "version 2");
      await stash.flush();
      await stash.sync();

      // Another client should see the edit
      const stashB = Stash.create("test", tmpDirB, ACTOR_B, remote, "mock:test");
      await stashB.sync();

      expect(stashB.read("file.md")).toBe("version 2");
    });

    it("I delete a file → deletion syncs to remote", async () => {
      const stash = Stash.create("test", tmpDirA, ACTOR_A, remote, "mock:test");

      stash.write("to-delete.md", "content");
      await stash.flush();
      await stash.sync();

      stash.delete("to-delete.md");
      await stash.flush();
      await stash.sync();

      // Another client should not see the file
      const stashB = Stash.create("test", tmpDirB, ACTOR_B, remote, "mock:test");
      await stashB.sync();

      expect(stashB.list()).not.toContain("to-delete.md");
    });
  });

  describe("Remote Actions", () => {
    it("Remote has a new file, I sync → file appears locally", async () => {
      // User A creates file
      const stashA = Stash.create("test", tmpDirA, ACTOR_A, remote, "mock:test");
      stashA.write("from-remote.md", "remote content");
      await stashA.flush();
      await stashA.sync();

      // User B syncs
      const stashB = Stash.create("test", tmpDirB, ACTOR_B, remote, "mock:test");
      await stashB.sync();

      expect(stashB.read("from-remote.md")).toBe("remote content");
    });

    it("Remote edited a file, I sync → my local copy updates", async () => {
      // Both users start with same file
      const stashA = Stash.create("test", tmpDirA, ACTOR_A, remote, "mock:test");
      stashA.write("shared.md", "original");
      await stashA.flush();
      await stashA.sync();

      const stashB = Stash.create("test", tmpDirB, ACTOR_B, remote, "mock:test");
      await stashB.sync();
      expect(stashB.read("shared.md")).toBe("original");

      // User A edits
      stashA.write("shared.md", "edited by A");
      await stashA.flush();
      await stashA.sync();

      // User B syncs and sees edit
      await stashB.sync();
      expect(stashB.read("shared.md")).toBe("edited by A");
    });

    it("Remote deleted a file I have, I sync → my local file is deleted", async () => {
      // Both users have the file
      const stashA = Stash.create("test", tmpDirA, ACTOR_A, remote, "mock:test");
      stashA.write("shared.md", "content");
      await stashA.flush();
      await stashA.sync();

      const stashB = Stash.create("test", tmpDirB, ACTOR_B, remote, "mock:test");
      await stashB.sync();
      const reconcilerB = new StashReconciler(stashB);
      await stashB.save();
      await reconcilerB.flush();

      // Verify B has the file on disk
      await expect(fs.access(path.join(tmpDirB, "shared.md"))).resolves.toBeUndefined();

      // User A deletes
      stashA.delete("shared.md");
      await stashA.flush();
      await stashA.sync();

      // User B syncs
      await stashB.sync();
      await reconcilerB.flush();

      // B's local file should be deleted
      expect(stashB.list()).not.toContain("shared.md");
      await expect(fs.access(path.join(tmpDirB, "shared.md"))).rejects.toThrow();

      await reconcilerB.close();
    });
  });

  describe("Conflicts - Deletion vs Content", () => {
    it("I delete a file, remote still has it, I sync → file stays deleted (my delete propagates)", async () => {
      // Setup: both have file
      const stashA = Stash.create("test", tmpDirA, ACTOR_A, remote, "mock:test");
      stashA.write("file.md", "content");
      await stashA.flush();
      await stashA.sync();

      const stashB = Stash.create("test", tmpDirB, ACTOR_B, remote, "mock:test");
      await stashB.sync();

      // I (B) delete locally
      stashB.delete("file.md");
      await stashB.flush();
      await stashB.sync();

      // My delete should propagate - A syncing should see deletion
      await stashA.sync();
      expect(stashA.list()).not.toContain("file.md");
    });

    it("Remote deleted a file, I still have it unchanged, I sync → my file is deleted", async () => {
      // Setup: both have file
      const stashA = Stash.create("test", tmpDirA, ACTOR_A, remote, "mock:test");
      stashA.write("file.md", "content");
      await stashA.flush();
      await stashA.sync();

      const stashB = Stash.create("test", tmpDirB, ACTOR_B, remote, "mock:test");
      await stashB.sync();
      await stashB.save();
      const reconcilerB = new StashReconciler(stashB);
      await reconcilerB.flush();

      // A deletes
      stashA.delete("file.md");
      await stashA.flush();
      await stashA.sync();

      // B syncs (hasn't touched the file)
      await stashB.sync();
      await reconcilerB.flush();

      // B's file should be deleted
      expect(stashB.list()).not.toContain("file.md");

      await reconcilerB.close();
    });

    it("Remote deleted a file, but I edited it before syncing → my edits survive", async () => {
      // Setup: both have file
      const stashA = Stash.create("test", tmpDirA, ACTOR_A, remote, "mock:test");
      stashA.write("file.md", "original");
      await stashA.flush();
      await stashA.sync();

      const stashB = Stash.create("test", tmpDirB, ACTOR_B, remote, "mock:test");
      await stashB.sync();

      // A deletes
      stashA.delete("file.md");
      await stashA.flush();
      await stashA.sync();

      // B edits (before syncing with A's delete)
      stashB.write("file.md", "edited by B");
      await stashB.flush();

      // B syncs - content should win over delete
      await stashB.sync();

      expect(stashB.read("file.md")).toBe("edited by B");

      // A syncs - should see B's content (content wins)
      await stashA.sync();
      expect(stashA.read("file.md")).toBe("edited by B");
    });

    it("Remote deleted a file, I created new file at same path → my new file survives", async () => {
      // Setup: A has a file, syncs, then deletes
      const stashA = Stash.create("test", tmpDirA, ACTOR_A, remote, "mock:test");
      stashA.write("reused-path.md", "original from A");
      await stashA.flush();
      await stashA.sync();

      // B syncs to get the file
      const stashB = Stash.create("test", tmpDirB, ACTOR_B, remote, "mock:test");
      await stashB.sync();
      const reconcilerB = new StashReconciler(stashB);
      await stashB.save();
      await reconcilerB.flush();

      // A deletes
      stashA.delete("reused-path.md");
      await stashA.flush();
      await stashA.sync();

      // B (not yet synced with delete) creates new file at same path on disk
      await fs.writeFile(path.join(tmpDirB, "reused-path.md"), "new content from B");

      // B syncs - new file should survive
      await reconcilerB.flush(); // This should import the new file
      await stashB.sync();

      expect(stashB.read("reused-path.md")).toBe("new content from B");

      await reconcilerB.close();
    });
  });

  describe("Offline Scenarios", () => {
    it("I create a file while offline, then sync → file uploads to remote", async () => {
      const stash = Stash.create("test", tmpDirA, ACTOR_A, remote, "mock:test");

      // Create file "offline" (no sync yet)
      stash.write("offline-created.md", "created offline");
      await stash.flush();

      // Now sync
      await stash.sync();

      // Another client should see it
      const stashB = Stash.create("test", tmpDirB, ACTOR_B, remote, "mock:test");
      await stashB.sync();

      expect(stashB.read("offline-created.md")).toBe("created offline");
    });

    it("I delete a file while offline, then sync → deletion propagates to remote", async () => {
      const stashA = Stash.create("test", tmpDirA, ACTOR_A, remote, "mock:test");
      stashA.write("file.md", "content");
      await stashA.flush();
      await stashA.sync();

      const stashB = Stash.create("test", tmpDirB, ACTOR_B, remote, "mock:test");
      await stashB.sync();

      // B deletes "offline"
      stashB.delete("file.md");
      await stashB.flush();

      // B syncs
      await stashB.sync();

      // A should see deletion
      await stashA.sync();
      expect(stashA.list()).not.toContain("file.md");
    });

    it("Remote deleted a file while I was offline, I sync → my local copy is deleted", async () => {
      // Setup
      const stashA = Stash.create("test", tmpDirA, ACTOR_A, remote, "mock:test");
      stashA.write("file.md", "content");
      await stashA.flush();
      await stashA.sync();

      const stashB = Stash.create("test", tmpDirB, ACTOR_B, remote, "mock:test");
      await stashB.sync();
      await stashB.save();
      const reconcilerB = new StashReconciler(stashB);
      await reconcilerB.flush();

      // A deletes while B is "offline"
      stashA.delete("file.md");
      await stashA.flush();
      await stashA.sync();

      // B comes online and syncs
      await stashB.sync();
      await reconcilerB.flush();

      expect(stashB.list()).not.toContain("file.md");
      await expect(fs.access(path.join(tmpDirB, "file.md"))).rejects.toThrow();

      await reconcilerB.close();
    });

    it("Remote deleted file while offline, but I created new file at same path, I sync → my new file survives", async () => {
      // Setup
      const stashA = Stash.create("test", tmpDirA, ACTOR_A, remote, "mock:test");
      stashA.write("file.md", "original");
      await stashA.flush();
      await stashA.sync();

      const stashB = Stash.create("test", tmpDirB, ACTOR_B, remote, "mock:test");
      await stashB.sync();
      await stashB.save();
      const reconcilerB = new StashReconciler(stashB);
      await reconcilerB.flush();

      // A deletes
      stashA.delete("file.md");
      await stashA.flush();
      await stashA.sync();

      // B creates new file at same path (while "offline")
      await fs.writeFile(path.join(tmpDirB, "file.md"), "new from B");

      // B comes online - flush imports file, then sync
      await reconcilerB.flush();
      await stashB.sync();

      // B's new file should survive
      expect(stashB.read("file.md")).toBe("new from B");

      await reconcilerB.close();
    });

    it("Remote deleted file while offline, but I edited it offline, I sync → my edits survive", async () => {
      // Setup
      const stashA = Stash.create("test", tmpDirA, ACTOR_A, remote, "mock:test");
      stashA.write("file.md", "original");
      await stashA.flush();
      await stashA.sync();

      const stashB = Stash.create("test", tmpDirB, ACTOR_B, remote, "mock:test");
      await stashB.sync();

      // A deletes
      stashA.delete("file.md");
      await stashA.flush();
      await stashA.sync();

      // B edits (while "offline", before seeing delete)
      stashB.write("file.md", "edited by B offline");
      await stashB.flush();

      // B syncs - content should win
      await stashB.sync();

      expect(stashB.read("file.md")).toBe("edited by B offline");
    });
  });

  describe("Race Conditions", () => {
    it("File created on disk, flush runs before watcher imports → file is imported, not deleted", async () => {
      const stash = Stash.create("test", tmpDirA, ACTOR_A, remote, "mock:test");
      stash.write("existing.md", "existing");
      await stash.flush();
      await stash.save();

      const reconciler = new StashReconciler(stash);
      await reconciler.flush();

      // Create file on disk (simulating MCP write)
      await fs.writeFile(path.join(tmpDirA, "mcp-file.md"), "from mcp");

      // Flush without watcher running - should import, not delete
      await reconciler.flush();

      expect(stash.read("mcp-file.md")).toBe("from mcp");
      const content = await fs.readFile(path.join(tmpDirA, "mcp-file.md"), "utf-8");
      expect(content).toBe("from mcp");

      await reconciler.close();
    });

    it("File deleted from disk, flush runs → file stays deleted, not recreated", async () => {
      const stash = Stash.create("test", tmpDirA, ACTOR_A, remote, "mock:test");
      stash.write("file.md", "content");
      await stash.flush();
      await stash.save();

      const reconciler = new StashReconciler(stash);
      await reconciler.flush();
      await reconciler.start();

      // Delete file from disk (simulating MCP delete or user rm)
      await fs.unlink(path.join(tmpDirA, "file.md"));

      // Flush runs before delete debounce completes (500ms)
      // File should NOT be recreated
      await reconciler.flush();

      // File should still be gone from disk
      await expect(
        fs.access(path.join(tmpDirA, "file.md"))
      ).rejects.toThrow();

      // Wait for delete to finalize
      await settle(800);

      // File should be tombstoned in automerge
      expect(stash.list()).not.toContain("file.md");

      await reconciler.close();
    });

    it("Binary file deleted from disk, flush runs → file stays deleted", async () => {
      const stash = Stash.create("test", tmpDirA, ACTOR_A, remote, "mock:test");
      await stash.save();

      const reconciler = new StashReconciler(stash);
      await reconciler.start();

      // Create a binary file on disk; wait for watcher to import (polling avoids flakiness)
      const binaryContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
      await fs.writeFile(path.join(tmpDirA, "image.png"), binaryContent);
      await waitFor(() => stash.list().includes("image.png"));

      // Delete binary file from disk
      await fs.unlink(path.join(tmpDirA, "image.png"));

      // Flush before delete debounce (500ms) completes — should tombstone, not recreate
      await reconciler.flush();

      // File should still be gone from disk
      await expect(
        fs.access(path.join(tmpDirA, "image.png"))
      ).rejects.toThrow();

      // Wait for delete debounce to finalize
      await waitFor(() => !stash.list().includes("image.png"), {
        timeout: 2000,
        interval: 50,
      });

      await reconciler.close();
    });

    it("File created on disk stays created after multiple flushes", async () => {
      const stash = Stash.create("test", tmpDirA, ACTOR_A, remote, "mock:test");
      await stash.save();

      const reconciler = new StashReconciler(stash);
      await reconciler.flush();

      // Create file on disk
      await fs.writeFile(path.join(tmpDirA, "new.md"), "new content");

      // Multiple flushes should not delete the file
      await reconciler.flush();
      await reconciler.flush();
      await reconciler.flush();

      // File should exist on disk and in automerge
      const content = await fs.readFile(path.join(tmpDirA, "new.md"), "utf-8");
      expect(content).toBe("new content");
      expect(stash.read("new.md")).toBe("new content");

      await reconciler.close();
    });
  });

  describe("Edge Cases", () => {
    it("I delete then recreate same file (different content) → new file persists", async () => {
      const stash = Stash.create("test", tmpDirA, ACTOR_A, remote, "mock:test");

      stash.write("file.md", "original");
      await stash.flush();
      const originalDocId = stash.getDocId("file.md");

      stash.delete("file.md");
      await stash.flush();

      stash.write("file.md", "recreated");
      await stash.flush();

      expect(stash.read("file.md")).toBe("recreated");
      expect(stash.getDocId("file.md")).not.toBe(originalDocId);
    });

    it("I delete then recreate same file (same content) → new file persists", async () => {
      const stash = Stash.create("test", tmpDirA, ACTOR_A, remote, "mock:test");

      stash.write("file.md", "same content");
      await stash.flush();

      stash.delete("file.md");
      await stash.flush();

      stash.write("file.md", "same content");
      await stash.flush();

      expect(stash.read("file.md")).toBe("same content");
    });

    it("Two users delete same file simultaneously → no conflict, file is deleted", async () => {
      // Setup
      const stashA = Stash.create("test", tmpDirA, ACTOR_A, remote, "mock:test");
      stashA.write("file.md", "content");
      await stashA.flush();
      await stashA.sync();

      const stashB = Stash.create("test", tmpDirB, ACTOR_B, remote, "mock:test");
      await stashB.sync();

      // Both delete without syncing
      stashA.delete("file.md");
      await stashA.flush();

      stashB.delete("file.md");
      await stashB.flush();

      // Both sync
      await stashA.sync();
      await stashB.sync();

      // Both should agree file is deleted
      expect(stashA.list()).not.toContain("file.md");
      expect(stashB.list()).not.toContain("file.md");
    });

    it("File deleted on remote, I never had it, I sync → nothing happens", async () => {
      // A creates and deletes a file
      const stashA = Stash.create("test", tmpDirA, ACTOR_A, remote, "mock:test");
      stashA.write("ephemeral.md", "content");
      await stashA.flush();
      await stashA.sync();

      stashA.delete("ephemeral.md");
      await stashA.flush();
      await stashA.sync();

      // B joins fresh - never had the file
      const stashB = Stash.create("test", tmpDirB, ACTOR_B, remote, "mock:test");
      await stashB.sync();

      // Should just work - no error, no file
      expect(stashB.list()).not.toContain("ephemeral.md");
    });

    it("Fresh machine joins existing stash → all remote files appear locally", async () => {
      // A creates multiple files
      const stashA = Stash.create("test", tmpDirA, ACTOR_A, remote, "mock:test");
      stashA.write("file1.md", "content 1");
      stashA.write("dir/file2.md", "content 2");
      stashA.write("dir/sub/file3.md", "content 3");
      await stashA.flush();
      await stashA.sync();

      // B joins fresh
      const stashB = Stash.create("test", tmpDirB, ACTOR_B, remote, "mock:test");
      await stashB.sync();
      const reconcilerB = new StashReconciler(stashB);
      await reconcilerB.flush();

      // All files should be present
      expect(stashB.read("file1.md")).toBe("content 1");
      expect(stashB.read("dir/file2.md")).toBe("content 2");
      expect(stashB.read("dir/sub/file3.md")).toBe("content 3");

      // Files should exist on disk
      expect(await fs.readFile(path.join(tmpDirB, "file1.md"), "utf-8")).toBe("content 1");

      await reconcilerB.close();
    });
  });
});
