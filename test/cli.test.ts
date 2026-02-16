import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

/**
 * CLI command module tests.
 *
 * Tests the command handler functions directly to ensure they handle
 * arguments correctly and don't crash with unexpected input types.
 */
describe("CLI command handlers", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("stopDaemon", () => {
    it("should accept string baseDir parameter", async () => {
      const { stopDaemon } = await import("../src/cli/commands/stop.js");

      // Create the directory structure
      const stashDir = path.join(tmpDir, ".stash");
      await fs.mkdir(stashDir, { recursive: true });

      // Should not throw - just report daemon not running
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await stopDaemon(stashDir);
      consoleSpy.mockRestore();
    });

    it("should use default baseDir when called with no arguments", async () => {
      const { stopDaemon } = await import("../src/cli/commands/stop.js");

      // This tests the fix for the Commander bug where {} was passed
      // The function should use DEFAULT_STASH_DIR when no arg provided
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      // Should not throw TypeError about path argument
      await expect(stopDaemon()).resolves.not.toThrow();
      consoleSpy.mockRestore();
    });

    it("should handle stale PID file gracefully", async () => {
      const { stopDaemon } = await import("../src/cli/commands/stop.js");

      const stashDir = path.join(tmpDir, ".stash");
      await fs.mkdir(stashDir, { recursive: true });

      // Create a PID file with a non-existent process
      await fs.writeFile(path.join(stashDir, "daemon.pid"), "999999999");

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await stopDaemon(stashDir);
      consoleSpy.mockRestore();

      // PID file should be cleaned up
      const pidExists = await fs.access(path.join(stashDir, "daemon.pid"))
        .then(() => true)
        .catch(() => false);
      expect(pidExists).toBe(false);
    });
  });

  describe("command module exports", () => {
    it("should export all command handlers", async () => {
      // Verify all commands can be imported without errors
      const { stopDaemon } = await import("../src/cli/commands/stop.js");
      const { startDaemon } = await import("../src/cli/commands/start.js");
      const { listStashes } = await import("../src/cli/commands/list.js");
      const { createStash } = await import("../src/cli/commands/create.js");
      const { deleteStash } = await import("../src/cli/commands/delete.js");
      const { syncStashes } = await import("../src/cli/commands/sync.js");
      const { showStatus } = await import("../src/cli/commands/status.js");
      const { connectStash } = await import("../src/cli/commands/connect.js");
      const { editStash } = await import("../src/cli/commands/edit.js");
      const { linkStash } = await import("../src/cli/commands/link.js");
      const { unlinkStash } = await import("../src/cli/commands/unlink.js");
      const { authGitHub } = await import("../src/cli/commands/auth.js");
      const { install } = await import("../src/cli/commands/install.js");

      expect(typeof stopDaemon).toBe("function");
      expect(typeof startDaemon).toBe("function");
      expect(typeof listStashes).toBe("function");
      expect(typeof createStash).toBe("function");
      expect(typeof deleteStash).toBe("function");
      expect(typeof syncStashes).toBe("function");
      expect(typeof showStatus).toBe("function");
      expect(typeof connectStash).toBe("function");
      expect(typeof editStash).toBe("function");
      expect(typeof linkStash).toBe("function");
      expect(typeof unlinkStash).toBe("function");
      expect(typeof authGitHub).toBe("function");
      expect(typeof install).toBe("function");
    });
  });
});

describe("CLI argument handling", () => {
  it("should wire stopDaemon correctly without passing Commander options object", async () => {
    // This is a regression test for the bug where:
    // .action(stopDaemon) caused Commander to pass {} as first argument
    // which then threw: TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string
    //
    // The fix was: .action(() => stopDaemon())

    // We can verify the fix by checking that cli.ts has the correct pattern
    const cliSource = await fs.readFile(
      path.join(__dirname, "../src/cli.ts"),
      "utf-8"
    );

    // Should have arrow function wrapper for stopDaemon
    expect(cliSource).toMatch(/\.action\(\s*\(\)\s*=>\s*stopDaemon\(\)\s*\)/);

    // Should NOT have direct reference .action(stopDaemon)
    expect(cliSource).not.toMatch(/\.action\(stopDaemon\)/);
  });
});
