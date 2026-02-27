# Sync Provider

Transport layer for fetching and pushing Automerge docs and file content. Merge logic lives in [Stash](./stash.md), not the provider. Source: `providers/types.ts`, `providers/github.ts`.

**Responsibility**: The provider is **solely responsible for the remote**: fetch, push, and (if implemented) optional `create?()` (ensure remote exists) and `delete?()` (destroy remote). The [manager](./manager.md) is solely responsible for stashes (local) and passes through to the provider for these remote operations when the provider implements them.

## Interface

`SyncProvider`: `fetch()` returns map of doc id → Automerge bytes; `push(payload)` applies file-level changes to remote; optional `create?()` — if present, ensures remote storage exists (so we can push); optional `delete?()` — if present, destroys remote storage. Key `"structure"` for structure doc, ULID keys for file docs. Missing remote storage should surface via `fetch()` (e.g. GitHub provider throws 404 when repo does not exist). Callers check `if (provider.create)` / `if (provider.delete)` before calling. See `providers/types.ts` for the full interface.

### Push payload

```ts
interface PushPayload {
  docs: Map<string, Uint8Array>;      // structure + file docs (Automerge bytes)
  files: Map<string, string | Buffer>; // path -> rendered content (text or binary)
  changedPaths?: Iterable<string>;     // omit = push all
  pathsToDelete?: Iterable<string>;   // omit = none
}
```

The provider is transport-only: it applies writes/deletes from `push(payload)` and avoids stash-domain decisions. `Stash` decides payload composition; provider decides only remote transport details.

`docs` contains `.stash/structure.automerge` and `.stash/docs/*.automerge`. `files` contains user-visible rendered file content. When `changedPaths` is present, provider creates blobs/tree entries only for those paths. When `pathsToDelete` is present, provider adds deletion entries for those paths.

## GitHub Provider

Remote format: `github:owner/repo` or `github:owner/repo/path`. Uses Octokit. Fetches structure and docs from `.stash/` in the repo; push builds Git tree from `docs` + `files`, creates commit, updates ref.

**Tree entries**: all file content (text and binary) is pushed via `createBlob`; tree entries use `sha` only, never inline `content`, to avoid "Invalid tree info" errors from the GitHub tree API.

**Empty-repo detection**: Use `repos.listBranches` — returns `[]` when the repo has no commits. Do not use `pushed_at`; it is unreliable (can be set for empty repos).

**Empty-repo bootstrap**: When `listBranches` returns `[]`, bootstrap directly via `createOrUpdateFileContents` (fast; avoids slow `getRef`/`createTree` on empty repos). Creates branch `main` (GitHub's default for new repos).

**Branch selection**: When the repo has branches, use the repo's `default_branch` from `repos.get` (not a hardcoded `main`). This avoids 404 when connecting to repos that use `master` or another default. Provider adopts the repo's default for getRef/updateRef.

**changedPaths empty**: When `changedPaths` is omitted or empty (e.g. first sync), push all paths. When non-empty, push only those paths (incremental).

Implements `create()`: creates the repo if it doesn't exist (idempotent); first push then creates `.stash/` content (no .gitkeep). delete removes repo or only the path prefix. Public helpers include single-file fetch; tree walking for push/delete is internal to the provider. Implementation detail: `providers/github.ts`.
