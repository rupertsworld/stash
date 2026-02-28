import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Stash } from "../src/core/stash.js";
import type { SyncProvider, FetchResult } from "../src/providers/types.js";

const ACTOR_A = "a".repeat(64);
const ACTOR_B = "b".repeat(64);

class MockRemote implements SyncProvider {
  private remoteDocs: Map<string, Uint8Array> = new Map();

  async fetch(): Promise<FetchResult> {
    console.log("fetch() called, remoteDocs keys:", [...this.remoteDocs.keys()]);
    return { docs: new Map(this.remoteDocs), unchanged: false };
  }

  async push(payload: { docs: Map<string, Uint8Array> }): Promise<void> {
    console.log("push() called, docs keys:", [...payload.docs.keys()]);
    for (const [docId, data] of payload.docs) {
      this.remoteDocs.set(docId, data);
    }
  }

  async create() {}
  async delete() {}
}

describe("Debug Stash Sync", () => {
  let tmpDirA: string;
  let tmpDirB: string;
  let remote: MockRemote;

  beforeEach(async () => {
    tmpDirA = await fs.mkdtemp(path.join(os.tmpdir(), "debug-a-"));
    tmpDirB = await fs.mkdtemp(path.join(os.tmpdir(), "debug-b-"));
    remote = new MockRemote();
  });

  afterEach(async () => {
    await fs.rm(tmpDirA, { recursive: true, force: true });
    await fs.rm(tmpDirB, { recursive: true, force: true });
  });

  it("should propagate deletion through sync", async () => {
    // A creates a file
    const stashA = Stash.create("test", tmpDirA, ACTOR_A, remote, "mock:test");
    stashA.write("file.md", "content");
    await stashA.flush();
    await stashA.sync();
    console.log("After A sync 1 - A list:", stashA.list());

    // B syncs and gets the file
    const stashB = Stash.create("test", tmpDirB, ACTOR_B, remote, "mock:test");
    await stashB.sync();
    console.log("After B sync 1 - B list:", stashB.list());
    expect(stashB.read("file.md")).toBe("content");

    // A deletes the file
    stashA.delete("file.md");
    await stashA.flush();
    await stashA.sync();
    console.log("After A sync 2 (deleted) - A list:", stashA.list());
    console.log("A isDeleted('file.md'):", stashA.isDeleted("file.md"));

    // B syncs and should see the deletion
    await stashB.sync();
    console.log("After B sync 2 - B list:", stashB.list());
    console.log("B isDeleted('file.md'):", stashB.isDeleted("file.md"));

    // B should not list the file
    expect(stashB.list()).not.toContain("file.md");
    expect(stashB.isDeleted("file.md")).toBe(true);
  });
});
