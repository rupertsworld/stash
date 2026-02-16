import { Octokit } from "octokit";
import type { SyncProvider } from "./types.js";

interface TreeEntry {
  path: string;
  mode: "100644";
  type: "blob";
  content?: string;
  sha?: string | null;  // null = delete file
}

export interface ParsedGitHubRemote {
  owner: string;
  repo: string;
  pathPrefix: string;
}

/**
 * Parse a GitHub remote string into components.
 * Format: github:owner/repo[/path]
 * Examples:
 *   github:user/repo → { owner: "user", repo: "repo", pathPrefix: "" }
 *   github:user/repo/notes → { owner: "user", repo: "repo", pathPrefix: "notes" }
 *   github:user/repo/a/b/c → { owner: "user", repo: "repo", pathPrefix: "a/b/c" }
 */
export function parseGitHubRemote(remote: string): ParsedGitHubRemote | null {
  if (!remote.startsWith("github:")) return null;

  const key = remote.slice("github:".length);
  const parts = key.split("/");

  if (parts.length < 2) return null;

  const [owner, repo, ...pathParts] = parts;
  if (!owner || !repo) return null;

  return {
    owner,
    repo,
    pathPrefix: pathParts.join("/"),
  };
}

export class GitHubProvider implements SyncProvider {
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  private pathPrefix: string;
  private branch: string;

  constructor(token: string, owner: string, repo: string, pathPrefix = "", branch = "main") {
    this.octokit = new Octokit({ auth: token });
    this.owner = owner;
    this.repo = repo;
    this.pathPrefix = pathPrefix;
    this.branch = branch;
  }

  private prefixPath(path: string): string {
    if (!this.pathPrefix) return path;
    return `${this.pathPrefix}/${path}`;
  }

