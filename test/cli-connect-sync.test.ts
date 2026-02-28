/**
 * Tests for stash connect and stash sync rendering files to disk.
 *
 * Expected behavior (per spec/cli.md):
 * - stash connect: syncs Automerge from remote, then renders files via reconciler flush
 * - stash sync: scan disk, sync Automerge, then render updated files via reconciler flush
 *
 * These tests document the expected behavior and will fail until the implementation
 * adds reconciler.flush() after sync in both connect and sync flows.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { StashManager } from "../src/core/manager.js";
import { StashReconciler } from "../src/core/reconciler.js";
import { setGitHubToken } from "../src/core/config.js";
import type { SyncProvider, FetchResult } from "../src/providers/types.js";

const TEST_ACTOR_ID = "test-actor-connect-sync";

async function settle(ms = 200): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("stash connect: should render files to disk after sync", () => {
  let tmpDir: string;
  let baseDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stash-connect-test-"));
    baseDir = path.join(tmpDir, "config");
    await fs.mkdir(baseDir, { recursive: true });
    await setGitHubToken("test-token", baseDir);
  });

  afterEach(async () => {
    await settle(100);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("connect should write remote files to disk after pulling", async () => {
    const remoteStore = new Map<string, Uint8Array>();

    const mockProvider: SyncProvider = {
      async fetch(): Promise<FetchResult> {
        return { docs: new Map(remoteStore), unchanged: false };
      },
      async push(payload) {
        for (const [key, data] of payload.docs) {
          remoteStore.set(key, data);
        }
      },
      async create() {},
      async delete() {},
    };

    // Populate remote: create stash A, add files, push
    const sourcePath = path.join(tmpDir, "source");
    await fs.mkdir(sourcePath, { recursive: true });
    const manager = await StashManager.load(baseDir);
    const sourceStash = await manager.create("source", sourcePath, mockProvider, "github:owner/repo");
    sourceStash.write("readme.md", "# Hello from remote");
    sourceStash.write("docs/guide.md", "Step 1: connect");
    await sourceStash.flush();
    await sourceStash.sync();

    expect(remoteStore.size).toBeGreaterThan(0);

    // Connect: pull into new stash
    const connectPath = path.join(tmpDir, "connected");
    const connectedStash = await manager.connect(
      "github:owner/repo",
      "connected",
      mockProvider,
      connectPath,
    );

    // Expected: files should be rendered to disk
    const readmePath = path.join(connectPath, "readme.md");
    const guidePath = path.join(connectPath, "docs", "guide.md");

    const readmeContent = await fs.readFile(readmePath, "utf-8").catch(() => null);
    const guideContent = await fs.readFile(guidePath, "utf-8").catch(() => null);

    expect(readmeContent).toBe("# Hello from remote");
    expect(guideContent).toBe("Step 1: connect");
  });
});

describe("stash sync: should render updated files to disk after sync", () => {
  let tmpDir: string;
  let baseDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stash-sync-test-"));
    baseDir = path.join(tmpDir, "config");
    await fs.mkdir(baseDir, { recursive: true });
    await setGitHubToken("test-token", baseDir);
  });

  afterEach(async () => {
    await settle(100);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("sync should write updated files to disk after pulling from remote", async () => {
    const remoteStore = new Map<string, Uint8Array>();

    const mockProvider: SyncProvider = {
      async fetch(): Promise<FetchResult> {
        return { docs: new Map(remoteStore), unchanged: false };
      },
      async push(payload) {
        for (const [key, data] of payload.docs) {
          remoteStore.set(key, data);
        }
      },
      async create() {},
      async delete() {},
    };

    // Create local stash with initial content, push to remote
    const stashPath = path.join(tmpDir, "mystash");
    const manager = await StashManager.load(baseDir);
    const stash = await manager.create("mystash", stashPath, mockProvider, "github:owner/repo");
    stash.write("initial.md", "v1");
    await stash.flush();
    await stash.sync(); // push v1 to remote

    // Populate remote with newer content from different "source" stash (different actor)
    const sourceBaseDir = path.join(tmpDir, "source-config");
    await fs.mkdir(sourceBaseDir, { recursive: true });
    await setGitHubToken("test-token", sourceBaseDir);
    const sourceManager = await StashManager.load(sourceBaseDir);
    const sourcePath = path.join(tmpDir, "source");
    const sourceStash = await sourceManager.create(
      "source",
      sourcePath,
      mockProvider,
      "github:owner/repo",
    );
    sourceStash.write("initial.md", "v2 updated");
    sourceStash.write("newfile.md", "new from remote");
    await sourceStash.flush();
    await sourceStash.sync(); // overwrite remote with v2 and newfile

    // Sync flow: scan, sync (pull), flush (render)
    const reconciler = new StashReconciler(stash);
    await reconciler.scan();
    await stash.sync();
    await reconciler.flush();
    await reconciler.close();

    // Expected: updated files should be on disk (will fail until sync command adds flush)
    const initialPath = path.join(stashPath, "initial.md");
    const newfilePath = path.join(stashPath, "newfile.md");

    const initialContent = await fs.readFile(initialPath, "utf-8").catch(() => null);
    const newfileContent = await fs.readFile(newfilePath, "utf-8").catch(() => null);

    expect(initialContent).toBe("v2 updated");
    expect(newfileContent).toBe("new from remote");
  });
});
