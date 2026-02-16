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

export class GitHubProvider implements SyncProvider {
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  private branch: string;

  constructor(token: string, owner: string, repo: string, branch = "main") {
    this.octokit = new Octokit({ auth: token });
    this.owner = owner;
    this.repo = repo;
    this.branch = branch;
  }

  async create(): Promise<void> {
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

    // Create initial commit with .stash placeholder
    // (Git API requires at least one commit before we can use blobs/trees)
    await this.octokit.rest.repos.createOrUpdateFileContents({
      owner: this.owner,
      repo: this.repo,
      path: ".stash/.gitkeep",
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

  async delete(): Promise<void> {
    await this.octokit.rest.repos.delete({
      owner: this.owner,
      repo: this.repo,
    });
  }

  async fetch(): Promise<Map<string, Uint8Array>> {
    const docs = new Map<string, Uint8Array>();

    try {
      // Get the current tree recursively (single API call for discovery)
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
      const { data: tree } = await this.octokit.rest.git.getTree({
        owner: this.owner,
        repo: this.repo,
        tree_sha: commit.tree.sha,
        recursive: "true",
      });

      // Fetch all .automerge blobs in parallel
      const blobFetches: Promise<void>[] = [];
      for (const item of tree.tree) {
        if (!item.path?.startsWith(".stash/") || !item.path.endsWith(".automerge")) continue;
        if (item.type !== "blob" || !item.sha) continue;

        const docId = item.path === ".stash/structure.automerge"
          ? "structure"
          : item.path.replace(".stash/docs/", "").replace(".automerge", "");

        blobFetches.push(
          this.octokit.rest.git.getBlob({
            owner: this.owner, repo: this.repo, file_sha: item.sha,
          }).then(({ data }) => {
            docs.set(docId, Uint8Array.from(Buffer.from(data.content, "base64")));
          })
        );
      }
      await Promise.all(blobFetches);
    } catch (err) {
      const error = err as Error & { status?: number };
      if (error.status === 404) return docs;
      if (error.status === 401 || error.status === 403) {
        throw new SyncError(`Authentication failed: ${error.message}`, false, error);
      }
      throw new SyncError(`Fetch failed: ${error.message}`, true, error);
    }

    return docs;
  }

  async push(docs: Map<string, Uint8Array>): Promise<void> {
    if (docs.size === 0) return;

    try {
      // Build tree entries for .stash/ files
      const treeEntries: TreeEntry[] = [];

      // Add structure doc
      const structureData = docs.get("structure");
      if (structureData) {
        const blob = await this.createBlob(structureData);
        treeEntries.push({
          path: ".stash/structure.automerge",
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
          path: `.stash/docs/${docId}.automerge`,
          mode: "100644",
          type: "blob",
          sha: blob,
        });
      }

      // Render plain text files
      const plainTextEntries = this.renderPlainText(docs);
      treeEntries.push(...plainTextEntries);

      // Get current commit SHA and tree for deletion tracking
      let baseTreeSha: string | undefined;
      let parentSha: string | undefined;
      let remoteFilePaths = new Set<string>();
      try {
        const { data: ref } = await this.octokit.rest.git.getRef({
          owner: this.owner,
          repo: this.repo,
          ref: `heads/${this.branch}`,
        });
        parentSha = ref.object.sha;

        const { data: commitData } = await this.octokit.rest.git.getCommit({
          owner: this.owner,
          repo: this.repo,
          commit_sha: parentSha,
        });
        baseTreeSha = commitData.tree.sha;

        // Get full tree to find existing plain-text files for deletion tracking
        const { data: fullTree } = await this.octokit.rest.git.getTree({
          owner: this.owner,
          repo: this.repo,
          tree_sha: commitData.tree.sha,
          recursive: "true",
        });
        for (const item of fullTree.tree) {
          if (item.type === "blob" && item.path && !item.path.startsWith(".stash/")) {
            remoteFilePaths.add(item.path);
          }
        }
      } catch (err) {
        const error = err as Error & { status?: number };
        if (error.status !== 404) throw err;
        // No commits yet, will create initial commit
      }

      // Compute deleted plain-text files
      const mergedFilePaths = new Set<string>();
      if (structureData) {
        const structureDoc = Automerge.load<StructureDoc>(structureData);
        for (const filePath of Object.keys(structureDoc.files)) {
          mergedFilePaths.add(filePath);
        }
      }
      for (const remotePath of remoteFilePaths) {
        if (!mergedFilePaths.has(remotePath)) {
          treeEntries.push({
            path: remotePath,
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
    } catch (err) {
      if (err instanceof SyncError) throw err;
      const error = err as Error & { status?: number };
      if (error.status === 401 || error.status === 403) {
        throw new SyncError(`Authentication failed: ${error.message}`, false, error);
      }
      throw new SyncError(`Push failed: ${error.message}`, true, error);
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
        path: filePath,
        mode: "100644",
        type: "blob",
        content,
      });
    }

    return entries;
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
