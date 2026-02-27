# Reconciler

`StashReconciler` keeps filesystem and Automerge state in sync. One per stash. Source: `core/reconciler.ts`. Operates on a [Stash](./stash.md) instance.

## API

| Method | Behavior |
|--------|----------|
| `start()` | Initialize disk snapshots, start chokidar. |
| `close()` | Stop watcher, clear pending-delete timers, clear snapshots. |
| `scan()` | One-time full reconcile: import disk-only files, delete Automerge-only. |
| `flush()` | Write all tracked files to disk, run orphan cleanup, re-check for changes during write. |

## Role
- **File watcher**: Chokidar on stash path, ignoring `.stash/` and hidden files, no symlinks, 200ms write stability. Events: add → onFileCreated, change → onFileModified, unlink → onFileDeleted. Handlers skip work when `writing` is true (avoids feedback during flush). Watch mode defaults to native filesystem events; polling can be enabled with `STASH_USE_POLLING=1` (tests also run with polling for deterministic event delivery).

## Concepts

- **Disk snapshots**: A map of path → `{ doc, content }` (cloned Automerge doc + text at snapshot time). Used as common ancestor for three-way merge: snapshot vs disk vs current Automerge.
- **onFileModified**: Read disk, detect text vs binary (UTF-8); handle type changes (text↔binary). For text with snapshot: diff (fast-diff) snapshot→disk, apply patches to forked doc, merge with current state, write merged content to disk, update snapshot. Saves and schedules sync.
- **Rename detection**: On create, check pending-deletes by content hash (and basename); if match, treat as rename (move entry, cancel delete timer). Pending deletes use a short delay (~500ms) before tombstoning so renames aren’t misread as delete+create.
- **onFileDeleted**: Start timer; when it fires, tombstone in stash, drop snapshot, remove empty parents, GC blob if binary and hash unreferenced.
- **Scan / Flush / Orphan cleanup**: Scan imports disk-only files and deletes Automerge-only. Flush writes all tracked files to disk (with conflict handling when user edited during write). Orphan cleanup: tombstone+known → delete from disk; tombstone+unknown → resurrect; not in structure → import. Detail in `core/reconciler.ts`.
