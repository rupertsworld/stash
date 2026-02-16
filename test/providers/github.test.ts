import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Automerge from "@automerge/automerge";
import { GitHubProvider, parseGitHubRemote } from "../../src/providers/github.js";
import { SyncError } from "../../src/core/errors.js";
import { createStructureDoc, addFile } from "../../src/core/structure.js";
import { createFileDoc, type FileDoc } from "../../src/core/file.js";
import type { StructureDoc } from "../../src/core/structure.js";

// Mock Octokit
vi.mock("octokit", () => {
  return {
    Octokit: vi.fn().mockImplementation(() => ({
      rest: {
        repos: {
          getContent: vi.fn(),
        },
        git: {
          getRef: vi.fn(),
          getCommit: vi.fn(),
          getTree: vi.fn(),
          createTree: vi.fn(),
          createCommit: vi.fn(),
          updateRef: vi.fn(),
          createRef: vi.fn(),
          createBlob: vi.fn(),
        },
      },
    })),
  };
});

function createTestDocs(): Map<string, Uint8Array> {
  let structureDoc = createStructureDoc();
  const { doc, docId } = addFile(structureDoc, "hello.md");
  structureDoc = doc;
  const fileDoc = createFileDoc("Hello!");

  const docs = new Map<string, Uint8Array>();
  docs.set("structure", Automerge.save(structureDoc));
  docs.set(docId, Automerge.save(fileDoc));
  return docs;
}

