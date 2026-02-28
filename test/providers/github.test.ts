import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Automerge from "@automerge/automerge";
import { GitHubProvider, parseGitHubRemote } from "../../src/providers/github.js";
import { SyncError } from "../../src/core/errors.js";
import { createStructureDoc, addFile } from "../../src/core/structure.js";
import { createFileDoc, type FileDoc } from "../../src/core/file.js";
import type { StructureDoc } from "../../src/core/structure.js";
import type { SyncState } from "../../src/providers/types.js";

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

function createPushPayload(
  docs?: Map<string, Uint8Array>,
  files?: Map<string, string | Buffer>,
  opts?: { changedPaths?: Set<string>; pathsToDelete?: string[] },
) {
  const payload = {
    docs: docs ?? createTestDocs(),
    files: files ?? new Map([["hello.md", "Hello!"]]),
    ...opts,
  };
  return payload;
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
    mockOctokit.rest.users = {
      getAuthenticated: vi.fn().mockResolvedValue({ data: { login: "owner" } }),
    };
    mockOctokit.rest.repos.createForAuthenticatedUser = vi.fn().mockResolvedValue({ data: {} });
    mockOctokit.rest.repos.createInOrg = vi.fn().mockResolvedValue({ data: {} });
    mockOctokit.rest.repos.get = vi.fn().mockResolvedValue({
      data: { pushed_at: "2024-01-01T00:00:00Z", default_branch: "main" },
    });
    mockOctokit.rest.repos.listBranches = vi.fn().mockResolvedValue({
      data: [{ name: "main" }],
    });
    mockOctokit.rest.repos.createOrUpdateFileContents = vi.fn().mockResolvedValue({
      data: { commit: { sha: "bootstrap-via-contents-sha" } },
    });
  });

  it("should not expose listFiles as a public provider method", () => {
    expect("listFiles" in provider).toBe(false);
  });

  it("should accept docs/files payload and push to remote", async () => {
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

    await provider.push(createPushPayload());

    const treeCall = mockOctokit.rest.git.createTree.mock.calls[0][0];
    const paths = treeCall.tree.map((e: any) => e.path);
    expect(paths).toContain(".stash/structure.automerge");
    expect(paths).toContain("hello.md");
  });

  it("should use createBlob for all file content (no inline content in tree)", async () => {
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

    await provider.push(
      createPushPayload(createTestDocs(), new Map([["readme.md", "Hello\nWorld!"]])),
    );

    // All tree entries must use sha, never inline content (avoids "Invalid tree info")
    const treeCall = mockOctokit.rest.git.createTree.mock.calls[0][0];
    for (const entry of treeCall.tree) {
      expect("content" in entry).toBe(false);
    }
    expect(mockOctokit.rest.git.createBlob).toHaveBeenCalled();
  });

  it("should push to empty remote (first push)", async () => {
    const localDocs = createTestDocs();

    mockOctokit.rest.repos.listBranches.mockResolvedValueOnce({
      data: [],
    });
    mockOctokit.rest.repos.createOrUpdateFileContents.mockResolvedValueOnce({
      data: { commit: { sha: "bootstrap-commit-sha" } },
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

    await provider.push(createPushPayload(localDocs));

    expect(mockOctokit.rest.repos.createOrUpdateFileContents).toHaveBeenCalled();
    expect(mockOctokit.rest.git.updateRef).toHaveBeenCalled();
  });

  it("should handle GitHub empty-repo blob quirk by bootstrapping first", async () => {
    const localDocs = createTestDocs();

    mockOctokit.rest.repos.listBranches.mockResolvedValueOnce({
      data: [],
    });
    mockOctokit.rest.repos.createOrUpdateFileContents.mockResolvedValueOnce({
      data: { commit: { sha: "bootstrap-commit-sha" } },
    });
    mockOctokit.rest.git.getCommit.mockResolvedValue({
      data: { tree: { sha: "base-tree-sha" } },
    });
    mockOctokit.rest.git.getTree.mockResolvedValue({
      data: { tree: [] },
    });
    mockOctokit.rest.git.createTree.mockResolvedValue({
      data: { sha: "tree-sha" },
    });
    mockOctokit.rest.git.createCommit.mockResolvedValue({
      data: { sha: "commit-sha" },
    });
    mockOctokit.rest.git.updateRef.mockResolvedValue({ data: {} });

    // Simulate createBlob failing until bootstrap (contents API) has run.
    mockOctokit.rest.git.createBlob.mockImplementation(async () => {
      if (mockOctokit.rest.repos.createOrUpdateFileContents.mock.calls.length === 0) {
        const err = new Error(
          "Git Repository is empty. - https://docs.github.com/rest/git/blobs#create-a-blob",
        ) as Error & { status?: number };
        throw err;
      }
      return { data: { sha: "blob-sha" } };
    });

    await expect(
      provider.push(createPushPayload(localDocs)),
    ).resolves.toBeUndefined();
    expect(mockOctokit.rest.repos.createOrUpdateFileContents).toHaveBeenCalled();
    expect(mockOctokit.rest.git.updateRef).toHaveBeenCalled();
  });

  it("should use repo default_branch (e.g. master) for getRef and updateRef", async () => {
    mockOctokit.rest.repos.listBranches.mockResolvedValueOnce({
      data: [{ name: "master" }],
    });
    mockOctokit.rest.repos.get.mockResolvedValueOnce({
      data: { default_branch: "master" },
    });
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

    await provider.push(createPushPayload());

    expect(mockOctokit.rest.git.getRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "heads/master" }),
    );
    expect(mockOctokit.rest.git.updateRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "heads/master" }),
    );
  });

  it("should bootstrap via contents API when listBranches returns empty", async () => {
    const localDocs = createTestDocs();

    mockOctokit.rest.repos.listBranches.mockResolvedValueOnce({
      data: [],
    });
    mockOctokit.rest.repos.createOrUpdateFileContents.mockResolvedValueOnce({
      data: { commit: { sha: "bootstrap-commit-sha" } },
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

    await expect(
      provider.push({ docs: localDocs, files: new Map([["hello.md", "Hello!"]]) }),
    ).resolves.toBeUndefined();
    expect(mockOctokit.rest.repos.createOrUpdateFileContents).toHaveBeenCalled();
    expect(mockOctokit.rest.git.updateRef).toHaveBeenCalled();
  });

  it("should fetch remote docs", async () => {
    // Create remote docs
    let remoteStructure = createStructureDoc();
    const r1 = addFile(remoteStructure, "remote.md");
    remoteStructure = r1.doc;
    const remoteFile = createFileDoc("Remote content");

    const structureBlob = Automerge.save(remoteStructure);
    const fileBlob = Automerge.save(remoteFile);

    // Mock fetch via tree-based approach
    mockOctokit.rest.git.getRef = vi.fn().mockResolvedValue({
      data: { object: { sha: "head-sha-1" } },
    });
    mockOctokit.rest.git.getCommit = vi.fn().mockResolvedValue({
      data: { tree: { sha: "tree-sha-1" } },
    });
    mockOctokit.rest.git.getTree = vi.fn().mockResolvedValue({
      data: {
        tree: [
          { path: ".stash/structure.automerge", type: "blob", sha: "blob-structure" },
          { path: `.stash/docs/${r1.docId}.automerge`, type: "blob", sha: "blob-file1" },
        ],
      },
    });
    mockOctokit.rest.git.getBlob = vi.fn()
      .mockResolvedValueOnce({
        data: { content: Buffer.from(structureBlob).toString("base64") },
      })
      .mockResolvedValueOnce({
        data: { content: Buffer.from(fileBlob).toString("base64") },
      });

    const result = await provider.fetch();

    // Should have structure + remote file
    expect(result.docs.has("structure")).toBe(true);
    expect(result.docs.has(r1.docId)).toBe(true);
    expect(result.docs.size).toBe(2);
    expect(result.unchanged).toBe(false);
  });

  it("should throw error on auth failure during fetch", async () => {
    mockOctokit.rest.git.getRef = vi.fn().mockRejectedValue(
      Object.assign(new Error("Unauthorized"), { status: 401 }),
    );

    await expect(provider.fetch()).rejects.toThrow();
  });

  it("should return empty docs for empty repo (getRef 404)", async () => {
    mockOctokit.rest.git.getRef = vi.fn().mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );

    const result = await provider.fetch();
    expect(result.docs.size).toBe(0);
    expect(result.unchanged).toBe(false);
  });

  it("should create user-owned repo when missing", async () => {
    mockOctokit.rest.repos.get = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("Not Found"), { status: 404 }));
    mockOctokit.rest.users = {
      getAuthenticated: vi.fn().mockResolvedValue({ data: { login: "owner" } }),
    };
    mockOctokit.rest.repos.createForAuthenticatedUser = vi.fn().mockResolvedValue({ data: {} });
    mockOctokit.rest.repos.createInOrg = vi.fn().mockResolvedValue({ data: {} });

    await provider.create();

    expect(mockOctokit.rest.repos.createForAuthenticatedUser).toHaveBeenCalledWith({
      name: "repo",
      private: true,
      auto_init: false,
    });
    expect(mockOctokit.rest.repos.createInOrg).not.toHaveBeenCalled();
  });

  it("should create org-owned repo when missing", async () => {
    mockOctokit.rest.repos.get = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("Not Found"), { status: 404 }));
    mockOctokit.rest.users = {
      getAuthenticated: vi.fn().mockResolvedValue({ data: { login: "someone-else" } }),
    };
    mockOctokit.rest.repos.createForAuthenticatedUser = vi.fn().mockResolvedValue({ data: {} });
    mockOctokit.rest.repos.createInOrg = vi.fn().mockResolvedValue({ data: {} });

    await provider.create();

    expect(mockOctokit.rest.repos.createInOrg).toHaveBeenCalledWith({
      org: "owner",
      name: "repo",
      private: true,
    });
    expect(mockOctokit.rest.repos.createForAuthenticatedUser).not.toHaveBeenCalled();
  });

  it("should make create idempotent when repo already exists", async () => {
    mockOctokit.rest.repos.get = vi.fn().mockResolvedValue({ data: {} });
    mockOctokit.rest.users = {
      getAuthenticated: vi.fn(),
    };
    mockOctokit.rest.repos.createForAuthenticatedUser = vi.fn();
    mockOctokit.rest.repos.createInOrg = vi.fn();

    await provider.create();

    expect(mockOctokit.rest.repos.createForAuthenticatedUser).not.toHaveBeenCalled();
    expect(mockOctokit.rest.repos.createInOrg).not.toHaveBeenCalled();
  });

  it("should not write .stash/.gitkeep during create", async () => {
    mockOctokit.rest.repos.get = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("Not Found"), { status: 404 }));
    mockOctokit.rest.users = {
      getAuthenticated: vi.fn().mockResolvedValue({ data: { login: "owner" } }),
    };
    mockOctokit.rest.repos.createForAuthenticatedUser = vi.fn().mockResolvedValue({ data: {} });
    mockOctokit.rest.repos.createOrUpdateFileContents = vi.fn();

    await provider.create();

    expect(mockOctokit.rest.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
  });

  it("should throw error on server failure during fetch", async () => {
    mockOctokit.rest.git.getRef = vi.fn().mockRejectedValue(
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

    await provider.push(createPushPayload(localDocs));

    // Verify createTree was called with rendered plain text files
    const treeCall = mockOctokit.rest.git.createTree.mock.calls[0][0];
    const paths = treeCall.tree.map((e: any) => e.path);
    expect(paths).toContain("hello.md");
  });

  it("should avoid duplicate ref/commit lookups during push", async () => {
    const localDocs = createTestDocs();
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

    await provider.push(createPushPayload(localDocs));

    expect(mockOctokit.rest.git.getRef).toHaveBeenCalledTimes(1);
    expect(mockOctokit.rest.git.getCommit).toHaveBeenCalledTimes(1);
  });

  it("should not call getTree when pathsToDelete is provided", async () => {
    const localDocs = createTestDocs();
    mockOctokit.rest.git.getRef.mockResolvedValue({
      data: { object: { sha: "parent-sha" } },
    });
    mockOctokit.rest.git.getCommit.mockResolvedValue({
      data: { tree: { sha: "base-tree-sha" } },
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

    await provider.push(
      createPushPayload(localDocs, undefined, { pathsToDelete: ["deleted.md"] }),
    );

    expect(mockOctokit.rest.git.getTree).not.toHaveBeenCalled();
    const treeCall = mockOctokit.rest.git.createTree.mock.calls[0][0];
    const deleteEntries = treeCall.tree.filter((e: any) => e.sha === null);
    expect(deleteEntries.some((e: any) => e.path === "deleted.md")).toBe(true);
  });

  it("should only add tree entries for changedPaths when provided", async () => {
    const localDocs = createTestDocs();
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

    await provider.push(
      createPushPayload(localDocs, undefined, {
        changedPaths: new Set(["hello.md"]),
      }),
    );

    const treeCall = mockOctokit.rest.git.createTree.mock.calls[0][0];
    const paths = treeCall.tree.map((e: any) => e.path);
    expect(paths).toContain("hello.md");
    expect(paths).not.toContain(".stash/structure.automerge");
  });

  describe("path prefix support", () => {
    let prefixedProvider: GitHubProvider;

    beforeEach(async () => {
      prefixedProvider = new GitHubProvider("test-token", "owner", "repo", "notes");
      const { Octokit } = await import("octokit");
      mockOctokit = (Octokit as any).mock.results[
        (Octokit as any).mock.results.length - 1
      ].value;
      mockOctokit.rest.repos.get = vi.fn().mockResolvedValue({
        data: { pushed_at: "2024-01-01T00:00:00Z", default_branch: "main" },
      });
      mockOctokit.rest.repos.listBranches = vi.fn().mockResolvedValue({
        data: [{ name: "main" }],
      });
    });

    it("should prefix .stash paths when fetching", async () => {
      // Mock fetch - return 404 (empty repo)
      mockOctokit.rest.git.getRef = vi.fn().mockRejectedValue(
        Object.assign(new Error("Not Found"), { status: 404 }),
      );

      const result = await prefixedProvider.fetch();

      expect(result.docs.size).toBe(0);
      expect(result.unchanged).toBe(false);
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

      await prefixedProvider.push(createPushPayload(localDocs));

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

      nestedMock.rest.repos.get = vi.fn().mockResolvedValue({
        data: { pushed_at: "2024-01-01T00:00:00Z", default_branch: "main" },
      });
      nestedMock.rest.repos.listBranches = vi.fn().mockResolvedValue({
        data: [{ name: "main" }],
      });
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

      await nestedProvider.push(createPushPayload(localDocs));

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
      prefixMock.rest.repos.listBranches = vi.fn().mockResolvedValue({
        data: [{ name: "main" }],
      });
      prefixMock.rest.repos.get = vi.fn().mockResolvedValue({
        data: { default_branch: "main" },
      });

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

describe("incremental fetch", () => {
  let provider: GitHubProvider;
  let mockOctokit: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    provider = new GitHubProvider("test-token", "owner", "repo");
    const { Octokit } = await import("octokit");
    mockOctokit = (Octokit as any).mock.results[
      (Octokit as any).mock.results.length - 1
    ].value;
    mockOctokit.rest.repos.get = vi.fn().mockResolvedValue({
      data: { default_branch: "main" },
    });
    mockOctokit.rest.repos.listBranches = vi.fn().mockResolvedValue({
      data: [{ name: "main" }],
    });
  });

  it("fetch returns FetchResult with unchanged: false and all docs on first call", async () => {
    // Create test docs
    let structure = createStructureDoc();
    const r1 = addFile(structure, "hello.md");
    structure = r1.doc;
    const fileDoc = createFileDoc("Hello!");

    const structureBlob = Automerge.save(structure);
    const fileBlob = Automerge.save(fileDoc);

    mockOctokit.rest.git.getRef = vi.fn().mockResolvedValue({
      data: { object: { sha: "head-sha-1" } },
    });
    mockOctokit.rest.git.getCommit = vi.fn().mockResolvedValue({
      data: { tree: { sha: "tree-sha-1" } },
    });
    mockOctokit.rest.git.getTree = vi.fn().mockResolvedValue({
      data: {
        tree: [
          { path: ".stash/structure.automerge", type: "blob", sha: "blob-structure" },
          { path: `.stash/docs/${r1.docId}.automerge`, type: "blob", sha: "blob-file1" },
        ],
      },
    });
    mockOctokit.rest.git.getBlob = vi.fn()
      .mockResolvedValueOnce({
        data: { content: Buffer.from(structureBlob).toString("base64") },
      })
      .mockResolvedValueOnce({
        data: { content: Buffer.from(fileBlob).toString("base64") },
      });

    const result = await provider.fetch();

    expect(result.unchanged).toBe(false);
    expect(result.docs.has("structure")).toBe(true);
    expect(result.docs.has(r1.docId)).toBe(true);
    expect(result.docs.size).toBe(2);
  });

  it("fetch returns unchanged: true when HEAD SHA matches cached SHA", async () => {
    // First fetch to populate cache
    mockOctokit.rest.git.getRef = vi.fn().mockResolvedValue({
      data: { object: { sha: "head-sha-1" } },
    });
    mockOctokit.rest.git.getCommit = vi.fn().mockResolvedValue({
      data: { tree: { sha: "tree-sha-1" } },
    });
    mockOctokit.rest.git.getTree = vi.fn().mockResolvedValue({
      data: { tree: [] },
    });

    await provider.fetch();

    // Second fetch — same SHA
    vi.clearAllMocks();
    mockOctokit.rest.git.getRef = vi.fn().mockResolvedValue({
      data: { object: { sha: "head-sha-1" } },
    });

    const result = await provider.fetch();

    expect(result.unchanged).toBe(true);
    expect(result.docs.size).toBe(0);
    // Should NOT call getCommit or getTree
    expect(mockOctokit.rest.git.getCommit).not.toHaveBeenCalled();
    expect(mockOctokit.rest.git.getTree).not.toHaveBeenCalled();
  });

  it("fetch returns only changed docs when HEAD differs and some blobs match", async () => {
    const structure = createStructureDoc();
    const structureBlob = Automerge.save(structure);
    const fileBlob = Automerge.save(createFileDoc("content"));

    // First fetch — populate cache with 2 blobs
    mockOctokit.rest.git.getRef = vi.fn().mockResolvedValue({
      data: { object: { sha: "head-sha-1" } },
    });
    mockOctokit.rest.git.getCommit = vi.fn().mockResolvedValue({
      data: { tree: { sha: "tree-sha-1" } },
    });
    mockOctokit.rest.git.getTree = vi.fn().mockResolvedValue({
      data: {
        tree: [
          { path: ".stash/structure.automerge", type: "blob", sha: "blob-structure-v1" },
          { path: ".stash/docs/doc1.automerge", type: "blob", sha: "blob-doc1-v1" },
        ],
      },
    });
    mockOctokit.rest.git.getBlob = vi.fn()
      .mockResolvedValueOnce({ data: { content: Buffer.from(structureBlob).toString("base64") } })
      .mockResolvedValueOnce({ data: { content: Buffer.from(fileBlob).toString("base64") } });

    await provider.fetch();

    // Second fetch — HEAD changed, only structure blob changed
    vi.clearAllMocks();
    mockOctokit.rest.git.getRef = vi.fn().mockResolvedValue({
      data: { object: { sha: "head-sha-2" } },
    });
    mockOctokit.rest.git.getCommit = vi.fn().mockResolvedValue({
      data: { tree: { sha: "tree-sha-2" } },
    });
    mockOctokit.rest.git.getTree = vi.fn().mockResolvedValue({
      data: {
        tree: [
          { path: ".stash/structure.automerge", type: "blob", sha: "blob-structure-v2" }, // changed
          { path: ".stash/docs/doc1.automerge", type: "blob", sha: "blob-doc1-v1" }, // same
        ],
      },
    });
    mockOctokit.rest.git.getBlob = vi.fn().mockResolvedValueOnce({
      data: { content: Buffer.from(structureBlob).toString("base64") },
    });

    const result = await provider.fetch();

    expect(result.unchanged).toBe(false);
    expect(result.docs.has("structure")).toBe(true);
    expect(result.docs.has("doc1")).toBe(false); // unchanged blob not fetched
    expect(mockOctokit.rest.git.getBlob).toHaveBeenCalledTimes(1); // only changed blob
  });

  it("fetch returns unchanged: false with empty docs for empty repo (404)", async () => {
    mockOctokit.rest.git.getRef = vi.fn().mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );

    const result = await provider.fetch();

    expect(result.unchanged).toBe(false);
    expect(result.docs.size).toBe(0);
  });

  it("resolveBranch only calls API once across multiple fetches", async () => {
    mockOctokit.rest.git.getRef = vi.fn().mockResolvedValue({
      data: { object: { sha: "head-sha-1" } },
    });
    mockOctokit.rest.git.getCommit = vi.fn().mockResolvedValue({
      data: { tree: { sha: "tree-sha-1" } },
    });
    mockOctokit.rest.git.getTree = vi.fn().mockResolvedValue({
      data: { tree: [] },
    });

    await provider.fetch();

    // Reset only the branch-related mocks to track second call
    const listBranchesCalls = mockOctokit.rest.repos.listBranches.mock.calls.length;
    const reposGetCalls = mockOctokit.rest.repos.get.mock.calls.length;

    mockOctokit.rest.git.getRef = vi.fn().mockResolvedValue({
      data: { object: { sha: "head-sha-2" } },
    });
    mockOctokit.rest.git.getCommit = vi.fn().mockResolvedValue({
      data: { tree: { sha: "tree-sha-2" } },
    });
    mockOctokit.rest.git.getTree = vi.fn().mockResolvedValue({
      data: { tree: [] },
    });

    await provider.fetch();

    // listBranches and repos.get should not have been called again
    expect(mockOctokit.rest.repos.listBranches.mock.calls.length).toBe(listBranchesCalls);
    expect(mockOctokit.rest.repos.get.mock.calls.length).toBe(reposGetCalls);
  });

  it("getSyncState returns current cache and constructor restores it", async () => {
    // First fetch to populate cache
    mockOctokit.rest.git.getRef = vi.fn().mockResolvedValue({
      data: { object: { sha: "head-sha-1" } },
    });
    mockOctokit.rest.git.getCommit = vi.fn().mockResolvedValue({
      data: { tree: { sha: "tree-sha-1" } },
    });
    mockOctokit.rest.git.getTree = vi.fn().mockResolvedValue({
      data: {
        tree: [
          { path: ".stash/structure.automerge", type: "blob", sha: "blob-struct" },
          { path: ".stash/docs/doc1.automerge", type: "blob", sha: "blob-doc1" },
        ],
      },
    });
    mockOctokit.rest.git.getBlob = vi.fn().mockResolvedValue({
      data: { content: Buffer.from("test").toString("base64") },
    });

    await provider.fetch();

    const state = provider.getSyncState();
    expect(state.lastHeadSha).toBe("head-sha-1");
    expect(state.blobShas["structure"]).toBe("blob-struct");
    expect(state.blobShas["doc1"]).toBe("blob-doc1");

    // Create new provider with persisted state
    const { Octokit } = await import("octokit");
    const restored = new GitHubProvider("test-token", "owner", "repo", "", "main", state);
    const restoredMock = (Octokit as any).mock.results[
      (Octokit as any).mock.results.length - 1
    ].value;
    restoredMock.rest.repos.listBranches = vi.fn().mockResolvedValue({
      data: [{ name: "main" }],
    });
    restoredMock.rest.repos.get = vi.fn().mockResolvedValue({
      data: { default_branch: "main" },
    });

    // Same HEAD SHA — should return unchanged
    restoredMock.rest.git.getRef = vi.fn().mockResolvedValue({
      data: { object: { sha: "head-sha-1" } },
    });

    const result = await restored.fetch();
    expect(result.unchanged).toBe(true);
    expect(result.docs.size).toBe(0);
  });

  it("push reuses cached HEAD SHA and tree SHA from fetch", async () => {
    // Fetch first to populate cache
    mockOctokit.rest.git.getRef = vi.fn().mockResolvedValue({
      data: { object: { sha: "head-sha-1" } },
    });
    mockOctokit.rest.git.getCommit = vi.fn().mockResolvedValue({
      data: { tree: { sha: "tree-sha-1" } },
    });
    mockOctokit.rest.git.getTree = vi.fn().mockResolvedValue({
      data: { tree: [] },
    });

    await provider.fetch();

    // Now push — should not call ensureBranchExists, getCommit, or getTree again
    vi.clearAllMocks();
    mockOctokit.rest.git.createBlob = vi.fn().mockResolvedValue({
      data: { sha: "blob-sha" },
    });
    mockOctokit.rest.git.createTree = vi.fn().mockResolvedValue({
      data: { sha: "new-tree-sha" },
    });
    mockOctokit.rest.git.createCommit = vi.fn().mockResolvedValue({
      data: { sha: "new-commit-sha" },
    });
    mockOctokit.rest.git.updateRef = vi.fn().mockResolvedValue({ data: {} });

    const docs = createTestDocs();
    await provider.push({ docs, files: new Map([["hello.md", "Hello!"]]) });

    // Should NOT have called getRef, getCommit, getTree, listBranches, repos.get
    expect(mockOctokit.rest.git.getRef).not.toHaveBeenCalled();
    expect(mockOctokit.rest.git.getCommit).not.toHaveBeenCalled();
    expect(mockOctokit.rest.git.getTree).not.toHaveBeenCalled();
    expect(mockOctokit.rest.repos?.listBranches).not.toHaveBeenCalled();

    // Should have used cached tree SHA as base_tree
    const treeCall = mockOctokit.rest.git.createTree.mock.calls[0][0];
    expect(treeCall.base_tree).toBe("tree-sha-1");

    // Should have used cached HEAD SHA as parent
    const commitCall = mockOctokit.rest.git.createCommit.mock.calls[0][0];
    expect(commitCall.parents).toEqual(["head-sha-1"]);
  });

  it("push updates cached HEAD SHA and tree SHA after commit", async () => {
    // Fetch to populate cache
    mockOctokit.rest.git.getRef = vi.fn().mockResolvedValue({
      data: { object: { sha: "head-sha-1" } },
    });
    mockOctokit.rest.git.getCommit = vi.fn().mockResolvedValue({
      data: { tree: { sha: "tree-sha-1" } },
    });
    mockOctokit.rest.git.getTree = vi.fn().mockResolvedValue({
      data: { tree: [] },
    });

    await provider.fetch();

    // Push
    mockOctokit.rest.git.createBlob = vi.fn().mockResolvedValue({
      data: { sha: "blob-sha" },
    });
    mockOctokit.rest.git.createTree = vi.fn().mockResolvedValue({
      data: { sha: "new-tree-sha" },
    });
    mockOctokit.rest.git.createCommit = vi.fn().mockResolvedValue({
      data: { sha: "new-commit-sha" },
    });
    mockOctokit.rest.git.updateRef = vi.fn().mockResolvedValue({ data: {} });

    await provider.push({ docs: createTestDocs(), files: new Map([["hello.md", "Hello!"]]) });

    // After push, next fetch with same new SHA should be unchanged
    vi.clearAllMocks();
    mockOctokit.rest.git.getRef = vi.fn().mockResolvedValue({
      data: { object: { sha: "new-commit-sha" } },
    });

    const result = await provider.fetch();
    expect(result.unchanged).toBe(true);
  });

  describe("with path prefix", () => {
    let prefixedProvider: GitHubProvider;

    beforeEach(async () => {
      prefixedProvider = new GitHubProvider("test-token", "owner", "repo", "notes");
      const { Octokit } = await import("octokit");
      mockOctokit = (Octokit as any).mock.results[
        (Octokit as any).mock.results.length - 1
      ].value;
      mockOctokit.rest.repos.get = vi.fn().mockResolvedValue({
        data: { default_branch: "main" },
      });
      mockOctokit.rest.repos.listBranches = vi.fn().mockResolvedValue({
        data: [{ name: "main" }],
      });
    });

    it("fetch filters tree entries by path prefix", async () => {
      const structureBlob = Automerge.save(createStructureDoc());

      mockOctokit.rest.git.getRef = vi.fn().mockResolvedValue({
        data: { object: { sha: "head-sha-1" } },
      });
      mockOctokit.rest.git.getCommit = vi.fn().mockResolvedValue({
        data: { tree: { sha: "tree-sha-1" } },
      });
      mockOctokit.rest.git.getTree = vi.fn().mockResolvedValue({
        data: {
          tree: [
            { path: "notes/.stash/structure.automerge", type: "blob", sha: "blob-1" },
            { path: "notes/.stash/docs/doc1.automerge", type: "blob", sha: "blob-2" },
            { path: "other/.stash/structure.automerge", type: "blob", sha: "blob-3" }, // different prefix
          ],
        },
      });
      mockOctokit.rest.git.getBlob = vi.fn().mockResolvedValue({
        data: { content: Buffer.from(structureBlob).toString("base64") },
      });

      const result = await prefixedProvider.fetch();

      // Should only fetch blobs for notes/ prefix (2 blobs), not other/
      expect(mockOctokit.rest.git.getBlob).toHaveBeenCalledTimes(2);
      expect(result.docs.has("structure")).toBe(true);
      expect(result.docs.has("doc1")).toBe(true);
    });
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
