import { Octokit } from "octokit";
import type { PushPayload, SyncProvider } from "./types.js";

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

  private debug(msg: string, ...args: unknown[]): void {
    if (process.env.STASH_DEBUG) {
      console.error("[stash]", msg, ...args);
    }
  }

  private async ensureBranchExists(
    bootstrapStructureData?: Uint8Array,
  ): Promise<string> {
    const { data: branches } = await this.octokit.rest.repos.listBranches({
      owner: this.owner,
      repo: this.repo,
      per_page: 1,
    });

    const isEmptyRepo = branches.length === 0;
    this.debug("repos.listBranches: count =", branches.length, "→", isEmptyRepo ? "empty" : "has branches");
    if (isEmptyRepo) {
      this.debug("empty repo → contents API bootstrap");
      if (!bootstrapStructureData) {
        throw new Error("Cannot bootstrap empty repository without structure data");
      }
      const { data } = await this.octokit.rest.repos.createOrUpdateFileContents({
        owner: this.owner,
        repo: this.repo,
        path: this.prefixPath(".stash/structure.automerge"),
        message: "init: bootstrap repository for stash sync",
        content: Buffer.from(bootstrapStructureData).toString("base64"),
        branch: this.branch,
      });
      const sha = data.commit?.sha;
      if (!sha) throw new Error("Missing commit SHA from bootstrap contents API");
      this.debug("createOrUpdateFileContents ok, sha:", sha.slice(0, 7));
      return sha;
    }

    this.debug("has branches → repos.get for default_branch");
    const { data: repo } = await this.octokit.rest.repos.get({
      owner: this.owner,
      repo: this.repo,
    });
    this.branch = repo.default_branch ?? "main";
    this.debug("using branch:", this.branch);

    const { data: ref } = await this.octokit.rest.git.getRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${this.branch}`,
    });
    this.debug("getRef ok, sha:", ref.object.sha.slice(0, 7));
    return ref.object.sha;
  }

  private async getHeadTreeState(
    headSha: string,
    includeInternal = false,
  ): Promise<{ baseTreeSha: string; files: string[] }> {
    this.debug("getHeadTreeState: getCommit", headSha.slice(0, 7));
    const { data: commit } = await this.octokit.rest.git.getCommit({
      owner: this.owner,
      repo: this.repo,
      commit_sha: headSha,
    });
    const baseTreeSha = commit.tree.sha;
    this.debug("getHeadTreeState: getTree", baseTreeSha.slice(0, 7), "recursive");
    const { data: tree } = await this.octokit.rest.git.getTree({
      owner: this.owner,
      repo: this.repo,
      tree_sha: baseTreeSha,
      recursive: "true",
    });

    const files: string[] = [];
    for (const item of tree.tree) {
      if (item.type !== "blob" || !item.path) continue;

      let relativePath = item.path;
      if (this.pathPrefix) {
        if (!item.path.startsWith(this.pathPrefix + "/")) continue;
        relativePath = item.path.slice(this.pathPrefix.length + 1);
      }

      if (relativePath.startsWith(".git/")) continue;
      if (!includeInternal && relativePath.startsWith(".stash/")) continue;
      files.push(relativePath);
    }

    this.debug("getHeadTreeState ok, files:", files.length);
    return { baseTreeSha, files };
  }

  private async listRemoteFiles(includeInternal = false): Promise<string[]> {
    try {
      const { data: ref } = await this.octokit.rest.git.getRef({
        owner: this.owner,
        repo: this.repo,
        ref: `heads/${this.branch}`,
      });
      const { files } = await this.getHeadTreeState(ref.object.sha, includeInternal);
      return files;
    } catch (err) {
      const error = err as Error & { status?: number };
      if (error.status === 404) return [];
      throw err;
    }
  }

  async create(): Promise<void> {
    try {
      await this.octokit.rest.repos.get({
        owner: this.owner,
        repo: this.repo,
      });
      return;
    } catch (err) {
      const error = err as Error & { status?: number };
      if (error.status !== 404) throw err;
    }

    const { data: me } = await this.octokit.rest.users.getAuthenticated();
    try {
      if (me.login === this.owner) {
        await this.octokit.rest.repos.createForAuthenticatedUser({
          name: this.repo,
          private: true,
          auto_init: false,
        });
      } else {
        await this.octokit.rest.repos.createInOrg({
          org: this.owner,
          name: this.repo,
          private: true,
        });
      }
    } catch (err) {
      const error = err as Error & { status?: number };
      // Already created by another actor after our get() check.
      if (error.status === 409 || error.status === 422) return;
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
    const relativeFiles = await this.listRemoteFiles(true);
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
      await this.octokit.rest.repos.get({
        owner: this.owner,
        repo: this.repo,
      });
    } catch (err) {
      const error = err as Error & { status?: number };
      if (error.status === 404) {
        throw Object.assign(new Error("Remote not found"), { status: 404 });
      }
      throw err;
    }

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

  async push(payload: PushPayload): Promise<void> {
    const { docs, files, changedPaths, pathsToDelete } = payload;

    if (docs.size === 0) return;

    this.debug("push: starting", "docs:", docs.size, "files:", files.size);
    const parentSha = await this.ensureBranchExists(docs.get("structure"));
    this.debug("push: parentSha", parentSha.slice(0, 7));

    // Empty changedPaths (e.g. first sync) => push all. Non-empty => incremental.
    const changedArr = changedPaths ? [...changedPaths] : [];
    const changedSet = changedArr.length > 0 ? new Set(changedArr) : null;
    const toDelete = pathsToDelete ? [...pathsToDelete] : null;
    this.debug("push: changedPaths:", changedSet ? changedSet.size : "all", "pathsToDelete:", toDelete?.length ?? 0);

    let baseTreeSha: string;
    let existingFiles: string[] | null = null;
    if (toDelete) {
      this.debug("push: getCommit (pathsToDelete path)");
      const { data: commit } = await this.octokit.rest.git.getCommit({
        owner: this.owner,
        repo: this.repo,
        commit_sha: parentSha,
      });
      baseTreeSha = commit.tree.sha;
      this.debug("push: baseTreeSha", baseTreeSha.slice(0, 7));
    } else {
      this.debug("push: getHeadTreeState");
      const state = await this.getHeadTreeState(parentSha);
      baseTreeSha = state.baseTreeSha;
      existingFiles = state.files;
      this.debug("push: baseTreeSha", baseTreeSha.slice(0, 7), "existingFiles:", existingFiles.length);
    }

    const treeEntries: TreeEntry[] = [];

    const includePath = (treePath: string): boolean => {
      if (!changedSet) return true; // null = push all
      const relative = this.pathPrefix ? treePath.replace(`${this.pathPrefix}/`, "") : treePath;
      return changedSet.has(relative) || changedSet.has(treePath);
    };

    if (includePath(".stash/structure.automerge")) {
      const structureData = docs.get("structure");
      if (structureData) {
        this.debug("createBlob: .stash/structure.automerge", structureData.length, "bytes");
        const blob = await this.createBlob(structureData);
        this.debug("createBlob ok:", blob.slice(0, 7));
        treeEntries.push({
          path: this.prefixPath(".stash/structure.automerge"),
          mode: "100644",
          type: "blob",
          sha: blob,
        });
      }
    }

    for (const [docId, data] of docs) {
      if (docId === "structure") continue;
      const docPath = `.stash/docs/${docId}.automerge`;
      if (includePath(docPath)) {
        this.debug("createBlob:", docPath, data.length, "bytes");
        const blob = await this.createBlob(data);
        this.debug("createBlob ok:", blob.slice(0, 7));
        treeEntries.push({
          path: this.prefixPath(docPath),
          mode: "100644",
          type: "blob",
          sha: blob,
        });
      }
    }

    for (const [filePath, content] of files) {
      if (!includePath(filePath)) continue;
      const data =
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : content;
      const size = data instanceof Buffer ? data.length : data.byteLength;
      this.debug("createBlob:", filePath, size, "bytes");
      const blob = await this.createBlob(data);
      this.debug("createBlob ok:", blob.slice(0, 7));
      treeEntries.push({
        path: this.prefixPath(filePath),
        mode: "100644",
        type: "blob",
        sha: blob,
      });
    }

    if (toDelete) {
      for (const path of toDelete) {
        this.debug("delete:", path);
        treeEntries.push({
          path: this.prefixPath(path),
          mode: "100644",
          type: "blob",
          sha: null,
        });
      }
    } else if (existingFiles) {
      for (const existingPath of existingFiles) {
        if (!files.has(existingPath)) {
          this.debug("delete (existing):", existingPath);
          treeEntries.push({
            path: this.prefixPath(existingPath),
            mode: "100644",
            type: "blob",
            sha: null,
          });
        }
      }
    }

    // Create tree
    const paths = treeEntries.map((e) => e.path);
    const duplicates = paths.filter((p, i) => paths.indexOf(p) !== i);
    this.debug("createTree:", {
      baseTreeSha: baseTreeSha.slice(0, 7),
      entryCount: treeEntries.length,
      paths,
      duplicatePaths: [...new Set(duplicates)],
    });
    const { data: tree } = await this.octokit.rest.git.createTree({
      owner: this.owner,
      repo: this.repo,
      tree: treeEntries,
      base_tree: baseTreeSha,
    });
    this.debug("createTree ok:", tree.sha.slice(0, 7));

    // Create commit
    this.debug("createCommit");
    const { data: commit } = await this.octokit.rest.git.createCommit({
      owner: this.owner,
      repo: this.repo,
      message: "sync: update stash",
      tree: tree.sha,
      parents: [parentSha],
    });
    this.debug("createCommit ok:", commit.sha.slice(0, 7));

    // Update ref
    this.debug("updateRef");
    await this.octokit.rest.git.updateRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${this.branch}`,
      sha: commit.sha,
    });
    this.debug("updateRef ok, push complete");
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