  async create(): Promise<void> {
    // Idempotent - check if .stash already initialized
    try {
      await this.octokit.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: this.prefixPath(".stash/.gitkeep"),
      });
      // Already exists, no-op
      return;
    } catch (err) {
      const error = err as Error & { status?: number };
      if (error.status !== 404) throw err;
      // Doesn't exist, create it
    }

    // Create initial commit with .stash placeholder
    // (Git API requires at least one commit before we can use blobs/trees)
    try {
      await this.octokit.rest.repos.createOrUpdateFileContents({
        owner: this.owner,
        repo: this.repo,
        path: this.prefixPath(".stash/.gitkeep"),
        message: "Initialize stash",
        content: Buffer.from("").toString("base64"),
      });
    } catch (err) {
      const error = err as Error & { status?: number };
      // 422 = file already exists (race condition), that's fine
      if (error.status === 422) return;
      throw err;
    }
  }

  async delete(): Promise<void> {
    if (!this.pathPrefix) {
      // No path prefix - delete entire repo
      await this.octokit.rest.repos.delete({
        owner: this.owner,
        repo: this.repo,
      });
      return;
    }

    // With path prefix - delete only files under the prefix
    const relativeFiles = await this.listFiles(true);
    if (relativeFiles.length === 0) return;

    // Create tree entries with sha: null to delete files
    const treeEntries: TreeEntry[] = relativeFiles.map((relativePath) => ({
      path: this.prefixPath(relativePath),
      mode: "100644" as const,
      type: "blob" as const,
      sha: null,
    }));

    // Get current commit SHA
    const { data: ref } = await this.octokit.rest.git.getRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${this.branch}`,
    });
    const parentSha = ref.object.sha;

    const { data: commit } = await this.octokit.rest.git.getCommit({
      owner: this.owner,
      repo: this.repo,
      commit_sha: parentSha,
    });
    const baseTreeSha = commit.tree.sha;

    // Create tree with deletions
    const { data: tree } = await this.octokit.rest.git.createTree({
      owner: this.owner,
      repo: this.repo,
      tree: treeEntries,
      base_tree: baseTreeSha,
    });

    // Create commit
    const { data: newCommit } = await this.octokit.rest.git.createCommit({
      owner: this.owner,
      repo: this.repo,
      message: `Delete stash: ${this.pathPrefix}`,
      tree: tree.sha,
      parents: [parentSha],
    });

    // Update ref
    await this.octokit.rest.git.updateRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${this.branch}`,
      sha: newCommit.sha,
    });
  }

  async fetch(): Promise<Map<string, Uint8Array>> {
    const docs = new Map<string, Uint8Array>();

    try {
      // Get structure doc
      const structureBlob = await this.getFileContent(
        this.prefixPath(".stash/structure.automerge"),
      );
      if (structureBlob) {
        docs.set("structure", structureBlob);
      }

      // List and fetch doc files
      const docFiles = await this.listDirectory(this.prefixPath(".stash/docs"));
      for (const file of docFiles) {
        if (!file.endsWith(".automerge")) continue;
        const docId = file.replace(".automerge", "");
        const blob = await this.getFileContent(this.prefixPath(`.stash/docs/${file}`));
        if (blob) docs.set(docId, blob);
      }
    } catch (err) {
      const error = err as Error & { status?: number };
      if (error.status === 404) {
        // Repo is empty or .stash doesn't exist yet - that's fine
        return docs;
      }
      throw err;
    }

    return docs;
  }

  async push(docs: Map<string, Uint8Array>, files: Map<string, string | Buffer>): Promise<void> {
    // Nothing to push if no docs
    if (docs.size === 0) return;

    // Build tree entries for .stash/ files
    const treeEntries: TreeEntry[] = [];

    // Add structure doc
    const structureData = docs.get("structure");
    if (structureData) {
      const blob = await this.createBlob(structureData);
      treeEntries.push({
        path: this.prefixPath(".stash/structure.automerge"),
        mode: "100644",
        type: "blob",
        sha: blob,
      });
    }

    // Add file docs
    for (const [docId, data] of docs) {
      if (docId === "structure") continue;
      const blob = await this.createBlob(data);
      treeEntries.push({
        path: this.prefixPath(`.stash/docs/${docId}.automerge`),
        mode: "100644",
        type: "blob",
        sha: blob,
      });
    }

    // Add user files
    for (const [filePath, content] of files) {
      if (typeof content === "string") {
        treeEntries.push({
          path: this.prefixPath(filePath),
          mode: "100644",
          type: "blob",
          content,
        });
      } else {
        // Binary - need to create blob first
        const blob = await this.createBlob(content);
        treeEntries.push({
          path: this.prefixPath(filePath),
          mode: "100644",
          type: "blob",
          sha: blob,
        });
      }
    }

    // Get current commit SHA and list existing files
    let baseTreeSha: string | undefined;
    let parentSha: string | undefined;
    const existingFiles = new Set<string>();

    try {
      const { data: ref } = await this.octokit.rest.git.getRef({
        owner: this.owner,
        repo: this.repo,
        ref: `heads/${this.branch}`,
      });
      parentSha = ref.object.sha;

      const { data: commit } = await this.octokit.rest.git.getCommit({
        owner: this.owner,
        repo: this.repo,
        commit_sha: parentSha,
      });
      baseTreeSha = commit.tree.sha;

      // List existing files to compute deletions (uses efficient tree API)
      const remoteFiles = await this.listFiles();
      for (const file of remoteFiles) {
        existingFiles.add(file);
      }
    } catch (err) {
      const error = err as Error & { status?: number };
      if (error.status !== 404) throw err;
      // No commits yet, will create initial commit
    }

    // Delete files that exist on remote but not in desired state
    for (const existingPath of existingFiles) {
      if (!files.has(existingPath)) {
        treeEntries.push({
          path: this.prefixPath(existingPath),
          mode: "100644",
          type: "blob",
          sha: null,
        });
      }
    }

    // Create tree
    const { data: tree } = await this.octokit.rest.git.createTree({
      owner: this.owner,
      repo: this.repo,
      tree: treeEntries,
      base_tree: baseTreeSha,
    });

    // Create commit
    const { data: commit } = await this.octokit.rest.git.createCommit({
      owner: this.owner,
      repo: this.repo,
      message: "sync: update stash",
      tree: tree.sha,
      parents: parentSha ? [parentSha] : [],
    });

    // Update ref
    if (parentSha) {
      await this.octokit.rest.git.updateRef({
        owner: this.owner,
        repo: this.repo,
        ref: `heads/${this.branch}`,
        sha: commit.sha,
      });
    } else {
      await this.octokit.rest.git.createRef({
        owner: this.owner,
        repo: this.repo,
        ref: `refs/heads/${this.branch}`,
        sha: commit.sha,
      });
    }
  }

  private async getFileContent(
    filePath: string,
  ): Promise<Uint8Array | null> {
    try {
      const { data } = await this.octokit.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: filePath,
        ref: this.branch,
      });

      if ("content" in data && data.content) {
        return Uint8Array.from(Buffer.from(data.content, "base64"));
      }
      return null;
    } catch (err) {
      const error = err as Error & { status?: number };
      if (error.status === 404) return null;
      throw err;
    }
  }

  private async listDirectory(dirPath: string): Promise<string[]> {
    try {
      const { data } = await this.octokit.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: dirPath,
        ref: this.branch,
      });

      if (Array.isArray(data)) {
        return data.map((item) => item.name);
      }
      return [];
    } catch (err) {
      const error = err as Error & { status?: number };
      if (error.status === 404) return [];
      throw err;
    }
  }

  private async createBlob(data: Uint8Array): Promise<string> {
    const { data: blob } = await this.octokit.rest.git.createBlob({
      owner: this.owner,
      repo: this.repo,
      content: Buffer.from(data).toString("base64"),
      encoding: "base64",
    });
    return blob.sha;
  }

  /**
   * List all user files in the repo (excluding .git/).
   * Uses the Git tree API for efficiency.
   * Returns paths relative to the pathPrefix (if set).
   * @param includeInternal - if true, includes .stash/ files (for delete operations)
   */
  async listFiles(includeInternal = false): Promise<string[]> {
    try {
      // Get current commit
      const { data: ref } = await this.octokit.rest.git.getRef({
        owner: this.owner,
        repo: this.repo,
        ref: `heads/${this.branch}`,
      });

      const { data: commit } = await this.octokit.rest.git.getCommit({
        owner: this.owner,
        repo: this.repo,
        commit_sha: ref.object.sha,
      });

      // Get full tree recursively
      const { data: tree } = await this.octokit.rest.git.getTree({
        owner: this.owner,
        repo: this.repo,
        tree_sha: commit.tree.sha,
        recursive: "true",
      });

      const files: string[] = [];
      for (const item of tree.tree) {
        // Only include blobs (files), not trees (directories)
        if (item.type !== "blob" || !item.path) continue;

        let relativePath = item.path;

        // If we have a path prefix, only include files under it
        if (this.pathPrefix) {
          if (!item.path.startsWith(this.pathPrefix + "/")) continue;
          relativePath = item.path.slice(this.pathPrefix.length + 1);
        }

        // Exclude .git/ always, .stash/ unless includeInternal
        if (relativePath.startsWith(".git/")) continue;
        if (!includeInternal && relativePath.startsWith(".stash/")) continue;

        files.push(relativePath);
      }

      return files;
    } catch (err) {
      const error = err as Error & { status?: number };
      if (error.status === 404) {
        // Empty repo or branch doesn't exist
        return [];
      }
      throw err;
    }
  }

  /**
   * Fetch a single file's content.
   * Path should be relative to the pathPrefix (if set).
   */
  async fetchFile(filePath: string): Promise<Buffer> {
    const { data } = await this.octokit.rest.repos.getContent({
      owner: this.owner,
      repo: this.repo,
      path: this.prefixPath(filePath),
    });

    if ("content" in data && data.content) {
      return Buffer.from(data.content, "base64");
    }

    throw new Error(`Could not fetch file: ${filePath}`);
  }
}
