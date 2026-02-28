import * as Automerge from "@automerge/automerge";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ulid } from "ulid";
import { minimatch } from "minimatch";
import {
  createStructureDoc,
  addFile,
  removeFile,
  moveFile as moveStructureFile,
  getEntry,
  listPaths,
  listDeletedPaths,
  isDeleted,
  type StructureDoc,
} from "./structure.js";
import {
  createFileDoc,
  createBinaryFileDoc,
  getContent,
  setContent,
  applyPatch,
  type FileDoc,
  type BinaryFileDoc,
} from "./file.js";
import type { SyncProvider, SyncState } from "../providers/types.js";
import { withRetry } from "./errors.js";

interface SyncSnapshot {
  structure: string[];
  docs: Record<string, string[]>;
  files: Record<string, string>;
}

interface PersistedSyncState extends SyncState {
  lastPushedSnapshot: SyncSnapshot | null;
}

export interface StashMeta {
  name: string;
  description?: string;
  remote?: string | null; // e.g., "github:user/repo"
}

export class Stash {
  readonly name: string;
  readonly path: string; // absolute path to stash root
  private structureDoc: Automerge.Doc<StructureDoc>;
  private fileDocs: Map<string, Automerge.Doc<FileDoc>>;
  private provider: SyncProvider | null;
  private meta: StashMeta;
  private actorId: string;
  private dirty = false;
  private saveGeneration = 0;
  private savePromise: Promise<void> | null = null;
  private syncTimeout: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;
  private static SYNC_DEBOUNCE_MS = 2000;
  // Known paths: tracks files we've seen locally (for distinguishing new vs deleted)
  private knownPaths: Set<string> = new Set();
  private lastPushedSnapshot: SyncSnapshot | null = null;

  constructor(
    name: string,
    stashPath: string,
    structureDoc: Automerge.Doc<StructureDoc>,
    fileDocs: Map<string, Automerge.Doc<FileDoc>>,
    meta: StashMeta,
    actorId: string,
    provider: SyncProvider | null = null,
  ) {
    this.name = name;
    this.path = stashPath;
    this.structureDoc = structureDoc;
    this.fileDocs = fileDocs;
    this.meta = meta;
    this.actorId = actorId;
    this.provider = provider;
  }

  private getHexActorId(): string {
    return Buffer.from(this.actorId).toString("hex").padEnd(64, "0");
  }

  static create(
    name: string,
    stashPath: string,
    actorId: string,
    provider: SyncProvider | null = null,
    remote: string | null = null,
    description?: string,
  ): Stash {
    const hexActorId = Buffer.from(actorId).toString("hex").padEnd(64, "0");
    const structureDoc = createStructureDoc(hexActorId);
    const meta: StashMeta = {
      name,
      description,
      remote,
    };
    const stash = new Stash(
      name,
      stashPath,
      structureDoc,
      new Map(),
      meta,
      actorId,
      provider,
    );
    // Remote-enabled stashes start with a baseline snapshot so "connect"
    // does not immediately treat empty local state as unpushed local changes.
    if (provider) {
      stash.lastPushedSnapshot = stash.buildSyncSnapshot();
    }
    return stash;
  }

