import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Stash } from "../src/core/stash.js";
import { StashReconciler } from "../src/core/reconciler.js";

const TEST_ACTOR_ID = "test-actor-id";

/**
 * Tests for daemon startup behavior.
 *
 * The daemon creates a reconciler for each stash and should import
 * existing files from disk on startup (via scan()), not just watch
 * for new changes.
 */
describe("Daemon startup behavior", { timeout: 15000 }, () => {
  let tmpDir: string;
  let stash: Stash;
  let reconciler: StashReconciler;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daemon-test-"));

    // Create files on disk BEFORE stash exists (simulates pre-existing files)
    await fs.mkdir(path.join(tmpDir, ".stash"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "existing.md"), "I was here first");
    await fs.mkdir(path.join(tmpDir, "docs"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "docs/guide.md"), "Guide content");

    // Now create stash (simulates daemon loading a stash)
    stash = Stash.create("test", tmpDir, TEST_ACTOR_ID);
    await stash.save();
    reconciler = new StashReconciler(stash);
  });

  afterEach(async () => {
    await reconciler.close();
    await new Promise((r) => setTimeout(r, 200));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should import existing files on startup (daemon calls start then scan)", async () => {
    // Daemon startup sequence: start() then scan()
    await reconciler.start();
    await reconciler.scan();

    const files = stash.listAllFiles();
    expect(files.length).toBe(2);
    expect(stash.read("existing.md")).toBe("I was here first");
    expect(stash.read("docs/guide.md")).toBe("Guide content");
  });

  it("should still detect new files after startup", async () => {
    await reconciler.start();
    await reconciler.scan();

    // Create a new file after startup
    await fs.writeFile(path.join(tmpDir, "new.md"), "Created after startup");
    await new Promise((r) => setTimeout(r, 800));

    expect(stash.read("new.md")).toBe("Created after startup");
    expect(stash.listAllFiles().length).toBe(3);
  });
});
