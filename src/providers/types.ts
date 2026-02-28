/**
 * Result of a fetch operation.
 * - unchanged: true means remote HEAD hasn't moved since last fetch. docs is empty.
 * - unchanged: false means remote has new commits, or first fetch, or remote is empty.
 *   docs contains changed docs (partial or complete depending on provider state).
 */
export interface FetchResult {
  docs: Map<string, Uint8Array>;
  unchanged: boolean;
}

/**
 * Persisted sync state for a provider (e.g. cached SHAs for GitHub).
 */
export interface SyncState {
  lastHeadSha: string | null;
  blobShas: Record<string, string>;
}

/**
 * Payload for push.
 * - changedPaths omitted or empty: push everything (e.g. first sync).
 * - changedPaths non-empty: create blobs/tree entries only for those paths (incremental).
 */
export interface PushPayload {
  docs: Map<string, Uint8Array>;
  files: Map<string, string | Buffer>;
  /** Tree paths to update. Omit or empty = push all. Non-empty = incremental. */
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
   * Fetch documents from remote storage.
   *
   * @returns FetchResult with changed docs and unchanged flag.
   *          When unchanged is true, docs is empty (remote HEAD hasn't moved).
   *          When unchanged is false, docs contains changed docs (or all docs on first fetch).
   *          "structure" key is the structure doc, others are file docs (ULID keys).
   *          Returns empty docs with unchanged: false if remote has no docs yet.
   */
  fetch(): Promise<FetchResult>;

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

  /**
   * Get current sync state for persistence.
   * Optional: providers that support caching should implement this.
   */
  getSyncState?(): SyncState;
}
