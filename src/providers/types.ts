/**
 * SyncProvider interface for syncing stash documents with remote storage.
 *
 * The provider owns the entire sync process: fetching, merging, pushing,
 * and rendering. Stash just hands over all documents and gets merged state back.
 */
export interface SyncProvider {
  /**
   * Sync all documents with remote storage.
   *
   * @param docs - Map of document ID to Automerge binary data.
   *               "structure" key is the structure doc, others are file docs (ULID keys).
   * @returns Map of merged documents. Must include all docs from input,
   *          plus any remote-only docs discovered during sync.
   * @throws SyncError on network/auth failures (caller handles retry)
   */
  sync(docs: Map<string, Uint8Array>): Promise<Map<string, Uint8Array>>;
}
