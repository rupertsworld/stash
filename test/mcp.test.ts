import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.js";
import { StashManager } from "../src/core/manager.js";

describe("MCP Server", () => {
  let tmpDir: string;
  let manager: StashManager;
  let client: Client;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stash-mcp-test-"));
    manager = await StashManager.load(tmpDir);

    const server = createMcpServer(manager);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    // Wait a bit for any background saves to complete
    await new Promise((r) => setTimeout(r, 50));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should list tools", async () => {
    const result = await client.listTools();
    const toolNames = result.tools.map((t) => t.name);
    expect(toolNames).toContain("stash_list");
    expect(toolNames).toContain("stash_glob");
    expect(toolNames).toContain("stash_read");
    expect(toolNames).toContain("stash_write");
    expect(toolNames).toContain("stash_delete");
    expect(toolNames).toContain("stash_move");
  });

  it("stash_list: should list stashes (no args)", async () => {
    await manager.create("alpha");
    await manager.create("beta");

    const result = await client.callTool({ name: "stash_list", arguments: {} });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.items).toEqual(["alpha", "beta"]);
  });

  it("stash_list: should list files in stash root", async () => {
    const stash = await manager.create("test");
    stash.write("readme.md", "r");
    stash.write("docs/guide.md", "g");
    await stash.flush();

    const result = await client.callTool({
      name: "stash_list",
      arguments: { stash: "test" },
    });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.items).toContain("readme.md");
    expect(data.items).toContain("docs/");
  });

  it("stash_list: should list files in subdirectory", async () => {
    const stash = await manager.create("test");
    stash.write("docs/a.md", "a");
    stash.write("docs/b.md", "b");
    await stash.flush();

    const result = await client.callTool({
      name: "stash_list",
      arguments: { stash: "test", path: "docs/" },
    });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.items).toContain("a.md");
    expect(data.items).toContain("b.md");
  });

  it("stash_glob: should find matching files", async () => {
    const stash = await manager.create("test");
    stash.write("readme.md", "r");
    stash.write("docs/guide.md", "g");
    stash.write("src/index.ts", "i");
    await stash.flush();

    const result = await client.callTool({
      name: "stash_glob",
      arguments: { stash: "test", pattern: "**/*.md" },
    });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.files).toEqual(["docs/guide.md", "readme.md"]);
  });

  it("stash_glob: should error on missing stash", async () => {
    const result = await client.callTool({
      name: "stash_glob",
      arguments: { stash: "nonexistent", pattern: "**" },
    });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.error).toContain("Stash not found");
  });

  it("stash_read: should read file content", async () => {
    const stash = await manager.create("test");
    stash.write("hello.md", "Hello, world!");
    await stash.flush();

    const result = await client.callTool({
      name: "stash_read",
      arguments: { stash: "test", path: "hello.md" },
    });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.content).toBe("Hello, world!");
  });

  it("stash_read: should error on missing file", async () => {
    await manager.create("test");

    const result = await client.callTool({
      name: "stash_read",
      arguments: { stash: "test", path: "nope.md" },
    });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.error).toContain("File not found");
  });

  it("stash_read: should error on missing stash", async () => {
    const result = await client.callTool({
      name: "stash_read",
      arguments: { stash: "nope", path: "file.md" },
    });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.error).toContain("Stash not found");
  });

  it("stash_write: should write content", async () => {
    await manager.create("test");

    const result = await client.callTool({
      name: "stash_write",
      arguments: { stash: "test", path: "hello.md", content: "Hello!" },
    });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.success).toBe(true);

    // Re-fetch stash after MCP operation (reload may have replaced it)
    const stash = manager.get("test")!;
    expect(stash.read("hello.md")).toBe("Hello!");
    await stash.flush();
  });

  it("stash_write: should apply patch", async () => {
    const stash = await manager.create("test");
    stash.write("file.md", "Hello world");
    await stash.flush();

    const result = await client.callTool({
      name: "stash_write",
      arguments: {
        stash: "test",
        path: "file.md",
        patch: { start: 5, end: 5, text: "," },
      },
    });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.success).toBe(true);
    // Re-fetch stash after MCP operation
    const updatedStash = manager.get("test")!;
    expect(updatedStash.read("file.md")).toBe("Hello, world");
    await updatedStash.flush();
  });

  it("stash_write: should error without content or patch", async () => {
    await manager.create("test");

    const result = await client.callTool({
      name: "stash_write",
      arguments: { stash: "test", path: "file.md" },
    });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.error).toContain("Must provide content or patch");
  });

  it("stash_delete: should delete file", async () => {
    const stash = await manager.create("test");
    stash.write("file.md", "content");
    await stash.flush();

    const result = await client.callTool({
      name: "stash_delete",
      arguments: { stash: "test", path: "file.md" },
    });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.success).toBe(true);
    // Re-fetch stash after MCP operation
    const updatedStash = manager.get("test")!;
    expect(() => updatedStash.read("file.md")).toThrow();
    await updatedStash.flush();
  });

  it("stash_delete: should error on missing file", async () => {
    await manager.create("test");

    const result = await client.callTool({
      name: "stash_delete",
      arguments: { stash: "test", path: "nope.md" },
    });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.error).toContain("File not found");
  });

  it("stash_move: should move file", async () => {
    const stash = await manager.create("test");
    stash.write("old.md", "content");
    await stash.flush();

    const result = await client.callTool({
      name: "stash_move",
      arguments: { stash: "test", from: "old.md", to: "new.md" },
    });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.success).toBe(true);
    // Re-fetch stash after MCP operation
    const updatedStash = manager.get("test")!;
    expect(updatedStash.read("new.md")).toBe("content");
    expect(() => updatedStash.read("old.md")).toThrow();
    await updatedStash.flush();
  });

  it("stash_move: should error on missing source", async () => {
    await manager.create("test");

    const result = await client.callTool({
      name: "stash_move",
      arguments: { stash: "test", from: "nope.md", to: "new.md" },
    });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.error).toContain("File not found");
  });
});
