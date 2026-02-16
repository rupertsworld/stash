import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ulid } from "ulid";

export interface GlobalConfig {
  actorId: string;
  providers?: {
    github?: { token: string };
  };
  stashes: Record<string, string>; // name → absolute path
}

export const DEFAULT_STASH_DIR = path.join(
  process.env.HOME ?? "~",
  ".stash",
);

export function configPath(baseDir: string = DEFAULT_STASH_DIR): string {
  return path.join(baseDir, "config.json");
}

export async function ensureConfig(
  baseDir: string = DEFAULT_STASH_DIR,
): Promise<GlobalConfig> {
  // Create directory with restrictive permissions (owner only)
  await fs.mkdir(baseDir, { recursive: true, mode: 0o700 });

  const cfgPath = configPath(baseDir);
  let config: GlobalConfig;
  let needsWrite = false;

  try {
    config = JSON.parse(await fs.readFile(cfgPath, "utf-8"));
  } catch {
    config = { actorId: ulid(), stashes: {} };
    needsWrite = true;
  }

  if (!config.actorId) {
    config.actorId = ulid();
    needsWrite = true;
  }
  if (!config.stashes) {
    config.stashes = {};
    needsWrite = true;
  }

  if (needsWrite) {
    // Write config with restrictive permissions (contains tokens)
    await fs.writeFile(cfgPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  }

  return config;
}

export async function readConfig(
  baseDir: string = DEFAULT_STASH_DIR,
): Promise<GlobalConfig> {
  return ensureConfig(baseDir);
}

export async function writeConfig(
  config: GlobalConfig,
  baseDir: string = DEFAULT_STASH_DIR,
): Promise<void> {
  const filePath = configPath(baseDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

export async function getGitHubToken(
  baseDir: string = DEFAULT_STASH_DIR,
): Promise<string | undefined> {
  const config = await readConfig(baseDir);
  return config.providers?.github?.token;
}

export async function setGitHubToken(
  token: string,
  baseDir: string = DEFAULT_STASH_DIR,
): Promise<void> {
  const config = await readConfig(baseDir);
  if (!config.providers) config.providers = {};
  config.providers.github = { token };
  await writeConfig(config, baseDir);
}

export async function registerStash(
  name: string,
  stashPath: string,
  baseDir: string = DEFAULT_STASH_DIR,
): Promise<void> {
  const config = await readConfig(baseDir);
  config.stashes[name] = path.resolve(stashPath);
  await writeConfig(config, baseDir);
}

export async function unregisterStash(
  name: string,
  baseDir: string = DEFAULT_STASH_DIR,
): Promise<void> {
  const config = await readConfig(baseDir);
  delete config.stashes[name];
  await writeConfig(config, baseDir);
}
