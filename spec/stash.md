# Stash

The `Stash` class manages CRDT state for a single stash. Source: `core/stash.ts`, `core/structure.ts`, `core/file.ts`. See [index](./index.md) for data model (`StructureDoc`, `FileDoc`, `StashMeta`).

## Role

- **Construction**: `Stash.create` for new in-memory stash; `Stash.load` reads from disk (meta, structure, referenced file docs, known paths). Unreferenced docs on disk are ignored.
- **File operations**: read, write, patch, delete, move/rename, list, glob. Mutating ops schedule a background save. API detail: see `Stash` class and JSDoc in `core/stash.ts`.
- **Persistence**: Atomic writes for all files. Saves meta, structure, each file doc under `docs/<docId>.automerge`, and known paths. Chained background save with generation tracking; sync is debounced after save.

## Concepts

- **Known paths**: Local-only set of paths this machine has seen; persisted in `known-paths.json`. Used to tell "deleted here" vs "never seen" so we can resurrect files from disk or remote when appropriate. Not synced.
- **Sync**: With a provider, sync fetches remote, merges (see below), builds push payload (`docs`, `files`, `changedPaths`, `pathsToDelete`), pushes, then saves. No-op without provider; guarded so only one sync runs at a time. Dangling doc refs are fixed before fetch (empty text doc created if missing).
- **Conflict resolution**: In `mergeWithRemote`. Fresh join (local empty): adopt remote structure and file docs, mark paths known. Normal merge: snapshot local-only new files, merge structure and file docs, restore clobbered locals, then apply content-wins rule for tombstones (if both sides have content and differ, non-empty content clears the tombstone to avoid data loss). Detail in `core/stash.ts`.

## Doc access and metadata

Lower-level doc access (`getDocId`, `getFileDoc`, `setFileDoc`, `cloneFileDoc`, etc.) and metadata (`getMeta`, `setMeta`, provider, actorId, dirty, flush) are used by the reconciler and sync. See `Stash` in `core/stash.ts` for the full API.