  static async load(
    name: string,
    stashPath: string,
    actorId: string,
    provider: SyncProvider | null = null,
  ): Promise<Stash> {
    const stashDir = path.join(stashPath, ".stash");

    // Read meta
    const metaData = await fs.readFile(
      path.join(stashDir, "meta.json"),
      "utf-8",
    );
    const meta: StashMeta = JSON.parse(metaData);

    // Load structure doc
    const structureBin = await fs.readFile(
      path.join(stashDir, "structure.automerge"),
    );
    const structureDoc = Automerge.load<StructureDoc>(
      new Uint8Array(structureBin),
    );

    // Load file docs referenced in structure
    const fileDocs = new Map<string, Automerge.Doc<FileDoc>>();
    const referencedDocIds = new Set(
      Object.values(structureDoc.files).map((f) => f.docId),
    );

    const docsDir = path.join(stashDir, "docs");
    try {
      const entries = await fs.readdir(docsDir);
      for (const entry of entries) {
        if (!entry.endsWith(".automerge")) continue;
        const docId = entry.replace(".automerge", "");
        if (!referencedDocIds.has(docId)) continue;
        const docBin = await fs.readFile(path.join(docsDir, entry));
        fileDocs.set(docId, Automerge.load<FileDoc>(new Uint8Array(docBin)));
      }
    } catch {
      // docs dir might not exist yet
    }

    let lastPushedSnapshot: SyncSnapshot | null = null;
    try {
      const syncStateData = await fs.readFile(
        path.join(stashDir, "sync-state.json"),
        "utf-8",
      );
      const persisted = JSON.parse(syncStateData) as Partial<PersistedSyncState>;
      if ("lastPushedSnapshot" in persisted) {
        lastPushedSnapshot = persisted.lastPushedSnapshot ?? null;
      }
    } catch {
      // sync-state may not exist yet
    }

    const stash = new Stash(name, stashPath, structureDoc, fileDocs, meta, actorId, provider);
    stash.lastPushedSnapshot = lastPushedSnapshot;
    await stash.loadKnownPaths();
    return stash;
  }

  // --- File enumeration ---
  listAllFiles(): Array<[string, string]> {
    const result: Array<[string, string]> = [];
    for (const filePath of listPaths(this.structureDoc)) {
      const entry = getEntry(this.structureDoc, filePath);
      if (entry) result.push([filePath, entry.docId]);
    }
    return result;
  }

  // --- Doc access ---
  getDocId(relativePath: string): string | null {
    const entry = getEntry(this.structureDoc, relativePath);
    return entry?.docId ?? null;
  }

  getFileDoc(docId: string): Automerge.Doc<FileDoc> | null {
    return this.fileDocs.get(docId) ?? null;
  }

  getFileDocByPath(relativePath: string): Automerge.Doc<FileDoc> | null {
    const docId = this.getDocId(relativePath);
    if (!docId) return null;
    return this.getFileDoc(docId);
  }

  // --- Read content ---
  read(filePath: string): string {
    const entry = getEntry(this.structureDoc, filePath);
    if (!entry || entry.deleted) throw new Error(`File not found: ${filePath}`);
    const doc = this.fileDocs.get(entry.docId);
    if (!doc) throw new Error(`File not found: ${filePath}`);
    return getContent(doc);
  }

  isDeleted(filePath: string): boolean {
    return isDeleted(this.structureDoc, filePath);
  }

  // --- Write operations ---
  write(filePath: string, content: string): void {
    const entry = getEntry(this.structureDoc, filePath);
    const hexActorId = this.getHexActorId();

    if (entry && !entry.deleted) {
      // Update existing file
      const doc = this.fileDocs.get(entry.docId);
      if (doc) {
        this.fileDocs.set(entry.docId, setContent(doc, content));
      }
    } else {
      // Create new file (or resurrect deleted path with new docId)
      const result = addFile(this.structureDoc, filePath);
      this.structureDoc = result.doc;
      this.fileDocs.set(result.docId, createFileDoc(content, hexActorId));
    }
    this.knownPaths.add(filePath);
    this.scheduleBackgroundSave();
  }

  writeBinary(relativePath: string, hash: string, size: number): void {
    const entry = getEntry(this.structureDoc, relativePath);
    const hexActorId = this.getHexActorId();
    if (entry) {
      this.fileDocs.set(
        entry.docId,
        createBinaryFileDoc(hash, size, hexActorId),
      );
    } else {
      const result = addFile(this.structureDoc, relativePath);
      this.structureDoc = result.doc;
      this.fileDocs.set(
        result.docId,
        createBinaryFileDoc(hash, size, hexActorId),
      );
    }
    this.scheduleBackgroundSave();
  }

