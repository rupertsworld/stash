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
    expect(toolNames).toContain("stash_edit");
    expect(toolNames).toContain("stash_delete");
    expect(toolNames).toContain("stash_move");
    expect(toolNames).toContain("stash_grep");
  });

  it("stash_list: should list stashes (no args)", async () => {
    await manager.create("alpha");
    await manager.create("beta");

    const result = await client.callTool({
      name: "stash_list",
      arguments: {},
    });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.stashes).toHaveLength(2);
    expect(data.stashes.map((s: any) => s.name)).toEqual(["alpha", "beta"]);
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
      arguments: { stash: "test", glob: "**/*.md" },
    });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.files).toEqual(["docs/guide.md", "readme.md"]);
  });

  it("stash_glob: should error on missing stash", async () => {
    const result = await client.callTool({
      name: "stash_glob",
      arguments: { stash: "nonexistent", glob: "**" },
    });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.error).toContain("Stash not found");
  });

  it("stash_read: should read file from disk", async () => {
    const stash = await manager.create("test");
    // Write file to disk directly
    await fs.mkdir(stash.path, { recursive: true });
    await fs.writeFile(path.join(stash.path, "hello.md"), "Hello, world!");
    // Also register in stash structure so glob/list works
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

  it("stash_write: should write content to disk", async () => {
    const stash = await manager.create("test");

    const result = await client.callTool({
      name: "stash_write",
      arguments: { stash: "test", path: "hello.md", content: "Hello!" },
    });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.success).toBe(true);

    // Verify file was written to disk
    const content = await fs.readFile(
      path.join(stash.path, "hello.md"),
      "utf-8",
    );
    expect(content).toBe("Hello!");
  });

  it("stash_write: should error without content", async () => {
    await manager.create("test");

    const result = await client.callTool({
      name: "stash_write",
      arguments: { stash: "test", path: "file.md" },
    });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.error).toContain("content is required");
  });

  it("stash_edit: should replace text in file", async () => {
    const stash = await manager.create("test");
    await fs.writeFile(
      path.join(stash.path, "file.md"),
      "Hello world",
    );
    stash.write("file.md", "Hello world");
    await stash.flush();

    const result = await client.callTool({
      name: "stash_edit",
      arguments: {
        stash: "test",
        path: "file.md",
        old_string: "world",
        new_string: "universe",
      },
    });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.success).toBe(true);

    const content = await fs.readFile(
      path.join(stash.path, "file.md"),
      "utf-8",
    );
    expect(content).toBe("Hello universe");
  });

  it("stash_edit: should error when old_string not found", async () => {
    const stash = await manager.create("test");
    await fs.writeFile(
      path.join(stash.path, "file.md"),
      "Hello world",
    );
    stash.write("file.md", "Hello world");
    await stash.flush();

    const result = await client.callTool({
      name: "stash_edit",
      arguments: {
        stash: "test",
        path: "file.md",
        old_string: "nonexistent",
        new_string: "replacement",
      },
    });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.error).toContain("old_string not found");
  });

  it("stash_edit: should error when old_string not unique", async () => {
    const stash = await manager.create("test");
    await fs.writeFile(
      path.join(stash.path, "file.md"),
      "aaa aaa",
    );
    stash.write("file.md", "aaa aaa");
    await stash.flush();

    const result = await client.callTool({
      name: "stash_edit",
      arguments: {
        stash: "test",
        path: "file.md",
        old_string: "aaa",
        new_string: "bbb",
      },
    });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.error).toContain("not unique");
  });

  it("stash_delete: should delete file from disk", async () => {
    const stash = await manager.create("test");
    const filePath = path.join(stash.path, "file.md");
    await fs.writeFile(filePath, "content");
    stash.write("file.md", "content");
    await stash.flush();

    const result = await client.callTool({
      name: "stash_delete",
      arguments: { stash: "test", path: "file.md" },
    });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.success).toBe(true);

    await expect(fs.access(filePath)).rejects.toThrow();
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

  it("stash_move: should move file on disk", async () => {
    const stash = await manager.create("test");
    await fs.writeFile(path.join(stash.path, "old.md"), "content");
    stash.write("old.md", "content");
    await stash.flush();

    const result = await client.callTool({
      name: "stash_move",
      arguments: { stash: "test", from: "old.md", to: "new.md" },
    });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.success).toBe(true);

    const content = await fs.readFile(
      path.join(stash.path, "new.md"),
      "utf-8",
    );
    expect(content).toBe("content");
    await expect(
      fs.access(path.join(stash.path, "old.md")),
    ).rejects.toThrow();
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

  it("stash_grep: should find matches in files", async () => {
    const stash = await manager.create("test");
    stash.write("a.md", "Hello world");
    stash.write("b.md", "Hello universe");
    stash.write("c.ts", "const x = 42");
    await stash.flush();

    // Write files to disk too
    await fs.writeFile(path.join(stash.path, "a.md"), "Hello world");
    await fs.writeFile(path.join(stash.path, "b.md"), "Hello universe");
    await fs.writeFile(path.join(stash.path, "c.ts"), "const x = 42");

    const result = await client.callTool({
      name: "stash_grep",
      arguments: { stash: "test", pattern: "Hello" },
    });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.matches).toHaveLength(2);
    expect(data.matches.map((m: any) => m.path).sort()).toEqual([
      "a.md",
      "b.md",
    ]);
  });

  it("stash_grep: should filter by glob", async () => {
    const stash = await manager.create("test");
    stash.write("a.md", "Hello world");
    stash.write("b.ts", "Hello universe");
    await stash.flush();

    await fs.writeFile(path.join(stash.path, "a.md"), "Hello world");
    await fs.writeFile(path.join(stash.path, "b.ts"), "Hello universe");

    const result = await client.callTool({
      name: "stash_grep",
      arguments: { stash: "test", pattern: "Hello", glob: "**/*.md" },
    });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.matches).toHaveLength(1);
    expect(data.matches[0].path).toBe("a.md");
  });
});
