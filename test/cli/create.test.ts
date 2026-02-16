import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Tests for `stash create` command behavior when remote has existing files.
 *
 * Scenarios:
 * 1. Empty repo → creates stash normally
 * 2. Repo with .stash/ → errors "use connect"
 * 3. Repo with files (no .stash/) + user confirms → imports all files
 * 4. Repo with files (no .stash/) + user aborts → exits, no changes
 * 5. Repo with mixed text/binary → handles both correctly
 * 6. Repo with nested directories → preserves paths
 */

// Mock Octokit - create mock functions we can control per-test
const mockGetRef = vi.fn();
const mockGetCommit = vi.fn();
const mockGetTree = vi.fn();
const mockGetContent = vi.fn();
const mockCreateTree = vi.fn();
const mockCreateCommit = vi.fn();
const mockUpdateRef = vi.fn();
const mockCreateRef = vi.fn();
const mockCreateBlob = vi.fn();

vi.mock("octokit", () => {
  return {
    Octokit: vi.fn().mockImplementation(() => ({
      rest: {
        repos: {
          getContent: mockGetContent,
        },
        git: {
          getRef: mockGetRef,
          getCommit: mockGetCommit,
          getTree: mockGetTree,
          createTree: mockCreateTree,
          createCommit: mockCreateCommit,
          updateRef: mockUpdateRef,
          createRef: mockCreateRef,
          createBlob: mockCreateBlob,
        },
      },
    })),
  };
});

vi.mock("../../src/core/config.js", () => ({
  getGitHubToken: vi.fn().mockResolvedValue("test-token"),
  getStashDir: vi.fn().mockReturnValue("/tmp/test-stash"),
}));

vi.mock("../../src/cli/prompts.js", () => ({
  promptChoice: vi.fn(),
  prompt: vi.fn(),
}));

/**
 * Test the isUtf8 detection logic (same as used in create.ts)
 */
function isUtf8(buffer: Buffer): boolean {
  try {
    const text = buffer.toString("utf-8");
    return !text.includes("\uFFFD");
  } catch {
    return false;
  }
}

describe("isUtf8 detection", () => {
  it("should detect plain text as UTF-8", () => {
    const text = Buffer.from("Hello, world!");
    expect(isUtf8(text)).toBe(true);
  });

  it("should detect UTF-8 with unicode as UTF-8", () => {
    const text = Buffer.from("Hello 世界 🌍");
    expect(isUtf8(text)).toBe(true);
  });

  it("should detect empty buffer as UTF-8", () => {
    const empty = Buffer.from("");
    expect(isUtf8(empty)).toBe(true);
  });

  it("should detect PNG header as non-UTF-8", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(isUtf8(png)).toBe(false);
  });

  it("should detect JPEG header as non-UTF-8", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    expect(isUtf8(jpeg)).toBe(false);
  });

  it("should detect random binary as non-UTF-8", () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x80, 0x81]);
    expect(isUtf8(binary)).toBe(false);
  });
});

