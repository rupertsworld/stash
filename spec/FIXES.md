# Proposed Fixes

## 1. `dirty` flag never clears for local-only stashes

**File**: `src/core/stash.ts`

The `dirty` flag is set to `true` in `scheduleBackgroundSave()` but only cleared inside the sync `.then()` callback. If there's no provider, `sync()` returns immediately without clearing it, so `isDirty()` is permanently `true`.

**Fix**: The flag should mean "has unsaved changes". Use a generation counter so a save only clears the flag if no new writes arrived since that save was scheduled:

```typescript
private dirty = false;
private saveGeneration = 0;

private scheduleBackgroundSave(): void {
  this.dirty = true;
  this.saveGeneration++;

  const generationAtSchedule = this.saveGeneration;
  const previousSave = this.savePromise ?? Promise.resolve();
  this.savePromise = previousSave.then(() =>
    this.save()
      .then(() => {
        // Only clear if no new writes arrived since this save was scheduled
        if (this.saveGeneration === generationAtSchedule) {
          this.dirty = false;
        }
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

Without the counter, a naive "clear dirty after save" has a race: writes A and B fire quickly, save-A completes and clears dirty before save-B has finished.

---

## 2. `manager.reload()` on every MCP request

**File**: `src/mcp.ts`, `src/core/manager.ts`

Every tool call runs `manager.reload()`, which re-reads meta.json and deserializes every Automerge document for every stash. This is O(stashes * files) on every request, including reads.

The reload exists to pick up changes made by external processes (CLI, daemon). But it's far too aggressive.

**Fix**: Throttle reloads by time. Add `reloadIfStale()` that skips the reload if one happened recently:

```typescript
// src/core/manager.ts
private lastReloadMs = 0;
private static RELOAD_INTERVAL_MS = 2000;

async reloadIfStale(): Promise<void> {
  const now = Date.now();
  if (now - this.lastReloadMs < StashManager.RELOAD_INTERVAL_MS) return;
  this.lastReloadMs = now;
  await this.reload();
}
```

Set `this.lastReloadMs = Date.now()` at the end of `StashManager.load()`.

In `src/mcp.ts`, change `await manager.reload()` to `await manager.reloadIfStale()`.

This caps reloads to at most once per 2 seconds regardless of request rate. In the common case (rapid tool calls from an agent), most requests skip the reload entirely.

Note: a filesystem-mtime approach (check if `baseDir` changed) doesn't work here because directory mtime only updates when immediate children are added/removed, not when files inside stash subdirectories change.

---

## 3. Merge logic lives in the provider instead of the core

**Files**: `src/providers/types.ts`, `src/providers/github.ts`, `src/core/stash.ts`

The Automerge merge logic is inside `GitHubProvider.sync()`. Any new provider would have to duplicate it. Merging is a core CRDT concern, not a transport concern.

**Fix**: Split the provider interface into `fetch` and `push`, move merge into `Stash.doSync()`:

```typescript
// src/providers/types.ts
export interface SyncProvider {
  /** Fetch all documents from remote storage. */
  fetch(): Promise<Map<string, Uint8Array>>;

  /** Push merged documents to remote storage. Provider handles rendering/cleanup internally. */
  push(docs: Map<string, Uint8Array>): Promise<void>;

