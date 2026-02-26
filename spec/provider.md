# Sync Provider

Transport layer for fetching and pushing Automerge docs and file content. Merge logic lives in [Stash](./stash.md), not the provider. Source: `providers/types.ts`, `providers/github.ts`.

**Responsibility**: The provider is **solely responsible for the remote**: fetch, push, and (if implemented) optional `create?()` (ensure remote exists) and `delete?()` (destroy remote). The [manager](./manager.md) is solely responsible for stashes (local) and passes through to the provider for these remote operations when the provider implements them.

## Interface

`SyncProvider`: `fetch()` returns map of doc id → Automerge bytes; `push(payload)` makes remote match the given state; optional `create?()` — if present, ensures remote storage exists (so we can push); optional `delete?()` — if present, destroys remote storage. Key `"structure"` for structure doc, ULID keys for file docs. Missing remote storage should surface via `fetch()` (e.g. GitHub provider throws 404 when repo does not exist). Callers check `if (provider.create)` / `if (provider.delete)` before calling. See `providers/types.ts` for the full interface.

### Push payload

```ts
interface PushPayload {
  docs: Map<string, Uint8Array>;
  files: Map<string, string | Buffer>;
  changedPaths?: Iterable<string>;   // tree paths to update. Omit = push all.
  pathsToDelete?: Iterable<string>;  // user paths to remove. Omit = none.
}
```

When `changedPaths` is omitted, provider pushes everything (full sync). When present, provider creates blobs/tree entries only for those paths; unchanged paths are preserved via `base_tree`. When `pathsToDelete` is present, provider adds `sha: null` for those paths. Provider uses `getRef` + `getCommit` only (no recursive tree fetch).

## GitHub Provider

Remote format: `github:owner/repo` or `github:owner/repo/path`. Uses Octokit; default branch `main`. Fetches structure and docs from `.stash/` in the repo; push builds Git tree (blobs for Automerge and binary files, inline content for text), creates commit, updates ref. **GitHub peculiarity**: on truly empty repos, Git APIs may return "Git Repository is empty" from both blob and ref checks (`getRef` may return 409/422, not just 404); provider `push()` handles this by bootstrapping the branch/initial commit before normal sync commit creation. Implements `create()`: creates the repo if it doesn't exist (idempotent); first push then creates `.stash/` content (no .gitkeep). delete removes repo or only the path prefix. **Push optimizations**: when `changedPaths` is provided, only creates blobs for those paths; `pathsToDelete` derived from stash structure (no `getTree`/`listFiles`). Public helpers include single-file fetch; tree walking for push/delete is internal to the provider. Implementation detail: `providers/github.ts`.
