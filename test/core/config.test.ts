import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  ensureConfig,
  readConfig,
  writeConfig,
  getGitHubToken,
  setGitHubToken,
  registerStash,
  unregisterStash,
} from "../../src/core/config.js";

describe("Config", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stash-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("ensureConfig", () => {
    it("should create config on first run", async () => {
      const config = await ensureConfig(tmpDir);
      expect(config.actorId).toBeTruthy();
      expect(config.stashes).toEqual({});
    });

    it("should generate actorId", async () => {
      const config = await ensureConfig(tmpDir);
      expect(config.actorId).toBeTruthy();
      expect(typeof config.actorId).toBe("string");
    });

    it("should preserve existing config", async () => {
      const initial = await ensureConfig(tmpDir);
      const second = await ensureConfig(tmpDir);
      expect(second.actorId).toBe(initial.actorId);
    });

    it("should add actorId to existing config without one", async () => {
      await fs.writeFile(
        path.join(tmpDir, "config.json"),
        JSON.stringify({ stashes: {} }),
      );
      const config = await ensureConfig(tmpDir);
      expect(config.actorId).toBeTruthy();
      expect(config.stashes).toEqual({});
    });

    it("should initialize empty stashes map", async () => {
      const config = await ensureConfig(tmpDir);
      expect(config.stashes).toEqual({});
    });
  });

  describe("readConfig / writeConfig", () => {
    it("should write and read config", async () => {
      const config = await readConfig(tmpDir);
      config.providers = { github: { token: "ghp_test123" } };
      await writeConfig(config, tmpDir);
      const read = await readConfig(tmpDir);
      expect(read.providers?.github?.token).toBe("ghp_test123");
    });

    it("should create config directory if needed", async () => {
      const nestedDir = path.join(tmpDir, "nested", "dir");
      const config = await ensureConfig(nestedDir);
      config.providers = { github: { token: "test" } };
      await writeConfig(config, nestedDir);
      const read = await readConfig(nestedDir);
      expect(read.providers?.github?.token).toBe("test");
    });
  });

  describe("GitHub token", () => {
    it("should get GitHub token", async () => {
      const config = await ensureConfig(tmpDir);
      config.providers = { github: { token: "ghp_abc" } };
      await writeConfig(config, tmpDir);
      const token = await getGitHubToken(tmpDir);
      expect(token).toBe("ghp_abc");
    });

    it("should return undefined when no GitHub token", async () => {
      await ensureConfig(tmpDir);
      const token = await getGitHubToken(tmpDir);
      expect(token).toBeUndefined();
    });

    it("should set GitHub token", async () => {
      await setGitHubToken("ghp_new_token", tmpDir);
      const token = await getGitHubToken(tmpDir);
      expect(token).toBe("ghp_new_token");
    });

    it("should overwrite GitHub token", async () => {
      await setGitHubToken("old_token", tmpDir);
      await setGitHubToken("new_token", tmpDir);
      const token = await getGitHubToken(tmpDir);
      expect(token).toBe("new_token");
    });
  });

  describe("stash registry", () => {
    it("should add stash to registry", async () => {
      await ensureConfig(tmpDir);
      await registerStash("notes", "/path/to/notes", tmpDir);
      const config = await readConfig(tmpDir);
      expect(config.stashes.notes).toBe("/path/to/notes");
    });

    it("should remove stash from registry", async () => {
      await ensureConfig(tmpDir);
      await registerStash("notes", "/path/to/notes", tmpDir);
      await unregisterStash("notes", tmpDir);
      const config = await readConfig(tmpDir);
      expect(config.stashes.notes).toBeUndefined();
    });

    it("should handle stashes at custom paths", async () => {
      await ensureConfig(tmpDir);
      await registerStash("work", "/home/user/Repos/work-docs", tmpDir);
      const config = await readConfig(tmpDir);
      expect(config.stashes.work).toBe("/home/user/Repos/work-docs");
    });
  });
});