  exists(): Promise<boolean>;
  create(): Promise<void>;
  delete(): Promise<void>;
}
```

Note: no `deletedPaths` parameter. Deletion of rendered plain-text files is a GitHub-specific concern -- `GitHubProvider.push()` should compute that internally by comparing the incoming structure doc against the current remote tree (which it already fetches during push via `getRef`/`getCommit`).

Then `Stash.doSync()` becomes:

```typescript
private async doSync(): Promise<void> {
  // 1. Pre-sync: create empty docs for dangling refs (unchanged)
  // 2. Gather local docs as Automerge binaries (unchanged)

  // 3. Fetch remote
  const remoteDocs = await withRetry(() => this.provider!.fetch());

  // 4. Merge (now lives here, not in provider)
  const merged = new Map<string, Uint8Array>();
  for (const [docId, localData] of localDocs) {
    const remoteData = remoteDocs.get(docId);
    if (remoteData) {
      const localDoc = Automerge.load<unknown>(localData);
      const remoteDoc = Automerge.load<unknown>(remoteData);
      merged.set(docId, Automerge.save(Automerge.merge(localDoc, remoteDoc as typeof localDoc)));
    } else {
      merged.set(docId, localData);
    }
  }
  // Include remote-only docs
  for (const [docId, remoteData] of remoteDocs) {
    if (!localDocs.has(docId)) {
      merged.set(docId, remoteData);
    }
  }

  // 5. Push
  await withRetry(() => this.provider!.push(merged));

  // 6. Load merged state + persist (unchanged)
}
```

`GitHubProvider` drops its `sync()` method and its Automerge import entirely. It becomes a pure transport: fetch bytes from GitHub, push bytes to GitHub.

---

## 4. N+1 API calls during GitHub fetch

**File**: `src/providers/github.ts`

The `fetch()` method makes one `getContent()` call per file doc, sequentially. For N files, that's N+2 sequential calls (structure + directory listing + N file fetches).

**Fix**: Use the Git Trees API to discover all `.stash/` blobs in one call, then fetch blobs in parallel:

```typescript
private async fetch(): Promise<Map<string, Uint8Array>> {
  const docs = new Map<string, Uint8Array>();

  try {
    // 1. Get current commit (2 sequential calls)
    const { data: ref } = await this.octokit.rest.git.getRef({
      owner: this.owner, repo: this.repo,
      ref: `heads/${this.branch}`,
    });
    const { data: commit } = await this.octokit.rest.git.getCommit({
      owner: this.owner, repo: this.repo,
      commit_sha: ref.object.sha,
    });

    // 2. Get full tree in one call (returns SHA refs, not content)
    const { data: tree } = await this.octokit.rest.git.getTree({
      owner: this.owner, repo: this.repo,
      tree_sha: commit.tree.sha,
      recursive: "true",
    });

    // 3. Fetch all .automerge blobs in parallel
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

This reduces N+2 sequential calls to 3 sequential + N parallel. The tree call discovers all blob SHAs without listing directories, and blob fetches run concurrently.

---

## 6. `setContent` is O(n) per character

**File**: `src/core/file.ts`

`setContent` calls `d.content.deleteAt(0, len)` then `d.content.insertAt(0, ...content.split(""))`, spreading every character as a separate argument. For a 10KB file, that's 10,000 individual Automerge operations in a single change, inflating document history.

**Fix**: Use `splice` from `@automerge/automerge/next` (the `next` subpath export provides `splice` which isn't in the stable API of 2.2.8). Keep `Automerge.Text` type to avoid a breaking migration:

```typescript
import { splice } from "@automerge/automerge/next";

export function setContent(
  doc: Automerge.Doc<FileDoc>,
  content: string,
): Automerge.Doc<FileDoc> {
  return Automerge.change(doc, (d) => {
    splice(d, ["content"], 0, d.content.length, content);
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

**Implementation note**: `splice` from `@automerge/automerge/next` works with `Automerge.Text` objects, so no breaking migration is needed. The `FileDoc` interface and `createFileDoc` remain unchanged -- only `setContent` and `applyPatch` are updated to use `splice` instead of character-by-character `insertAt`.

---

## 7. Race condition in daemon MCP handling

**File**: `src/daemon.ts`

Each `POST /mcp` calls `mcpServer.connect(transport)` on the same `Server` instance. The MCP SDK's `Server.connect()` replaces the active transport. If two requests arrive concurrently, the second `connect()` overwrites the first request's transport, corrupting both.

**Fix**: Create a fresh MCP server per request:

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

`createMcpServer` is cheap -- it registers handler functions on a new Server object with no I/O. The shared `manager` instance provides the actual state. This gives complete isolation between concurrent requests.

---

## 8. `promptSecret` doesn't mask input

**File**: `src/cli/prompts.ts`

`promptSecret` falls through to `prompt()`. GitHub tokens are visible on screen.

**Fix**: Use a custom writable stream that discards output, so readline doesn't echo keystrokes:

```typescript
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

export async function promptSecret(question: string): Promise<string> {
  process.stdout.write(question);
  const rl = createInterface({
    input: process.stdin,
    output: new Writable({ write: (_chunk, _enc, cb) => cb() }),
    terminal: true,
  });
  try {
    return await rl.question("");
  } finally {
    rl.close();
    process.stdout.write("\n");
  }
}
```

Setting `terminal: true` ensures readline still processes backspace/delete correctly. The null writable suppresses echo without monkeypatching `process.stdout.write`.

---

## 9. Daemon stop relies on `lsof`

**File**: `src/cli/commands/stop.ts`

Uses `lsof -ti :32847` to find the daemon PID. This is Linux/macOS-specific and won't work on Windows.

**Fix**: Use a PID file. Use synchronous fs calls in signal handlers since the process is exiting immediately and async work may not complete before `process.exit`.

In `src/daemon.ts`:

```typescript
export async function startDaemon(baseDir: string = DEFAULT_STASH_DIR): Promise<void> {
  // ... existing setup ...

  const pidFile = path.join(baseDir, "daemon.pid");
  fs.writeFileSync(pidFile, String(process.pid));

  const cleanup = () => {
    try { fs.unlinkSync(pidFile); } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);

  // ... rest of startup ...
}
```

In `src/cli/commands/stop.ts`:

```typescript
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_STASH_DIR } from "../../core/config.js";

export async function stopDaemon(): Promise<void> {
  const pidFile = path.join(DEFAULT_STASH_DIR, "daemon.pid");

  let pid: number;
  try {
    pid = parseInt(await fs.readFile(pidFile, "utf-8"), 10);
  } catch {
    console.log("Daemon is not running.");
    return;
  }

  // Verify process is actually alive (handles stale PID files from crashes)
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't actually kill
  } catch {
    await fs.unlink(pidFile).catch(() => {});
    console.log("Daemon is not running (cleaned up stale PID file).");
    return;
  }

  process.kill(pid, "SIGTERM");
  console.log("Daemon stopped.");
}
```

The `kill(pid, 0)` check detects stale PID files left by crashes without accidentally killing an unrelated process.

---

## 10. No stash name validation

**File**: `src/core/manager.ts` (in `create` and `connect`)

Names like `../etc` or names with path separators could cause directory traversal since the name is used directly in `path.join(baseDir, name)`.

**Fix**: Add a validation function and call it at the top of `create()` and `connect()`:

```typescript
const VALID_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function validateStashName(name: string): void {
  if (!name || name.length > 64) {
    throw new Error("Stash name must be 1-64 characters");
  }
  if (!VALID_NAME.test(name)) {
    throw new Error(
      "Stash name must start with a letter or number and contain only "
      + "letters, numbers, dots, hyphens, or underscores"
    );
  }
}
```

The regex already rejects `.`, `..`, `/`, `\`, leading hyphens/dots, and empty strings, so no secondary checks are needed.

---

## 11. Config file has no permission restrictions

**File**: `src/core/config.ts`

`config.json` containing the GitHub token is written with default umask, potentially readable by other users.

**Fix**: Set restrictive permissions:

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

`0o700` on the directory and `0o600` on the file ensures only the owning user can access the config. On Windows these flags are ignored, but Windows has different permission semantics.

---

## 12. `inquirer` is a dead dependency

**File**: `package.json`

`inquirer` (9.3.7) is listed as a dependency but never imported. The CLI uses custom prompts built on `readline/promises` in `src/cli/prompts.ts`.

**Fix**:

```bash
npm uninstall inquirer
```