  patch(filePath: string, start: number, end: number, text: string): void {
    const entry = getEntry(this.structureDoc, filePath);
    if (!entry) throw new Error(`File not found: ${filePath}`);
    const doc = this.fileDocs.get(entry.docId);
    if (!doc) throw new Error(`File not found: ${filePath}`);
    this.fileDocs.set(entry.docId, applyPatch(doc, start, end, text));
    this.scheduleBackgroundSave();
  }

  delete(filePath: string): void {
    const entry = getEntry(this.structureDoc, filePath);
    if (!entry || entry.deleted) throw new Error(`File not found: ${filePath}`);
    this.structureDoc = removeFile(this.structureDoc, filePath);
    // Keep the doc in fileDocs for now - needed for "content wins" conflict resolution
    // It will be garbage collected after sync confirms deletion
    this.scheduleBackgroundSave();
  }

  move(from: string, to: string): void {
    const entry = getEntry(this.structureDoc, from);
    if (!entry) throw new Error(`File not found: ${from}`);
    this.structureDoc = moveStructureFile(this.structureDoc, from, to);
    this.scheduleBackgroundSave();
  }

  renameFile(oldPath: string, newPath: string): void {
    this.move(oldPath, newPath);
  }

  // --- Doc manipulation (for snapshot-based merge) ---
  setFileDoc(relativePath: string, doc: Automerge.Doc<FileDoc>): void {
    const entry = getEntry(this.structureDoc, relativePath);
    if (!entry) throw new Error(`File not found: ${relativePath}`);
    this.fileDocs.set(entry.docId, doc);
  }

  cloneFileDoc(docId: string): Automerge.Doc<FileDoc> {
    const doc = this.fileDocs.get(docId);
    if (!doc) throw new Error(`Doc not found: ${docId}`);
    return Automerge.clone(doc);
  }

  // --- Binary support ---
  isHashReferenced(hash: string): boolean {
    for (const [, docId] of this.listAllFiles()) {
      const doc = this.fileDocs.get(docId);
      if (doc && doc.type === "binary" && (doc as BinaryFileDoc).hash === hash) {
        return true;
      }
    }
    return false;
  }

  setBinaryMeta(
    relativePath: string,
    meta: { type: "binary"; hash: string; size: number },
  ): void {
    this.writeBinary(relativePath, meta.hash, meta.size);
  }