describe("GitHubProvider", () => {
  let provider: GitHubProvider;
  let mockOctokit: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    provider = new GitHubProvider("test-token", "owner", "repo");
    // Access the mocked octokit
    const { Octokit } = await import("octokit");
    mockOctokit = (Octokit as any).mock.results[
      (Octokit as any).mock.results.length - 1
    ].value;
  });

  it("should push to empty remote (first push)", async () => {
    const localDocs = createTestDocs();

    // Mock: remote has no commits yet (404 on getRef)
    mockOctokit.rest.git.getRef.mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );
    mockOctokit.rest.git.createBlob.mockResolvedValue({
      data: { sha: "blob-sha" },
    });
    mockOctokit.rest.git.createTree.mockResolvedValue({
      data: { sha: "tree-sha" },
    });
    mockOctokit.rest.git.createCommit.mockResolvedValue({
      data: { sha: "commit-sha" },
    });
    mockOctokit.rest.git.createRef.mockResolvedValue({ data: {} });

    await provider.push(localDocs, new Map([["hello.md", "Hello!"]]));

    // Should create initial ref since none existed
    expect(mockOctokit.rest.git.createRef).toHaveBeenCalled();
  });

  it("should fetch remote docs", async () => {
    // Create remote docs
    let remoteStructure = createStructureDoc();
    const r1 = addFile(remoteStructure, "remote.md");
    remoteStructure = r1.doc;
    const remoteFile = createFileDoc("Remote content");

    const remoteStructureBase64 = Buffer.from(
      Automerge.save(remoteStructure),
    ).toString("base64");
    const remoteFileBase64 = Buffer.from(Automerge.save(remoteFile)).toString(
      "base64",
    );

    // Mock fetch
    mockOctokit.rest.repos.getContent.mockImplementation(
      async ({ path }: { path: string }) => {
        if (path === ".stash/structure.automerge") {
          return { data: { content: remoteStructureBase64 } };
        }
        if (path === ".stash/docs") {
          return {
            data: [{ name: `${r1.docId}.automerge` }],
          };
        }
        if (path === `.stash/docs/${r1.docId}.automerge`) {
          return { data: { content: remoteFileBase64 } };
        }
        throw Object.assign(new Error("Not Found"), { status: 404 });
      },
    );

    const result = await provider.fetch();

    // Should have structure + remote file
    expect(result.has("structure")).toBe(true);
    expect(result.has(r1.docId)).toBe(true);
    expect(result.size).toBe(2);
  });

  it("should throw error on auth failure during fetch", async () => {
    mockOctokit.rest.repos.getContent.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), { status: 401 }),
    );

    await expect(provider.fetch()).rejects.toThrow();
  });

  it("should throw error on server failure during fetch", async () => {
    mockOctokit.rest.repos.getContent.mockRejectedValue(
      Object.assign(new Error("Server Error"), { status: 500 }),
    );

    await expect(provider.fetch()).rejects.toThrow();
  });

  it("should render plain text files in push", async () => {
    const localDocs = createTestDocs();

    // Mock push operations
    mockOctokit.rest.git.getRef.mockResolvedValue({
      data: { object: { sha: "parent-sha" } },
    });
    mockOctokit.rest.git.getCommit.mockResolvedValue({
      data: { tree: { sha: "base-tree-sha" } },
    });
    mockOctokit.rest.git.getTree.mockResolvedValue({
      data: { tree: [] },
    });
    mockOctokit.rest.git.createBlob.mockResolvedValue({
      data: { sha: "blob-sha" },
    });
    mockOctokit.rest.git.createTree.mockResolvedValue({
      data: { sha: "tree-sha" },
    });
    mockOctokit.rest.git.createCommit.mockResolvedValue({
      data: { sha: "commit-sha" },
    });
    mockOctokit.rest.git.updateRef.mockResolvedValue({ data: {} });

    await provider.push(localDocs, new Map([["hello.md", "Hello!"]]));

    // Verify createTree was called with rendered plain text files
    const treeCall = mockOctokit.rest.git.createTree.mock.calls[0][0];
    const paths = treeCall.tree.map((e: any) => e.path);
    expect(paths).toContain("hello.md");
  });

  describe("path prefix support", () => {
    let prefixedProvider: GitHubProvider;

    beforeEach(async () => {
      prefixedProvider = new GitHubProvider("test-token", "owner", "repo", "notes");
      const { Octokit } = await import("octokit");
      mockOctokit = (Octokit as any).mock.results[
        (Octokit as any).mock.results.length - 1
      ].value;
    });

    it("should prefix .stash paths when fetching", async () => {
      // Mock fetch - return 404 for all paths (empty stash)
      mockOctokit.rest.repos.getContent.mockRejectedValue(
        Object.assign(new Error("Not Found"), { status: 404 }),
      );

      await prefixedProvider.fetch();

      // Check that getContent was called with prefixed paths
      const calls = mockOctokit.rest.repos.getContent.mock.calls;
      const paths = calls.map((c: any) => c[0].path);
      expect(paths).toContain("notes/.stash/structure.automerge");
    });

    it("should prefix all paths when pushing", async () => {
      const localDocs = createTestDocs();

      // Mock push operations
      mockOctokit.rest.git.getRef.mockResolvedValue({
        data: { object: { sha: "parent-sha" } },
      });
      mockOctokit.rest.git.getCommit.mockResolvedValue({
        data: { tree: { sha: "base-tree-sha" } },
      });
      mockOctokit.rest.git.getTree.mockResolvedValue({
        data: { tree: [] },
      });
      mockOctokit.rest.git.createBlob.mockResolvedValue({
        data: { sha: "blob-sha" },
      });
      mockOctokit.rest.git.createTree.mockResolvedValue({
        data: { sha: "tree-sha" },
      });
      mockOctokit.rest.git.createCommit.mockResolvedValue({
        data: { sha: "commit-sha" },
      });
      mockOctokit.rest.git.updateRef.mockResolvedValue({ data: {} });

      await prefixedProvider.push(localDocs, new Map([["hello.md", "Hello!"]]));

      // Verify all paths in tree are prefixed
      const treeCall = mockOctokit.rest.git.createTree.mock.calls[0][0];
      const paths = treeCall.tree.map((e: any) => e.path);

      // Should have prefixed paths
      expect(paths).toContain("notes/.stash/structure.automerge");
      expect(paths).toContain("notes/hello.md");

      // Should NOT have unprefixed paths
      expect(paths).not.toContain(".stash/structure.automerge");
      expect(paths).not.toContain("hello.md");
    });

    it("should handle nested path prefixes", async () => {
      const nestedProvider = new GitHubProvider("test-token", "owner", "repo", "projects/work/notes");
      const { Octokit } = await import("octokit");
      const nestedMock = (Octokit as any).mock.results[
        (Octokit as any).mock.results.length - 1
      ].value;

      const localDocs = createTestDocs();

      // Mock push operations
      nestedMock.rest.git.getRef.mockResolvedValue({
        data: { object: { sha: "parent-sha" } },
      });
      nestedMock.rest.git.getCommit.mockResolvedValue({
        data: { tree: { sha: "base-tree-sha" } },
      });
      nestedMock.rest.git.getTree.mockResolvedValue({
        data: { tree: [] },
      });
      nestedMock.rest.git.createBlob.mockResolvedValue({
        data: { sha: "blob-sha" },
      });
      nestedMock.rest.git.createTree.mockResolvedValue({
        data: { sha: "tree-sha" },
      });
      nestedMock.rest.git.createCommit.mockResolvedValue({
        data: { sha: "commit-sha" },
      });
      nestedMock.rest.git.updateRef.mockResolvedValue({ data: {} });

      await nestedProvider.push(localDocs, new Map([["hello.md", "Hello!"]]));

      const treeCall = nestedMock.rest.git.createTree.mock.calls[0][0];
      const paths = treeCall.tree.map((e: any) => e.path);

      expect(paths).toContain("projects/work/notes/.stash/structure.automerge");
      expect(paths).toContain("projects/work/notes/hello.md");
    });
  });

  describe("delete behavior", () => {
    it("should delete entire repo when no path prefix", async () => {
      mockOctokit.rest.repos.delete = vi.fn().mockResolvedValue({});

      await provider.delete();

      expect(mockOctokit.rest.repos.delete).toHaveBeenCalledWith({
        owner: "owner",
        repo: "repo",
      });
    });

    it("should delete only folder contents when path prefix is set", async () => {
      const prefixedProvider = new GitHubProvider("test-token", "owner", "repo", "notes");
      const { Octokit } = await import("octokit");
      const prefixMock = (Octokit as any).mock.results[
        (Octokit as any).mock.results.length - 1
      ].value;

      // Mock listing files via tree API (includes .stash/ when includeInternal=true)
      prefixMock.rest.git.getTree.mockResolvedValue({
        data: {
          tree: [
            { path: "notes/readme.md", type: "blob" },
            { path: "notes/.stash/meta.json", type: "blob" },
            { path: "notes/.stash/structure.automerge", type: "blob" },
            { path: "notes/.stash/docs/abc123.automerge", type: "blob" },
          ],
        },
      });

      prefixMock.rest.git.getRef.mockResolvedValue({
        data: { object: { sha: "parent-sha" } },
      });
      prefixMock.rest.git.getCommit.mockResolvedValue({
        data: { tree: { sha: "base-tree-sha" } },
      });
      prefixMock.rest.git.createTree.mockResolvedValue({
        data: { sha: "tree-sha" },
      });
      prefixMock.rest.git.createCommit.mockResolvedValue({
        data: { sha: "commit-sha" },
      });
      prefixMock.rest.git.updateRef.mockResolvedValue({ data: {} });
      prefixMock.rest.repos.delete = vi.fn();

      await prefixedProvider.delete();

      // Should NOT delete the repo
      expect(prefixMock.rest.repos.delete).not.toHaveBeenCalled();

      // Should create a commit that deletes files (sha: null)
      const treeCall = prefixMock.rest.git.createTree.mock.calls[0][0];
      const deletedPaths = treeCall.tree
        .filter((e: any) => e.sha === null)
        .map((e: any) => e.path);

      // All files should be deleted with their full prefixed paths
      expect(deletedPaths).toContain("notes/readme.md");
      expect(deletedPaths).toContain("notes/.stash/meta.json");
      expect(deletedPaths).toContain("notes/.stash/structure.automerge");
      expect(deletedPaths).toContain("notes/.stash/docs/abc123.automerge");
    });
  });
});

