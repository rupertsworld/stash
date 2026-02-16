import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { StashManager } from "../../core/manager.js";
import { getGitHubToken } from "../../core/config.js";
import { GitHubProvider, parseGitHubRemote } from "../../providers/github.js";
import { promptChoice, prompt } from "../prompts.js";
import type { Stash } from "../../core/stash.js";

interface CreateOptions {
  path?: string;
  description?: string;
  remote?: string;
}

export async function createStash(
  name: string,
  opts: CreateOptions,
): Promise<void> {
  const manager = await StashManager.load();

  let provider: GitHubProvider | null = null;
  let remote: string | null = null;
  let remoteFilesToImport: string[] = [];

  if (opts.remote !== undefined) {
    // --remote flag provided, skip prompt
    if (opts.remote === "none") {
      // Local only, no provider
    } else if (opts.remote.startsWith("github:")) {
      const parsed = parseGitHubRemote(opts.remote);
      if (!parsed) {
        console.error("Invalid remote format. Use github:owner/repo or github:owner/repo/folder");
        process.exit(1);
      }

      const token = await getGitHubToken();
      if (!token) {
        console.error("No GitHub token found. Run `stash auth github` first.");
        process.exit(1);
      }

      provider = new GitHubProvider(token, parsed.owner, parsed.repo, parsed.pathPrefix);

      // Check remote state using fetch()
      let remoteDocs: Map<string, Uint8Array>;
      try {
        remoteDocs = await provider.fetch();
      } catch (err) {
        const error = err as Error & { status?: number };
        if (error.status === 404) {
          console.error(`Repository ${parsed.owner}/${parsed.repo} does not exist.`);
          console.error("Create the repository on GitHub first.");
          process.exit(1);
        }
        throw err;
      }

      if (remoteDocs.size > 0) {
        console.error(`Repository ${parsed.owner}/${parsed.repo} already has stash data.`);
        console.error("Use 'stash connect' to join an existing stash.");
        process.exit(1);
      }

      // Check for existing files in the repo
      const existingFiles = await provider.listFiles();
      if (existingFiles.length > 0) {
        const choice = await promptChoice(
          `This repository has ${existingFiles.length} existing file(s).\nConvert to stash and import them?`,
          ["Yes, import files", "No, abort"]
        );

        if (choice === "No, abort") {
          console.log("Aborted. Repository unchanged.");
          process.exit(0);
        }

        remoteFilesToImport = existingFiles;
      }

      // Initialize repo with .stash structure
      console.log("Initializing repository...");
      await provider.create();

      remote = opts.remote;
    } else {
      console.error("Unknown remote format. Use 'none' or 'github:owner/repo'");
      process.exit(1);
    }
  } else {
    // No --remote flag, interactive prompt
    const providerChoice = await promptChoice("Sync provider?", [
      "None",
      "GitHub",
    ]);

    if (providerChoice === "GitHub") {
      const token = await getGitHubToken();
      if (!token) {
        console.error(
          "No GitHub token found. Run `stash auth github` first.",
        );
        process.exit(1);
      }

      const repoInput = await prompt("GitHub repo (owner/repo or owner/repo/folder): ");
      const parts = repoInput.split("/");
      if (parts.length < 2) {
        console.error("Invalid repo format. Use owner/repo or owner/repo/folder.");
        process.exit(1);
      }

      const [owner, repo, ...pathParts] = parts;
      const pathPrefix = pathParts.join("/");
      provider = new GitHubProvider(token, owner, repo, pathPrefix);

      // Check remote state using fetch()
      let remoteDocs: Map<string, Uint8Array>;
      try {
        remoteDocs = await provider.fetch();
      } catch (err) {
        const error = err as Error & { status?: number };
        if (error.status === 404) {
          console.error(`Repository ${owner}/${repo} does not exist.`);
          console.error("Create the repository on GitHub first.");
          process.exit(1);
        }
        throw err;
      }

      if (remoteDocs.size > 0) {
        console.error(`Repository ${owner}/${repo} already has stash data.`);
        console.error("Use 'stash connect' to join an existing stash.");
        process.exit(1);
      }

      // Check for existing files in the repo
      const existingFiles = await provider.listFiles();
      if (existingFiles.length > 0) {
        const choice = await promptChoice(
          `This repository has ${existingFiles.length} existing file(s).\nConvert to stash and import them?`,
          ["Yes, import files", "No, abort"]
        );

        if (choice === "No, abort") {
          console.log("Aborted. Repository unchanged.");
          process.exit(0);
        }

        remoteFilesToImport = existingFiles;
      }

      // Initialize repo with .stash structure
      console.log("Initializing repository...");
      await provider.create();

      remote = `github:${repoInput}`;
    }
  }

  try {
    const stash = await manager.create(
      name,
      opts.path,
      provider,
      remote,
      opts.description,
    );

    // Import remote files if any
    if (provider && remoteFilesToImport.length > 0) {
      console.log(`Importing ${remoteFilesToImport.length} file(s) from remote...`);
      await importRemoteFiles(stash, provider, remoteFilesToImport);
    }

    const fileCount = stash.listAllFiles().length;
    if (fileCount > 0) {
      console.log(`Total: ${fileCount} file(s) in stash.`);
    }

    // Sync to push imported files to remote
    if (provider && fileCount > 0) {
      console.log("Syncing to remote...");
      await stash.sync();
    }

    console.log(`Stash "${name}" created.`);
    if (remote) console.log(`Remote: ${remote}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

/**
 * Import files from a remote provider into a stash.
 */
async function importRemoteFiles(
  stash: Stash,
  provider: GitHubProvider,
  files: string[],
): Promise<void> {
  const stashPath = stash.path;

  for (const filePath of files) {
    const content = await provider.fetchFile(filePath);

    if (isUtf8(content)) {
      stash.write(filePath, content.toString("utf-8"));
    } else {
      // Binary file - store hash and blob
      const hash = hashBuffer(content);
      const size = content.length;
      await storeBinaryBlob(stashPath, hash, content);
      stash.writeBinary(filePath, hash, size);
    }
  }

  await stash.flush();
}

function isUtf8(buffer: Buffer): boolean {
  try {
    const text = buffer.toString("utf-8");
    return !text.includes("\uFFFD");
  } catch {
    return false;
  }
}

function hashBuffer(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function storeBinaryBlob(
  rootPath: string,
  hash: string,
  content: Buffer,
): Promise<void> {
  const blobDir = path.join(rootPath, ".stash", "blobs");
  await fs.mkdir(blobDir, { recursive: true });
  const blobPath = path.join(blobDir, `${hash}.bin`);
  await fs.writeFile(blobPath, content);
}