  // --- Directory listing ---
  list(dir?: string): string[] {
    const allPaths = listPaths(this.structureDoc);

    if (!dir || dir === "") {
      const items = new Set<string>();
      for (const p of allPaths) {
        const parts = p.split("/");
        if (parts.length === 1) {
          items.add(p);
        } else {
          items.add(parts[0] + "/");
        }
      }
      return [...items].sort();
    }

    const prefix = dir.endsWith("/") ? dir : dir + "/";
    const items = new Set<string>();
    for (const p of allPaths) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const parts = rest.split("/");
      if (parts.length === 1) {
        items.add(rest);
      } else {
        items.add(parts[0] + "/");
      }
    }
    return [...items].sort();
  }

  glob(pattern: string): string[] {
    const allPaths = listPaths(this.structureDoc);
    return allPaths.filter((p) => minimatch(p, pattern)).sort();
  }

  // --- Sync ---
  isSyncing(): boolean {
    return this.syncing;
  }

  async sync(): Promise<void> {
    if (!this.provider) return;
    if (this.syncing) return;

    this.syncing = true;
    try {
      await this.doSync();
    } finally {
      this.syncing = false;
    }
  }

  private async doSync(): Promise<void> {
    // Fix dangling refs before sync
    for (const [filePath, entry] of Object.entries(this.structureDoc.files)) {
      if (!this.fileDocs.has(entry.docId)) {
        console.warn(`Creating empty doc for dangling ref: ${filePath}`);
        const hexActorId = this.getHexActorId();
        this.fileDocs.set(entry.docId, createFileDoc("", hexActorId));
      }
    }

    const localSnapshot = this.buildSyncSnapshot();
    const hasLocalChanges =
      !this.lastPushedSnapshot ||
      !this.snapshotsEqual(localSnapshot, this.lastPushedSnapshot);

    const result = await withRetry(() => this.provider!.fetch());

    // Nothing changed remotely, and local state already matches last pushed baseline.
    if (result.unchanged && !hasLocalChanges) {
      return;
    }

    // Remote unchanged but local changed: push local state.
    if (result.unchanged) {
      await this.pushCurrentState(localSnapshot);
      return;
    }

    // Remote branch exists but has no stash docs yet: populate from local.
    if (result.docs.size === 0) {
      await this.pushCurrentState(localSnapshot);
      return;
    }

    // Remote changed: merge incremental/full docs into local state.
    this.mergeWithRemote(result.docs);

    // Remote-only changes: save merged state locally, defer push.
    if (!hasLocalChanges) {
      this.lastPushedSnapshot = this.buildSyncSnapshot();
      await this.save();
      return;
    }

    // Both local and remote changed: push merged state.
    await this.pushCurrentState(localSnapshot);
  }

  private async pushCurrentState(fallbackBaseline: SyncSnapshot): Promise<void> {
    const docs = this.buildMergedDocsForPush();
    const currentSnapshot = this.buildSyncSnapshot();
    const baseline = this.lastPushedSnapshot ?? fallbackBaseline;
    const changedPaths = this.computeChangedPaths(baseline, currentSnapshot);
    const pathsToDelete = listDeletedPaths(this.structureDoc);
    const files = await this.buildFilesMap();
    await withRetry(() =>
      this.provider!.push({
        docs,
        files,
        changedPaths,
        pathsToDelete,
      }),
    );
    this.lastPushedSnapshot = currentSnapshot;
    await this.save();
  }

  private buildMergedDocsForPush(): Map<string, Uint8Array> {
    const docs = new Map<string, Uint8Array>();
    docs.set("structure", Automerge.save(this.structureDoc));

    const referencedDocIds = new Set(
      Object.values(this.structureDoc.files).map((f) => f.docId),
    );
    for (const docId of referencedDocIds) {
      const doc = this.fileDocs.get(docId);
      if (!doc) continue;
      docs.set(docId, Automerge.save(doc));
    }
    return docs;
  }

  private buildSyncSnapshot(): SyncSnapshot {
    const structure = Automerge.getHeads(this.structureDoc);
    const docs: Record<string, string[]> = {};
    const files: Record<string, string> = {};
    for (const [docId, doc] of this.fileDocs) {
      docs[docId] = Automerge.getHeads(doc);
    }
    for (const filePath of listPaths(this.structureDoc)) {
      const entry = getEntry(this.structureDoc, filePath);
      if (!entry) continue;
      const doc = this.fileDocs.get(entry.docId);
      if (!doc) continue;
      files[filePath] =
        doc.type === "binary" ? doc.hash : Automerge.getHeads(doc).join(",");
    }
    return { structure, docs, files };
  }

  private snapshotsEqual(a: SyncSnapshot, b: SyncSnapshot): boolean {
    if (
      a.structure.length !== b.structure.length ||
      a.structure.some((h, i) => h !== b.structure[i])
    ) {
      return false;
    }
    const docIds = new Set([...Object.keys(a.docs), ...Object.keys(b.docs)]);
    for (const docId of docIds) {
      const ah = a.docs[docId];
      const bh = b.docs[docId];
      if (!ah || !bh || ah.length !== bh.length || ah.some((h, i) => h !== bh[i])) {
        return false;
      }
    }
    const paths = new Set([...Object.keys(a.files), ...Object.keys(b.files)]);
    for (const p of paths) {
      if (a.files[p] !== b.files[p]) return false;
    }
    return true;
  }

  private computeChangedPaths(before: SyncSnapshot, after: SyncSnapshot): Set<string> {
    const changed = new Set<string>();
    const beforeHeads = before.structure.join(",");
    const afterHeads = after.structure.join(",");
    if (beforeHeads !== afterHeads) {
      changed.add(".stash/structure.automerge");
    }
    const docIds = new Set([...Object.keys(before.docs), ...Object.keys(after.docs)]);
    for (const docId of docIds) {
      const b = before.docs[docId]?.join(",") ?? "";
      const a = after.docs[docId]?.join(",") ?? "";
      if (b !== a) changed.add(`.stash/docs/${docId}.automerge`);
    }
    const paths = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
    for (const p of paths) {
      if (before.files[p] !== after.files[p]) changed.add(p);
    }
    return changed;
  }

  private async buildFilesMap(): Promise<Map<string, string | Buffer>> {
    const files = new Map<string, string | Buffer>();
    for (const [filePath, entry] of Object.entries(this.structureDoc.files)) {
      if (entry.deleted) continue;
      const doc = this.fileDocs.get(entry.docId);
      if (!doc) continue;
      if (doc.type === "text") {
        files.set(filePath, getContent(doc));
      } else if (doc.type === "binary") {
        const blobPath = path.join(this.path, ".stash", "blobs", `${doc.hash}.bin`);
        try {
          const content = await fs.readFile(blobPath);
          files.set(filePath, content);
        } catch {
          // Blob not found, skip
        }
      }
    }
    return files;
  }

  /**
   * Merge remote docs into local state.
   * Handles the "fresh join" case where local has no shared history with remote.
   */
  private mergeWithRemote(remoteDocs: Map<string, Uint8Array>): void {
    // Check if this is a "fresh join" - local structure has no files
    const localIsEmpty = Object.keys(this.structureDoc.files).length === 0;
    const remoteStructureData = remoteDocs.get("structure");

    if (localIsEmpty && remoteStructureData) {
      // Fresh join: adopt remote state entirely
      this.structureDoc = Automerge.load<StructureDoc>(remoteStructureData);

      // Load all remote file docs and mark paths as known
      const referencedDocIds = new Set(
        Object.values(this.structureDoc.files).map((f) => f.docId),
      );
      this.fileDocs.clear();
      for (const [docId, data] of remoteDocs) {
        if (docId !== "structure" && referencedDocIds.has(docId)) {
          this.fileDocs.set(docId, Automerge.load<FileDoc>(data));
        }
      }

      // Mark all adopted paths as known (so deletions propagate correctly)
      for (const filePath of listPaths(this.structureDoc)) {
        this.knownPaths.add(filePath);
      }
    } else {
      // Normal merge: combine local and remote changes
      // Snapshot local files that have DIFFERENT docIds than remote
      // (these are new files at existing paths that should survive)
      const localNewFiles = new Map<string, { docId: string; content: string }>();
      if (remoteStructureData) {
        const remoteStructure = Automerge.load<StructureDoc>(remoteStructureData);
        for (const [filePath, localEntry] of Object.entries(this.structureDoc.files)) {
          if (localEntry.deleted) continue;
          const remoteEntry = remoteStructure.files[filePath];
          // If local has different docId than remote (or remote is tombstoned), it's a new file
          if (remoteEntry && remoteEntry.docId !== localEntry.docId) {
            const doc = this.fileDocs.get(localEntry.docId);
            if (doc && doc.type === "text") {
              localNewFiles.set(filePath, {
                docId: localEntry.docId,
                content: getContent(doc),
              });
            }
          }
        }
      }

      // Merge structure doc
      if (remoteStructureData) {
        const remoteStructure = Automerge.load<StructureDoc>(remoteStructureData);
        this.structureDoc = Automerge.merge(this.structureDoc, remoteStructure);
      }

      // Restore new files that got clobbered by merge
      for (const [filePath, local] of localNewFiles) {
        const result = addFile(this.structureDoc, filePath, local.docId);
        this.structureDoc = result.doc;
      }

      // Get all referenced doc IDs from merged structure
      const referencedDocIds = new Set(
        Object.values(this.structureDoc.files).map((f) => f.docId),
      );

      // Merge file docs
      for (const docId of referencedDocIds) {
        const localDoc = this.fileDocs.get(docId);
        const remoteData = remoteDocs.get(docId);

        if (localDoc && remoteData) {
          // Both exist - merge
          const remoteDoc = Automerge.load<FileDoc>(remoteData);
          const mergedDoc = Automerge.merge(localDoc, remoteDoc);
          this.fileDocs.set(docId, mergedDoc);
        } else if (localDoc) {
          // Local only - nothing to do
        } else if (remoteData) {
          // Remote only
          this.fileDocs.set(docId, Automerge.load<FileDoc>(remoteData));
        }
      }

      // Clean up unreferenced local docs
      for (const docId of this.fileDocs.keys()) {
        if (!referencedDocIds.has(docId)) {
          this.fileDocs.delete(docId);
        }
      }

      // Mark all non-deleted paths as known (so deletions propagate correctly)
      for (const filePath of listPaths(this.structureDoc)) {
        this.knownPaths.add(filePath);
      }

      // Content wins: if local made changes to a file that remote deleted,
      // clear the tombstone (local content wins)
      this.applyContentWinsRule(remoteDocs);
    }
  }

  /**
   * Apply "content wins" rule: if a file has tombstone from remote but
   * local made content changes, clear the tombstone.
   */
  private applyContentWinsRule(remoteDocs: Map<string, Uint8Array>): void {
    for (const [filePath, entry] of Object.entries(this.structureDoc.files)) {
      if (!entry.deleted) continue;

      // Get local and remote content
      const localDoc = this.fileDocs.get(entry.docId);
      if (!localDoc || localDoc.type !== "text") continue;

      const localContent = getContent(localDoc);

      // Get remote content (if any)
      const remoteData = remoteDocs.get(entry.docId);
      if (!remoteData) {
        // Incremental fetch may omit unchanged blobs. Fall back to local-vs-last-push
        // head comparison so we only resurrect tombstones when local content changed.
        if (!this.lastPushedSnapshot) continue;
        const previousHeads = this.lastPushedSnapshot.docs[entry.docId];
        if (!previousHeads) continue;
        const localHeads = Automerge.getHeads(localDoc);
        const changedLocally =
          previousHeads.length !== localHeads.length ||
          previousHeads.some((h, i) => h !== localHeads[i]);
        if (changedLocally && localContent.length > 0) {
          this.structureDoc = Automerge.change(this.structureDoc, (d) => {
            delete (d.files[filePath] as { deleted?: boolean }).deleted;
          });
        }
        continue;
      }

      let remoteContent = "";
      const remoteDoc = Automerge.load<FileDoc>(remoteData);
      if (remoteDoc.type === "text") {
        remoteContent = getContent(remoteDoc);
      }

      // If local content differs from remote, local made changes - content wins
      if (localContent !== remoteContent && localContent.length > 0) {
        this.structureDoc = Automerge.change(this.structureDoc, (d) => {
          delete (d.files[filePath] as { deleted?: boolean }).deleted;
        });
      }
    }
  }

  // --- Known Paths (local only, not synced) ---
  isKnownPath(filePath: string): boolean {
    return this.knownPaths.has(filePath);
  }

  addKnownPath(filePath: string): void {
    this.knownPaths.add(filePath);
  }

  removeKnownPath(filePath: string): void {
    this.knownPaths.delete(filePath);
  }

  clearKnownPaths(): void {
    this.knownPaths.clear();
  }

  private async loadKnownPaths(): Promise<void> {
    try {
      const data = await fs.readFile(
        path.join(this.path, ".stash", "known-paths.json"),
        "utf-8",
      );
      const parsed = JSON.parse(data);
      this.knownPaths = new Set(parsed.paths || []);
    } catch {
      // File doesn't exist or is corrupted - start fresh
      this.knownPaths = new Set();
    }
  }

  private async saveKnownPaths(): Promise<void> {
    await atomicWrite(
      path.join(this.path, ".stash", "known-paths.json"),
      JSON.stringify({ paths: [...this.knownPaths] }, null, 2) + "\n",
    );
  }

  // --- Persistence ---
  async save(): Promise<void> {
    const stashDir = path.join(this.path, ".stash");
    const docsDir = path.join(stashDir, "docs");
    await fs.mkdir(docsDir, { recursive: true });

    await atomicWrite(
      path.join(stashDir, "meta.json"),
      JSON.stringify(this.meta, null, 2) + "\n",
    );

    await atomicWriteBinary(
      path.join(stashDir, "structure.automerge"),
      Automerge.save(this.structureDoc),
    );

    for (const [docId, doc] of this.fileDocs) {
      await atomicWriteBinary(
        path.join(docsDir, `${docId}.automerge`),
        Automerge.save(doc),
      );
    }

    await this.saveKnownPaths();
    await this.saveSyncState();
  }

  private async saveSyncState(): Promise<void> {
    if (!this.provider) return;

    const providerSyncState = this.provider?.getSyncState?.();
    const persisted: PersistedSyncState = {
      lastHeadSha: providerSyncState?.lastHeadSha ?? null,
      blobShas: providerSyncState?.blobShas ?? {},
      lastPushedSnapshot: this.lastPushedSnapshot,
    };
    await atomicWrite(
      path.join(this.path, ".stash", "sync-state.json"),
      JSON.stringify(persisted, null, 2) + "\n",
    );
  }

  scheduleSync(): void {
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
    }
    this.syncTimeout = setTimeout(() => {
      this.syncTimeout = null;
      this.sync().catch((err) => {
        console.error(
          `Sync failed for ${this.name}:`,
          (err as Error).message,
        );
      });
    }, Stash.SYNC_DEBOUNCE_MS);
  }

  getMeta(): StashMeta {
    return { ...this.meta };
  }

  setMeta(meta: Partial<StashMeta>): void {
    if (meta.description !== undefined) this.meta.description = meta.description;
    if (meta.remote !== undefined) this.meta.remote = meta.remote;
  }

  getProvider(): SyncProvider | null {
    return this.provider;
  }

  setProvider(provider: SyncProvider | null): void {
    this.provider = provider;
  }

  getActorId(): string {
    return this.actorId;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  async flush(): Promise<void> {
    if (this.savePromise) {
      await this.savePromise;
    }
  }

  private scheduleBackgroundSave(): void {
    this.dirty = true;
    this.saveGeneration++;
    const generationAtSchedule = this.saveGeneration;

    const previousSave = this.savePromise ?? Promise.resolve();
    this.savePromise = previousSave.then(() =>
      this.save()
        .then(() => {
          // Clear dirty only if no new writes since we scheduled
          if (this.saveGeneration === generationAtSchedule) {
            this.dirty = false;
          }
        })
        .catch((err) => {
          console.error(
            `Save failed for ${this.name}:`,
            (err as Error).message,
          );
        }),
    );

    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
    }
    this.syncTimeout = setTimeout(() => {
      this.syncTimeout = null;
      this.sync().catch((err) => {
        console.error(
          `Sync failed for ${this.name}:`,
          (err as Error).message,
        );
      });
    }, Stash.SYNC_DEBOUNCE_MS);
  }
}

async function atomicWrite(
  filePath: string,
  content: string,
): Promise<void> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const tmpPath = `${filePath}.${suffix}.tmp`;
  await fs.writeFile(tmpPath, content);
  await fs.rename(tmpPath, filePath);
}

async function atomicWriteBinary(
  filePath: string,
  data: Uint8Array,
): Promise<void> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const tmpPath = `${filePath}.${suffix}.tmp`;
  await fs.writeFile(tmpPath, data);
  await fs.rename(tmpPath, filePath);
}
