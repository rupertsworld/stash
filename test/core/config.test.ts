import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  readConfig,
  writeConfig,
  getGitHubToken,
  setGitHubToken,
} from "../../src/core/config.js";

describe("Config", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stash-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should return empty config when file doesn't exist", async () => {
    const config = await readConfig(tmpDir);
    expect(config).toEqual({});
  });

  it("should write and read config", async () => {
    await writeConfig({ github: { token: "ghp_test123" } }, tmpDir);
    const config = await readConfig(tmpDir);
    expect(config.github?.token).toBe("ghp_test123");
  });

  it("should create config directory if needed", async () => {
    const nestedDir = path.join(tmpDir, "nested", "dir");
    await writeConfig({ github: { token: "test" } }, nestedDir);
    const config = await readConfig(nestedDir);
    expect(config.github?.token).toBe("test");
  });

  it("should get GitHub token", async () => {
    await writeConfig({ github: { token: "ghp_abc" } }, tmpDir);
    const token = await getGitHubToken(tmpDir);
    expect(token).toBe("ghp_abc");
  });

  it("should return undefined when no GitHub token", async () => {
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
