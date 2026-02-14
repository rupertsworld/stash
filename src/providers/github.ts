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
  sha?: string | null;
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

  async sync(
    localDocs: Map<string, Uint8Array>,
  ): Promise<Map<string, Uint8Array>> {
    try {
      // 1. Fetch remote docs
      const remoteDocs = await this.fetch();

      // 2. Merge all locally
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

      // 3. Include remote-only docs
      for (const [docId, remoteData] of remoteDocs) {
        if (!localDocs.has(docId)) {
          merged.set(docId, remoteData);
        }
      }

      // 4. Push all changes atomically
      await this.push(merged);

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
        ".stash/structure.automerge",
      );
      if (structureBlob) {
        docs.set("structure", structureBlob);
      }

      // List and fetch doc files
      const docFiles = await this.listDirectory(".stash/docs");
      for (const file of docFiles) {
        if (!file.endsWith(".automerge")) continue;
        const docId = file.replace(".automerge", "");
        const blob = await this.getFileContent(`.stash/docs/${file}`);
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

  private async push(docs: Map<string, Uint8Array>): Promise<void> {
    // Nothing to push if no docs
    if (docs.size === 0) return;

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
        path: filePath,
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