describe("listFiles", () => {
  let provider: GitHubProvider;
  let mockOctokit: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    provider = new GitHubProvider("test-token", "owner", "repo");
    const { Octokit } = await import("octokit");
    mockOctokit = (Octokit as any).mock.results[
      (Octokit as any).mock.results.length - 1
    ].value;
  });

  it("should list all files excluding .stash/", async () => {
    // Mock the tree API
    mockOctokit.rest.git.getRef.mockResolvedValue({
      data: { object: { sha: "head-sha" } },
    });
    mockOctokit.rest.git.getCommit.mockResolvedValue({
      data: { tree: { sha: "tree-sha" } },
    });
    mockOctokit.rest.git.getTree.mockResolvedValue({
      data: {
        tree: [
          { path: "readme.md", type: "blob" },
          { path: "notes/hello.md", type: "blob" },
          { path: "notes/world.md", type: "blob" },
          { path: ".stash/structure.automerge", type: "blob" },
          { path: ".stash/docs/abc.automerge", type: "blob" },
          { path: ".gitignore", type: "blob" },
        ],
      },
    });

    const files = await provider.listFiles();

    expect(files).toContain("readme.md");
    expect(files).toContain("notes/hello.md");
    expect(files).toContain("notes/world.md");
    expect(files).toContain(".gitignore");
    expect(files).not.toContain(".stash/structure.automerge");
    expect(files).not.toContain(".stash/docs/abc.automerge");
    expect(files).toHaveLength(4);
  });

  it("should return empty array for empty repo", async () => {
    mockOctokit.rest.git.getRef.mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );

    const files = await provider.listFiles();

    expect(files).toEqual([]);
  });

  it("should return empty array when repo has only .stash/ files", async () => {
    mockOctokit.rest.git.getRef.mockResolvedValue({
      data: { object: { sha: "head-sha" } },
    });
    mockOctokit.rest.git.getCommit.mockResolvedValue({
      data: { tree: { sha: "tree-sha" } },
    });
    mockOctokit.rest.git.getTree.mockResolvedValue({
      data: {
        tree: [
          { path: ".stash/structure.automerge", type: "blob" },
          { path: ".stash/docs/abc.automerge", type: "blob" },
        ],
      },
    });

    const files = await provider.listFiles();

    expect(files).toEqual([]);
  });

  it("should exclude directories (only return blobs)", async () => {
    mockOctokit.rest.git.getRef.mockResolvedValue({
      data: { object: { sha: "head-sha" } },
    });
    mockOctokit.rest.git.getCommit.mockResolvedValue({
      data: { tree: { sha: "tree-sha" } },
    });
    mockOctokit.rest.git.getTree.mockResolvedValue({
      data: {
        tree: [
          { path: "readme.md", type: "blob" },
          { path: "notes", type: "tree" },
          { path: "notes/hello.md", type: "blob" },
        ],
      },
    });

    const files = await provider.listFiles();

    expect(files).toContain("readme.md");
    expect(files).toContain("notes/hello.md");
    expect(files).not.toContain("notes");
    expect(files).toHaveLength(2);
  });

  it("should work with path prefix", async () => {
    const prefixedProvider = new GitHubProvider("test-token", "owner", "repo", "subfolder");
    const { Octokit } = await import("octokit");
    const prefixMock = (Octokit as any).mock.results[
      (Octokit as any).mock.results.length - 1
    ].value;

    prefixMock.rest.git.getRef.mockResolvedValue({
      data: { object: { sha: "head-sha" } },
    });
    prefixMock.rest.git.getCommit.mockResolvedValue({
      data: { tree: { sha: "tree-sha" } },
    });
    prefixMock.rest.git.getTree.mockResolvedValue({
      data: {
        tree: [
          { path: "other/file.md", type: "blob" },
          { path: "subfolder/readme.md", type: "blob" },
          { path: "subfolder/notes/hello.md", type: "blob" },
          { path: "subfolder/.stash/structure.automerge", type: "blob" },
        ],
      },
    });

    const files = await prefixedProvider.listFiles();

    // Should only return files under prefix, with prefix stripped
    expect(files).toContain("readme.md");
    expect(files).toContain("notes/hello.md");
    expect(files).not.toContain("subfolder/readme.md");
    expect(files).not.toContain("other/file.md");
    expect(files).not.toContain(".stash/structure.automerge");
    expect(files).toHaveLength(2);
  });
});

