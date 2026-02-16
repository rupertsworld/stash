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
   * @param docs - Automerge blobs to store in .stash/ folder
   * @param files - Complete desired file state. Provider makes remote match this.
   *                Files not in this map should be deleted from remote.
   */
  push(docs: Map<string, Uint8Array>, files: Map<string, string | Buffer>): Promise<void>;

  /**
   * Create remote storage. Idempotent - no-op if already exists.
   * Throws only on actual errors (permissions, quota, etc.)
   */
  create(): Promise<void>;

  /**
   * Delete remote storage.
   */
  delete(): Promise<void>;
}
