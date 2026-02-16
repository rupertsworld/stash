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
          getTree: vi.fn(),
          getBlob: vi.fn(),
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

  describe("fetch", () => {
    it("should return empty map when remote is empty (404)", async () => {
      mockOctokit.rest.git.getRef.mockRejectedValue(
        Object.assign(new Error("Not Found"), { status: 404 }),
      );

      const result = await provider.fetch();
      expect(result.size).toBe(0);
    });

    it("should fetch docs using tree API and parallel blob fetches", async () => {
      const structureDoc = createStructureDoc();
      const { doc, docId } = addFile(structureDoc, "test.md");
      const fileDoc = createFileDoc("Test");

      const structureBase64 = Buffer.from(Automerge.save(doc)).toString("base64");
      const fileBase64 = Buffer.from(Automerge.save(fileDoc)).toString("base64");

      mockOctokit.rest.git.getRef.mockResolvedValue({
        data: { object: { sha: "ref-sha" } },
      });
      mockOctokit.rest.git.getCommit.mockResolvedValue({
        data: { tree: { sha: "tree-sha" } },
      });
      mockOctokit.rest.git.getTree.mockResolvedValue({
        data: {
          tree: [
            { path: ".stash/structure.automerge", type: "blob", sha: "structure-blob-sha" },
            { path: `.stash/docs/${docId}.automerge`, type: "blob", sha: "file-blob-sha" },
            { path: "test.md", type: "blob", sha: "plaintext-sha" },
          ],
        },
      });
      mockOctokit.rest.git.getBlob.mockImplementation(async ({ file_sha }: { file_sha: string }) => {
        if (file_sha === "structure-blob-sha") {
          return { data: { content: structureBase64 } };
        }
        if (file_sha === "file-blob-sha") {
          return { data: { content: fileBase64 } };
        }
        throw new Error("Unknown blob");
      });

      const result = await provider.fetch();
      expect(result.has("structure")).toBe(true);
      expect(result.has(docId)).toBe(true);
      expect(result.size).toBe(2); // Only .automerge blobs, not plain text

      // Verify tree API was used (not repos.getContent)
      expect(mockOctokit.rest.git.getTree).toHaveBeenCalledWith(
        expect.objectContaining({ recursive: "true" }),
      );
      expect(mockOctokit.rest.repos.getContent).not.toHaveBeenCalled();
    });

    it("should throw non-retryable SyncError on auth failure", async () => {
      mockOctokit.rest.git.getRef.mockRejectedValue(
        Object.assign(new Error("Unauthorized"), { status: 401 }),
      );

      try {
        await provider.fetch();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(SyncError);
        expect((err as SyncError).retryable).toBe(false);
      }
    });

    it("should throw retryable SyncError on server failure", async () => {
      mockOctokit.rest.git.getRef.mockRejectedValue(
        Object.assign(new Error("Server Error"), { status: 500 }),
      );

      try {
        await provider.fetch();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(SyncError);
        expect((err as SyncError).retryable).toBe(true);
      }
    });
  });

  describe("push", () => {
    it("should push docs and render plain text files", async () => {
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

      await provider.push(localDocs);

      // Verify createTree was called with rendered plain text files
      const treeCall = mockOctokit.rest.git.createTree.mock.calls[0][0];
      const paths = treeCall.tree.map((e: any) => e.path);
      expect(paths).toContain("hello.md");
      expect(paths).toContain(".stash/structure.automerge");
    });

    it("should create initial ref when no commits exist", async () => {
      const localDocs = createTestDocs();

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

      await provider.push(localDocs);

      expect(mockOctokit.rest.git.createRef).toHaveBeenCalled();
      expect(mockOctokit.rest.git.updateRef).not.toHaveBeenCalled();
    });

    it("should throw non-retryable SyncError on auth failure", async () => {
      const localDocs = createTestDocs();

      mockOctokit.rest.git.createBlob.mockRejectedValue(
        Object.assign(new Error("Forbidden"), { status: 403 }),
      );

      try {
        await provider.push(localDocs);
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(SyncError);
        expect((err as SyncError).retryable).toBe(false);
      }
    });
  });
});
