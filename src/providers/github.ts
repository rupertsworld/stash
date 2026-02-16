import { Octokit } from "octokit";
import * as Automerge from "@automerge/automerge";
import type { SyncProvider } from "./types.js";
import { SyncError } from "../core/errors.js";
import type { StructureDoc } from "../core/structure.js";
import { getContent, type FileDoc } from "../core/file.js";

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
    // Check if repo exists first
    const repoExists = await this.exists();

    if (!repoExists) {
      // Check if user is the owner (personal repo) or org
      const { data: user } = await this.octokit.rest.users.getAuthenticated();

      if (user.login === this.owner) {
        // Personal repo
        await this.octokit.rest.repos.createForAuthenticatedUser({
          name: this.repo,
          private: true,
          auto_init: false,
        });
      } else {
        // Org repo
        await this.octokit.rest.repos.createInOrg({
          org: this.owner,
          name: this.repo,
          private: true,
          auto_init: false,
        });
      }
    }

    // Create initial commit with .stash placeholder
    // (Git API requires at least one commit before we can use blobs/trees)
    await this.octokit.rest.repos.createOrUpdateFileContents({
      owner: this.owner,
      repo: this.repo,
      path: this.prefixPath(".stash/.gitkeep"),
      message: "Initialize stash",
      content: Buffer.from("").toString("base64"),
    });
  }

  async exists(): Promise<boolean> {
    try {
      await this.octokit.rest.repos.get({
        owner: this.owner,
        repo: this.repo,
      });
      return true;
    } catch (err) {
      const error = err as Error & { status?: number };
      if (error.status === 404) return false;
      throw err;
    }
  }

  async isEmpty(): Promise<boolean> {
    try {
      // Check if the repo has any commits
      const { data: commits } = await this.octokit.rest.repos.listCommits({
        owner: this.owner,
        repo: this.repo,
        per_page: 1,
      });
      return commits.length === 0;
    } catch (err) {
      const error = err as Error & { status?: number };
      // 409 = empty repo (no commits), which counts as empty
      if (error.status === 409) return true;
      // 404 = repo doesn't exist
      if (error.status === 404) return true;
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
    const filesToDelete = await this.listAllFilesUnderPrefix();
    if (filesToDelete.length === 0) return;

    // Create tree entries with sha: null to delete files
    const treeEntries: TreeEntry[] = filesToDelete.map((path) => ({
      path,
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

  private async listAllFilesUnderPrefix(): Promise<string[]> {
    const files: string[] = [];

    const walk = async (dirPath: string): Promise<void> => {
      try {
        const { data } = await this.octokit.rest.repos.getContent({
          owner: this.owner,
          repo: this.repo,
          path: dirPath,
          ref: this.branch,
        });

        if (!Array.isArray(data)) return;

        for (const item of data) {
          if (item.type === "file") {
            files.push(item.path);
          } else if (item.type === "dir") {
            await walk(item.path);
          }
        }
      } catch (err) {
        const error = err as Error & { status?: number };
        if (error.status === 404) return;
        throw err;
      }
    };

    await walk(this.pathPrefix);
    return files;
  }

  async sync(
    localDocs: Map<string, Uint8Array>,
  ): Promise<Map<string, Uint8Array>> {
    try {
      // 1. Fetch remote docs
      const remoteDocs = await this.fetch();

      // 2. Get remote file paths (for deletion tracking)
      const remoteFilePaths = new Set<string>();
      const remoteStructure = remoteDocs.get("structure");
      if (remoteStructure) {
        const remoteStructureDoc = Automerge.load<StructureDoc>(remoteStructure);
        for (const filePath of Object.keys(remoteStructureDoc.files)) {
          remoteFilePaths.add(filePath);
        }
      }

      // 3. Merge all locally
      const merged = new Map<string, Uint8Array>();
      for (const [docId, localData] of localDocs) {
        let doc = Automerge.load<unknown>(localData);
        const remoteData = remoteDocs.get(docId);
        if (remoteData) {
          const remoteDoc = Automerge.load<unknown>(remoteData);
          doc = Automerge.merge(doc, remoteDoc as typeof doc);
        }
        merged.set(docId, Automerge.save(doc));
      }

      // 4. Include remote-only docs
      for (const [docId, remoteData] of remoteDocs) {
        if (!localDocs.has(docId)) {
          merged.set(docId, remoteData);
        }
      }

      // 5. Find deleted file paths
      const mergedFilePaths = new Set<string>();
      const mergedStructure = merged.get("structure");
      if (mergedStructure) {
        const mergedStructureDoc = Automerge.load<StructureDoc>(mergedStructure);
        for (const filePath of Object.keys(mergedStructureDoc.files)) {
          mergedFilePaths.add(filePath);
        }
      }
      const deletedPaths = [...remoteFilePaths].filter(p => !mergedFilePaths.has(p));

      // 6. Push all changes atomically (including deletions)
      await this.push(merged, deletedPaths);

      return merged;
    } catch (err) {
      if (err instanceof SyncError) throw err;
      const error = err as Error & { status?: number };
      if (error.status === 401 || error.status === 403) {
        throw new SyncError(
          `Authentication failed: ${error.message}`,
          false,
          error,
        );
      }
      throw new SyncError(
        `Sync failed: ${error.message}`,
        true,
        error,
      );
    }
  }

  private async fetch(): Promise<Map<string, Uint8Array>> {
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

  private async push(docs: Map<string, Uint8Array>, deletedPaths: string[] = []): Promise<void> {
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

    // Render plain text files (already prefixed by renderPlainText)
    const plainTextEntries = this.renderPlainText(docs);
    treeEntries.push(...plainTextEntries);

    // Delete removed files (set sha to null) - need to prefix
    for (const deletedPath of deletedPaths) {
      treeEntries.push({
        path: this.prefixPath(deletedPath),
        mode: "100644",
        type: "blob",
        sha: null,
      });
    }

    // Get current commit SHA
    let baseTreeSha: string | undefined;
    let parentSha: string | undefined;
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
    } catch (err) {
      const error = err as Error & { status?: number };
      if (error.status !== 404) throw err;
      // No commits yet, will create initial commit
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

  private renderPlainText(docs: Map<string, Uint8Array>): TreeEntry[] {
    const entries: TreeEntry[] = [];

    const structureData = docs.get("structure");
    if (!structureData) return entries;

    const structureDoc = Automerge.load<StructureDoc>(structureData);

    for (const [filePath, entry] of Object.entries(structureDoc.files)) {
      const fileData = docs.get(entry.docId);
      if (!fileData) continue;
      const fileDoc = Automerge.load<FileDoc>(fileData);
      const content = getContent(fileDoc);
      entries.push({
        path: this.prefixPath(filePath),
        mode: "100644",
        type: "blob",
        content,
      });
    }

    return entries;
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
}