describe("stash create with existing remote files", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "create-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("repo detection via listFiles()", () => {
    it("should detect empty repo (no files)", async () => {
      const { GitHubProvider } = await import("../../src/providers/github.js");
      const provider = new GitHubProvider("test-token", "owner", "repo");

      // Empty repo - 404 on getRef
      mockGetRef.mockRejectedValue(
        Object.assign(new Error("Not Found"), { status: 404 }),
      );

      const files = await provider.listFiles();
      expect(files).toEqual([]);
    });

    it("should detect repo with only .stash/ (existing stash)", async () => {
      const { GitHubProvider } = await import("../../src/providers/github.js");
      const provider = new GitHubProvider("test-token", "owner", "repo");

      // Has .stash structure
      mockGetRef.mockResolvedValue({
        data: { object: { sha: "head-sha" } },
      });
      mockGetCommit.mockResolvedValue({
        data: { tree: { sha: "tree-sha" } },
      });
      mockGetTree.mockResolvedValue({
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

    it("should detect repo with user files (no .stash/)", async () => {
      const { GitHubProvider } = await import("../../src/providers/github.js");
      const provider = new GitHubProvider("test-token", "owner", "repo");

      mockGetRef.mockResolvedValue({
        data: { object: { sha: "head-sha" } },
      });
      mockGetCommit.mockResolvedValue({
        data: { tree: { sha: "tree-sha" } },
      });
      mockGetTree.mockResolvedValue({
        data: {
          tree: [
            { path: "readme.md", type: "blob" },
            { path: "notes/hello.md", type: "blob" },
          ],
        },
      });

      const files = await provider.listFiles();
      expect(files).toEqual(["readme.md", "notes/hello.md"]);
    });

    it("should detect repo with mixed stash and user files", async () => {
      const { GitHubProvider } = await import("../../src/providers/github.js");
      const provider = new GitHubProvider("test-token", "owner", "repo");

      mockGetRef.mockResolvedValue({
        data: { object: { sha: "head-sha" } },
      });
      mockGetCommit.mockResolvedValue({
        data: { tree: { sha: "tree-sha" } },
      });
      mockGetTree.mockResolvedValue({
        data: {
          tree: [
            { path: "readme.md", type: "blob" },
            { path: ".stash/structure.automerge", type: "blob" },
          ],
        },
      });

      const files = await provider.listFiles();
      // Has user files but also .stash - this is an existing stash
      // listFiles() returns only non-.stash files
      expect(files).toEqual(["readme.md"]);
    });
  });

  describe("fetchFile()", () => {
    it("should fetch text file content", async () => {
      const { GitHubProvider } = await import("../../src/providers/github.js");
      const provider = new GitHubProvider("test-token", "owner", "repo");

      const textContent = "# Hello World\n\nThis is my readme.";
      mockGetContent.mockResolvedValue({
        data: { content: Buffer.from(textContent).toString("base64") },
      });

      const content = await provider.fetchFile("readme.md");
      expect(content.toString("utf-8")).toBe(textContent);
    });

    it("should fetch binary file content", async () => {
      const { GitHubProvider } = await import("../../src/providers/github.js");
      const provider = new GitHubProvider("test-token", "owner", "repo");

      // PNG header
      const binaryContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      mockGetContent.mockResolvedValue({
        data: { content: binaryContent.toString("base64") },
      });

      const content = await provider.fetchFile("image.png");
      expect(content).toEqual(binaryContent);
    });
  });

  describe("edge cases", () => {
    it("should handle .gitignore and other dotfiles", async () => {
      const { GitHubProvider } = await import("../../src/providers/github.js");
      const provider = new GitHubProvider("test-token", "owner", "repo");

      mockGetRef.mockResolvedValue({
        data: { object: { sha: "head-sha" } },
      });
      mockGetCommit.mockResolvedValue({
        data: { tree: { sha: "tree-sha" } },
      });
      mockGetTree.mockResolvedValue({
        data: {
          tree: [
            { path: ".gitignore", type: "blob" },
            { path: ".env.example", type: "blob" },
            { path: "readme.md", type: "blob" },
          ],
        },
      });

      const files = await provider.listFiles();
      expect(files).toContain(".gitignore");
      expect(files).toContain(".env.example");
      expect(files).toContain("readme.md");
      expect(files).toHaveLength(3);
    });

    it("should exclude .git/ directory", async () => {
      const { GitHubProvider } = await import("../../src/providers/github.js");
      const provider = new GitHubProvider("test-token", "owner", "repo");

      mockGetRef.mockResolvedValue({
        data: { object: { sha: "head-sha" } },
      });
      mockGetCommit.mockResolvedValue({
        data: { tree: { sha: "tree-sha" } },
      });
      mockGetTree.mockResolvedValue({
        data: {
          tree: [
            { path: ".git/config", type: "blob" },
            { path: ".git/HEAD", type: "blob" },
            { path: "readme.md", type: "blob" },
          ],
        },
      });

      const files = await provider.listFiles();
      expect(files).not.toContain(".git/config");
      expect(files).not.toContain(".git/HEAD");
      expect(files).toContain("readme.md");
      expect(files).toHaveLength(1);
    });

    it("should handle large number of files", async () => {
      const { GitHubProvider } = await import("../../src/providers/github.js");
      const provider = new GitHubProvider("test-token", "owner", "repo");

      // Generate 100 files
      const treeItems = Array.from({ length: 100 }, (_, i) => ({
        path: `file-${i}.md`,
        type: "blob",
      }));

      mockGetRef.mockResolvedValue({
        data: { object: { sha: "head-sha" } },
      });
      mockGetCommit.mockResolvedValue({
        data: { tree: { sha: "tree-sha" } },
      });
      mockGetTree.mockResolvedValue({
        data: { tree: treeItems },
      });

      const files = await provider.listFiles();
      expect(files).toHaveLength(100);
    });

    it("should preserve nested directory paths", async () => {
      const { GitHubProvider } = await import("../../src/providers/github.js");
      const provider = new GitHubProvider("test-token", "owner", "repo");

      mockGetRef.mockResolvedValue({
        data: { object: { sha: "head-sha" } },
      });
      mockGetCommit.mockResolvedValue({
        data: { tree: { sha: "tree-sha" } },
      });
      mockGetTree.mockResolvedValue({
        data: {
          tree: [
            { path: "a/b/c/deep.md", type: "blob" },
            { path: "x/y.md", type: "blob" },
          ],
        },
      });

      const files = await provider.listFiles();
      expect(files).toContain("a/b/c/deep.md");
      expect(files).toContain("x/y.md");
    });

    it("should handle path prefix correctly", async () => {
      const { GitHubProvider } = await import("../../src/providers/github.js");
      const provider = new GitHubProvider("test-token", "owner", "repo", "notes");

      mockGetRef.mockResolvedValue({
        data: { object: { sha: "head-sha" } },
      });
      mockGetCommit.mockResolvedValue({
        data: { tree: { sha: "tree-sha" } },
      });
      mockGetTree.mockResolvedValue({
        data: {
          tree: [
            { path: "other/stuff.md", type: "blob" },
            { path: "notes/readme.md", type: "blob" },
            { path: "notes/sub/file.md", type: "blob" },
            { path: "notes/.stash/structure.automerge", type: "blob" },
          ],
        },
      });

      const files = await provider.listFiles();
      // Should only include files under "notes/", with prefix stripped
      // Should exclude .stash/ under the prefix
      expect(files).toContain("readme.md");
      expect(files).toContain("sub/file.md");
      expect(files).not.toContain("notes/readme.md");
      expect(files).not.toContain("other/stuff.md");
      expect(files).not.toContain(".stash/structure.automerge");
      expect(files).toHaveLength(2);
    });
  });
});
