# Proposed Fixes

## 1. `dirty` flag never clears for local-only stashes

**File**: `src/core/stash.ts`

The `dirty` flag is set to `true` in `scheduleBackgroundSave()` but only cleared inside the sync `.then()` callback. If there's no provider, `sync()` returns immediately without clearing it.

**Fix**: Clear `dirty` after save completes, not after sync. The flag should mean "has unsaved changes", not "has unsynced changes". Move `this.dirty = false` into the save chain:

```typescript
private scheduleBackgroundSave(): void {
  this.dirty = true;

  const previousSave = this.savePromise ?? Promise.resolve();
  this.savePromise = previousSave.then(() =>
    this.save()
      .then(() => {
        this.dirty = false;
      })
      .catch((err) => {
        console.error(`Save failed for ${this.name}:`, (err as Error).message);
      })
  );

  // Debounce sync (unchanged)
  if (this.syncTimeout) {
    clearTimeout(this.syncTimeout);
  }
  this.syncTimeout = setTimeout(() => {
    this.syncTimeout = null;
    this.sync().catch((err) => {
      console.error(`Sync failed for ${this.name}:`, (err as Error).message);
    });
  }, Stash.SYNC_DEBOUNCE_MS);
}
```

---

## 2. `manager.reload()` on every MCP request

**File**: `src/mcp.ts`

Every tool call deserializes all stashes from disk. This is expensive and unnecessary -- the in-memory state is already up to date for changes made through the MCP server itself. The reload is only needed to pick up changes made by *other* processes (CLI, daemon file watcher).

**Fix**: Replace the full reload with a lightweight staleness check. Add a `lastLoadTime` to `StashManager` and only reload if the base directory's mtime has changed:

In `src/core/manager.ts`, add:

```typescript
private lastLoadTime: number = 0;

async reloadIfChanged(): Promise<void> {
  try {
    const stat = await fs.stat(this.baseDir);
    if (stat.mtimeMs > this.lastLoadTime) {
      await this.reload();
      this.lastLoadTime = Date.now();
    }
  } catch {
    // Base dir doesn't exist, nothing to reload
  }
}
```

Set `this.lastLoadTime = Date.now()` at the end of `StashManager.load()`.

In `src/mcp.ts`, change `await manager.reload()` to `await manager.reloadIfChanged()`.

This reduces the common case (no external changes) to a single `fs.stat` call.

---

## 3. Merge logic lives in the provider instead of the core

**Files**: `src/providers/types.ts`, `src/providers/github.ts`, `src/core/stash.ts`

The Automerge merge logic is inside `GitHubProvider.sync()`. Any new provider would have to duplicate it. The merge is a core concern, not a provider concern.

**Fix**: Split the provider interface into `fetch` and `push`, and move merge into `Stash.doSync()`:

```typescript
// src/providers/types.ts
export interface SyncProvider {
  fetch(): Promise<Map<string, Uint8Array>>;
  push(docs: Map<string, Uint8Array>, deletedPaths?: string[]): Promise<void>;
  exists(): Promise<boolean>;
  create(): Promise<void>;
  delete(): Promise<void>;
}
```

Then in `Stash.doSync()`, the flow becomes:

```typescript
private async doSync(): Promise<void> {
  // 1. Pre-sync: create empty docs for dangling refs (unchanged)
  // 2. Gather local docs (unchanged)

  // 3. Fetch remote
  const remoteDocs = await withRetry(() => this.provider!.fetch());

  // 4. Merge locally (moved from GitHubProvider)
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
  for (const [docId, remoteData] of remoteDocs) {
    if (!localDocs.has(docId)) {
      merged.set(docId, remoteData);
    }
  }

  // 5. Compute deleted paths
  const deletedPaths = computeDeletedPaths(remoteDocs, merged);

  // 6. Push
  await withRetry(() => this.provider!.push(merged, deletedPaths));

  // 7. Load merged state + persist (unchanged)
}
```

`GitHubProvider` simplifies to just `fetch()` (read from GitHub) and `push()` (write to GitHub). The `sync()` method is removed.

---

## 4. N+1 API calls during GitHub fetch

**File**: `src/providers/github.ts`

The `fetch()` method makes one API call per file doc. For N files, that's N+2 calls (structure + directory listing + N file fetches).

**Fix**: Use the Git Trees API to fetch the entire `.stash/` tree in a single call, then fetch blobs in parallel:

```typescript
private async fetch(): Promise<Map<string, Uint8Array>> {
  const docs = new Map<string, Uint8Array>();

  try {
    // Get the current tree recursively (single API call)
    const { data: ref } = await this.octokit.rest.git.getRef({
      owner: this.owner, repo: this.repo,
      ref: `heads/${this.branch}`,
    });
    const { data: commit } = await this.octokit.rest.git.getCommit({
      owner: this.owner, repo: this.repo,
      commit_sha: ref.object.sha,
    });
    const { data: tree } = await this.octokit.rest.git.getTree({
      owner: this.owner, repo: this.repo,
      tree_sha: commit.tree.sha,
      recursive: "true",
    });

    // Find all .automerge blobs in .stash/
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
    throw err;
  }

  return docs;
}
```

This reduces N+2 sequential calls to 3 sequential + N parallel (tree fetch + parallel blob fetches). For most repos, blobs under 100KB are already included inline in the tree response, potentially reducing to a single call.

