import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();
const createMock = vi.fn();
const listFilesMock = vi.fn();

const managerCreateMock = vi.fn();
const listAllFilesMock = vi.fn();
const syncMock = vi.fn();

const promptChoiceMock = vi.fn();
const promptMock = vi.fn();
const getGitHubTokenMock = vi.fn();

vi.mock("../../src/core/config.js", () => ({
  getGitHubToken: getGitHubTokenMock,
}));

vi.mock("../../src/cli/prompts.js", () => ({
  promptChoice: promptChoiceMock,
  prompt: promptMock,
}));

vi.mock("../../src/core/manager.js", () => ({
  StashManager: {
    load: vi.fn().mockResolvedValue({
      create: managerCreateMock,
    }),
  },
}));

vi.mock("../../src/providers/github.js", () => ({
  parseGitHubRemote: vi.fn((remote: string) => {
    const raw = remote.replace(/^github:/, "");
    const [owner, repo, ...rest] = raw.split("/");
    if (!owner || !repo) return null;
    return { owner, repo, pathPrefix: rest.join("/") };
  }),
  GitHubProvider: vi.fn().mockImplementation(() => ({
    fetch: fetchMock,
    create: createMock,
    listFiles: listFilesMock,
  })),
}));

describe("createStash command flow", () => {
  const exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    getGitHubTokenMock.mockResolvedValue("ghp_test");
    listAllFilesMock.mockReturnValue([["file.md", { kind: "text", content: "x" }]]);
    syncMock.mockResolvedValue(undefined);
    managerCreateMock.mockResolvedValue({
      listAllFiles: listAllFilesMock,
      sync: syncMock,
    });
  });

  afterEach(() => {
    exitSpy.mockClear();
    errorSpy.mockClear();
    logSpy.mockClear();
  });

  it("exits with guidance when --remote missing and --create not set", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("missing"), { status: 404 }));
    const { createStash } = await import("../../src/cli/commands/create.js");

    await expect(
      createStash("demo", { remote: "github:owner/repo" } as any),
    ).rejects.toThrow("process.exit:1");

    expect(createMock).not.toHaveBeenCalled();
    expect(managerCreateMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "Create the repository on GitHub first, or use --create to create it.",
    );
  });

  it("creates remote and continues when --create is set", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("missing"), { status: 404 }));
    createMock.mockResolvedValueOnce(undefined);
    const { createStash } = await import("../../src/cli/commands/create.js");

    await createStash("demo", { remote: "github:owner/repo", create: true } as any);

    expect(createMock).toHaveBeenCalledOnce();
    expect(managerCreateMock).toHaveBeenCalledOnce();
    expect(syncMock).toHaveBeenCalledOnce();
  });

  it("interactive flow prompts and creates on 404 when user confirms", async () => {
    promptChoiceMock
      .mockResolvedValueOnce("GitHub")
      .mockResolvedValueOnce("Yes");
    promptMock.mockResolvedValueOnce("owner/repo");
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("missing"), { status: 404 }));
    createMock.mockResolvedValueOnce(undefined);
    const { createStash } = await import("../../src/cli/commands/create.js");

    await createStash("demo", {} as any);

    expect(createMock).toHaveBeenCalledOnce();
    expect(managerCreateMock).toHaveBeenCalledOnce();
  });

  it("interactive flow aborts on 404 when user declines create", async () => {
    promptChoiceMock
      .mockResolvedValueOnce("GitHub")
      .mockResolvedValueOnce("No");
    promptMock.mockResolvedValueOnce("owner/repo");
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("missing"), { status: 404 }));
    const { createStash } = await import("../../src/cli/commands/create.js");

    await expect(createStash("demo", {} as any)).rejects.toThrow("process.exit:0");

    expect(createMock).not.toHaveBeenCalled();
    expect(managerCreateMock).not.toHaveBeenCalled();
  });

  it("exits with connect guidance when remote already has stash docs", async () => {
    fetchMock.mockResolvedValueOnce(new Map([["structure", new Uint8Array([1])]]));
    const { createStash } = await import("../../src/cli/commands/create.js");

    await expect(
      createStash("demo", { remote: "github:owner/repo", create: true } as any),
    ).rejects.toThrow("process.exit:1");

    expect(errorSpy).toHaveBeenCalledWith("Use 'stash connect' to join an existing stash.");
    expect(managerCreateMock).not.toHaveBeenCalled();
  });

  it("does not use listFiles() in create flow", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("missing"), { status: 404 }));
    createMock.mockResolvedValueOnce(undefined);
    const { createStash } = await import("../../src/cli/commands/create.js");

    await createStash("demo", { remote: "github:owner/repo", create: true } as any);
    expect(listFilesMock).not.toHaveBeenCalled();
  });

  it("syncs on create with remote even when local file count is zero", async () => {
    fetchMock.mockResolvedValueOnce(new Map());
    listAllFilesMock.mockReturnValue([]);
    const { createStash } = await import("../../src/cli/commands/create.js");

    await createStash("demo", { remote: "github:owner/repo", create: true } as any);

    expect(managerCreateMock).toHaveBeenCalledOnce();
    expect(syncMock).toHaveBeenCalledOnce();
  });
});