describe("fetchFile", () => {
  let provider: GitHubProvider;
  let mockOctokit: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    provider = new GitHubProvider("test-token", "owner", "repo");
    const { Octokit } = await import("octokit");
    mockOctokit = (Octokit as any).mock.results[
      (Octokit as any).mock.results.length - 1
    ].value;
  });

  it("should fetch text file content", async () => {
    const content = "Hello, world!";
    mockOctokit.rest.repos.getContent.mockResolvedValue({
      data: { content: Buffer.from(content).toString("base64") },
    });

    const result = await provider.fetchFile("readme.md");

    expect(result.toString("utf-8")).toBe(content);
    expect(mockOctokit.rest.repos.getContent).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      path: "readme.md",
    });
  });

  it("should fetch binary file content", async () => {
    const binaryContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    mockOctokit.rest.repos.getContent.mockResolvedValue({
      data: { content: binaryContent.toString("base64") },
    });

    const result = await provider.fetchFile("image.png");

    expect(result).toEqual(binaryContent);
  });

  it("should apply path prefix", async () => {
    const prefixedProvider = new GitHubProvider("test-token", "owner", "repo", "notes");
    const { Octokit } = await import("octokit");
    const prefixMock = (Octokit as any).mock.results[
      (Octokit as any).mock.results.length - 1
    ].value;

    prefixMock.rest.repos.getContent.mockResolvedValue({
      data: { content: Buffer.from("content").toString("base64") },
    });

    await prefixedProvider.fetchFile("hello.md");

    expect(prefixMock.rest.repos.getContent).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      path: "notes/hello.md",
    });
  });

  it("should throw on 404", async () => {
    mockOctokit.rest.repos.getContent.mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );

    await expect(provider.fetchFile("nonexistent.md")).rejects.toThrow();
  });
});

describe("parseGitHubRemote", () => {
  // Import the helper once implemented
  it("should parse github:owner/repo as root", () => {
    const result = parseGitHubRemote("github:owner/repo");
    expect(result).toEqual({ owner: "owner", repo: "repo", pathPrefix: "" });
  });

  it("should parse github:owner/repo/path as subdirectory", () => {
    const result = parseGitHubRemote("github:owner/repo/notes");
    expect(result).toEqual({ owner: "owner", repo: "repo", pathPrefix: "notes" });
  });

  it("should parse github:owner/repo/nested/path correctly", () => {
    const result = parseGitHubRemote("github:owner/repo/projects/work/notes");
    expect(result).toEqual({ owner: "owner", repo: "repo", pathPrefix: "projects/work/notes" });
  });

  it("should return null for invalid format", () => {
    expect(parseGitHubRemote("gitlab:owner/repo")).toBeNull();
    expect(parseGitHubRemote("github:owner")).toBeNull();
    expect(parseGitHubRemote("invalid")).toBeNull();
  });
});