---

## 6. `setContent` is O(n) per character

**File**: `src/core/file.ts`

`setContent` calls `d.content.deleteAt(0, len)` then `d.content.insertAt(0, ...content.split(""))`, which spreads every character as a separate argument. This creates a huge Automerge operation list and is very slow for large files.

**Fix**: Use Automerge's `splice` method (available in Automerge 2.x) instead of character-by-character operations:

```typescript
export function setContent(
  doc: Automerge.Doc<FileDoc>,
  content: string,
): Automerge.Doc<FileDoc> {
  return Automerge.change(doc, (d) => {
    Automerge.splice(d, ["content"], 0, d.content.length, content);
  });
}

export function applyPatch(
  doc: Automerge.Doc<FileDoc>,
  start: number,
  end: number,
  text: string,
): Automerge.Doc<FileDoc> {
  return Automerge.change(doc, (d) => {
    Automerge.splice(d, ["content"], start, end - start, text);
  });
}
```

`Automerge.splice` operates on the text efficiently at the CRDT level without spreading into individual characters.

**Note**: This also requires switching from `new Automerge.Text(content)` to a plain string in `createFileDoc`, since `Automerge.splice` works with Automerge's native string type rather than the deprecated `Text` class:

```typescript
export function createFileDoc(
  content: string = "",
  actorId?: string,
): Automerge.Doc<FileDoc> {
  return Automerge.from<FileDoc>(
    { content: content },
    actorId ? { actor: actorId as Automerge.ActorId } : undefined,
  );
}
```

The `FileDoc` interface would change `content` from `Automerge.Text` to `string`, and `getContent` would just return `doc.content` directly.

---

## 7. Race condition in daemon MCP handling

**File**: `src/daemon.ts`

Each request calls `mcpServer.connect(transport)` on the same `Server` instance. Concurrent requests could interleave server state.

**Fix**: Create a fresh MCP server per request, or use a request-scoped pattern:

```typescript
app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const requestServer = createMcpServer(manager);
  res.on("close", () => transport.close());
  await requestServer.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
```

`createMcpServer` is cheap (it just registers handlers, no I/O), so creating one per request is fine. This ensures complete isolation between concurrent requests.

---

## 8. `promptSecret` doesn't mask input

**File**: `src/cli/prompts.ts`

**Fix**: Use Node's readline with output muted. Replace the current `promptSecret`:

```typescript
export async function promptSecret(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Mute output after the question is printed
  process.stdout.write(question);
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;

  try {
    const answer = await rl.question("");
    return answer;
  } finally {
    process.stdout.write = origWrite;
    process.stdout.write("\n");
    rl.close();
  }
}
```

Alternatively, add a dependency on a small library like `read` that handles masked input properly. But the above works with zero dependencies.

---

## 9. Daemon stop relies on `lsof`

**File**: `src/cli/commands/stop.ts`

**Fix**: Write a PID file when the daemon starts, read it on stop.

In `src/daemon.ts`:

```typescript
import { DEFAULT_STASH_DIR } from "./core/config.js";

const PID_FILE = path.join(DEFAULT_STASH_DIR, "daemon.pid");

export async function startDaemon(baseDir: string = DEFAULT_STASH_DIR): Promise<void> {
  // ... existing setup ...

  await fs.promises.writeFile(PID_FILE, String(process.pid));

  process.on("SIGTERM", async () => {
    try { await fs.promises.unlink(PID_FILE); } catch {}
    process.exit(0);
  });

  // ... rest of startup ...
}
```

In `src/cli/commands/stop.ts`:

```typescript
export async function stopDaemon(): Promise<void> {
  const pidFile = path.join(DEFAULT_STASH_DIR, "daemon.pid");
  try {
    const pid = parseInt(await fs.readFile(pidFile, "utf-8"), 10);
    process.kill(pid, "SIGTERM");
    console.log("Daemon stopped.");
  } catch {
    console.log("Daemon is not running.");
  }
}
```

This is cross-platform and doesn't depend on `lsof`.

---

## 10. No stash name validation

**File**: `src/core/manager.ts` (in `create` and `connect`)

**Fix**: Add a validation function and call it before creating or connecting:

```typescript
const VALID_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function validateStashName(name: string): void {
  if (!name || name.length > 64) {
    throw new Error("Stash name must be 1-64 characters");
  }
  if (!VALID_NAME.test(name)) {
    throw new Error(
      "Stash name must start with alphanumeric and contain only letters, numbers, dots, hyphens, underscores"
    );
  }
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error("Invalid stash name");
  }
}
```

Call `validateStashName(name)` at the top of `create()` and `connect()`.

---

## 11. Config file has no permission restrictions

**File**: `src/core/config.ts`

**Fix**: Set restrictive file permissions when writing the config:

```typescript
export async function writeConfig(
  config: StashConfig,
  baseDir: string = DEFAULT_STASH_DIR,
): Promise<void> {
  const filePath = configPath(baseDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}
```

`0o700` on the directory and `0o600` on the file ensures only the owning user can read or write the config.

---

## 12. `inquirer` is a dead dependency

**File**: `package.json`

**Fix**: Remove it:

```bash
npm uninstall inquirer
```

The CLI uses custom prompts in `src/cli/prompts.ts` built on `readline/promises`. `inquirer` is never imported anywhere.
