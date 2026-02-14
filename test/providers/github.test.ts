import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Automerge from "@automerge/automerge";
import { GitHubProvider } from "../../src/providers/github.js";
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

  it("should sync with empty remote (first push)", async () => {
    const localDocs = createTestDocs();

    // Mock: remote is empty (404s)
    mockOctokit.rest.repos.getContent.mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );
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

    const result = await provider.sync(localDocs);

    expect(result.size).toBe(localDocs.size);
    expect(result.has("structure")).toBe(true);
    expect(mockOctokit.rest.git.createRef).toHaveBeenCalled();
  });

  it("should fetch and merge remote docs", async () => {
    // Create local docs
    let localStructure = createStructureDoc();
    const r1 = addFile(localStructure, "local.md");
    localStructure = r1.doc;
    const localFile = createFileDoc("Local content");

    const localDocs = new Map<string, Uint8Array>();
    localDocs.set("structure", Automerge.save(localStructure));
    localDocs.set(r1.docId, Automerge.save(localFile));

    // Create remote docs (same structure base but different file)
    let remoteStructure = createStructureDoc();
    const r2 = addFile(remoteStructure, "remote.md");
    remoteStructure = r2.doc;
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
            data: [{ name: `${r2.docId}.automerge` }],
          };
        }
        if (path === `.stash/docs/${r2.docId}.automerge`) {
          return { data: { content: remoteFileBase64 } };
        }
        throw Object.assign(new Error("Not Found"), { status: 404 });
      },
    );

    // Mock push
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

    const result = await provider.sync(localDocs);

    // Should have structure + local file + remote file
    expect(result.has("structure")).toBe(true);
    expect(result.has(r1.docId)).toBe(true);
    expect(result.has(r2.docId)).toBe(true);
  });

  it("should throw non-retryable SyncError on auth failure", async () => {
    const localDocs = createTestDocs();

    mockOctokit.rest.repos.getContent.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), { status: 401 }),
    );

    try {
      await provider.sync(localDocs);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SyncError);
      expect((err as SyncError).retryable).toBe(false);
    }
  });

  it("should throw retryable SyncError on network failure", async () => {
    const localDocs = createTestDocs();

    mockOctokit.rest.repos.getContent.mockRejectedValue(
      Object.assign(new Error("Server Error"), { status: 500 }),
    );

    try {
      await provider.sync(localDocs);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SyncError);
      expect((err as SyncError).retryable).toBe(true);
    }
  });

  it("should render plain text files in push", async () => {
    const localDocs = createTestDocs();

    mockOctokit.rest.repos.getContent.mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );
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

    await provider.sync(localDocs);

    // Verify createTree was called with rendered plain text files
    const treeCall = mockOctokit.rest.git.createTree.mock.calls[0][0];
    const paths = treeCall.tree.map((e: any) => e.path);
    expect(paths).toContain("hello.md");
  });
});
