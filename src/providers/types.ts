/**
 * SyncProvider interface for syncing stash documents with remote storage.
 *
 * The provider is a pure transport: it fetches remote bytes and pushes
 * merged bytes. Merge logic lives in the core (Stash.doSync).
 */
export interface SyncProvider {
  /**
   * Fetch all documents from remote storage.
   *
   * @returns Map of document ID to Automerge binary data.
   *          "structure" key is the structure doc, others are file docs (ULID keys).
   * @throws SyncError on network/auth failures (caller handles retry)
   */
  fetch(): Promise<Map<string, Uint8Array>>;

  /**
   * Push merged documents to remote storage.
   * Provider handles rendering and cleanup (e.g. deleting removed plain-text files) internally.
   *
   * @param docs - Map of document ID to Automerge binary data.
   * @throws SyncError on network/auth failures (caller handles retry)
   */
  push(docs: Map<string, Uint8Array>): Promise<void>;

  /**
   * Check if remote storage exists.
   */
  exists(): Promise<boolean>;

  /**
   * Create remote storage.
   */
  create(): Promise<void>;

  /**
   * Delete remote storage.
   */
  delete(): Promise<void>;
}
