import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface StashConfig {
  github?: {
    token: string;
  };
}

export const DEFAULT_STASH_DIR =
  path.join(process.env.HOME ?? "~", ".stash");

export function configPath(baseDir: string = DEFAULT_STASH_DIR): string {
  return path.join(baseDir, "config.json");
}

export async function readConfig(
  baseDir: string = DEFAULT_STASH_DIR,
): Promise<StashConfig> {
  try {
    const data = await fs.readFile(configPath(baseDir), "utf-8");
    return JSON.parse(data) as StashConfig;
  } catch {
    return {};
  }
}

export async function writeConfig(
  config: StashConfig,
  baseDir: string = DEFAULT_STASH_DIR,
): Promise<void> {
  const filePath = configPath(baseDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(config, null, 2) + "\n");
}

export async function getGitHubToken(
  baseDir: string = DEFAULT_STASH_DIR,
): Promise<string | undefined> {
  const config = await readConfig(baseDir);
  return config.github?.token;
}

export async function setGitHubToken(
  token: string,
  baseDir: string = DEFAULT_STASH_DIR,
): Promise<void> {
  const config = await readConfig(baseDir);
  config.github = { token };
  await writeConfig(config, baseDir);
}
