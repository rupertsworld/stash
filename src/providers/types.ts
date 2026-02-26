/**
 * Payload for push. When changedPaths is omitted, provider pushes everything.
 * When present, provider creates blobs/tree entries only for those paths.
 */
export interface PushPayload {
  docs: Map<string, Uint8Array>;
  files: Map<string, string | Buffer>;
  /** Tree paths to update. Omit = push all. */
  changedPaths?: Iterable<string>;
  /** User paths to remove. Omit = none. */
  pathsToDelete?: Iterable<string>;
}

/**
 * SyncProvider interface for syncing stash documents with remote storage.
 *
 * The provider is a transport layer - it fetches and pushes documents.
 * Merge logic is handled by the Stash, not the provider.
 */
export interface SyncProvider {
  /**
   * Fetch all documents from remote storage.
   *
   * @returns Map of document ID to Automerge binary data.
   *          "structure" key is the structure doc, others are file docs (ULID keys).
   *          Returns empty map if remote has no docs yet.
   */
  fetch(): Promise<Map<string, Uint8Array>>;

  /**
   * Push to remote storage.
   *
   * @param payload - docs, files, and optional changedPaths/pathsToDelete for incremental push.
   */
  push(payload: PushPayload): Promise<void>;

  /**
   * Ensure remote storage exists so we can push (e.g. create the repo if missing).
   * Optional: omit if this provider cannot create the remote.
   * Callers must check `if (provider.create)` before calling.
   */
  create?(): Promise<void>;

  /**
   * Destroy remote storage.
   * Optional: omit if this provider cannot delete the remote.
   * Callers must check `if (provider.delete)` before calling.
   */
  delete?(): Promise<void>;
}
