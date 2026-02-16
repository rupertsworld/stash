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
import type { SyncProvider } from "../providers/types.js";
import { withRetry } from "./errors.js";

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
  private savePromise: Promise<void> | null = null;
  private syncTimeout: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;
  private static SYNC_DEBOUNCE_MS = 2000;

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
    return new Stash(
      name,
      stashPath,
      structureDoc,
      new Map(),
      meta,
      actorId,
      provider,
    );
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

    return new Stash(name, stashPath, structureDoc, fileDocs, meta, actorId, provider);
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
    if (!entry) throw new Error(`File not found: ${filePath}`);
    const doc = this.fileDocs.get(entry.docId);
    if (!doc) throw new Error(`File not found: ${filePath}`);
    return getContent(doc);
  }

  // --- Write operations ---
  write(filePath: string, content: string): void {
    const entry = getEntry(this.structureDoc, filePath);
    if (entry) {
      const doc = this.fileDocs.get(entry.docId);
      if (doc) {
        this.fileDocs.set(entry.docId, setContent(doc, content));
      }
    } else {
      const hexActorId = this.getHexActorId();
      const result = addFile(this.structureDoc, filePath);
      this.structureDoc = result.doc;
      this.fileDocs.set(result.docId, createFileDoc(content, hexActorId));
    }
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
    if (!entry) throw new Error(`File not found: ${filePath}`);
    this.structureDoc = removeFile(this.structureDoc, filePath);
    this.fileDocs.delete(entry.docId);
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
    for (const [filePath, entry] of Object.entries(this.structureDoc.files)) {
      if (!this.fileDocs.has(entry.docId)) {
        console.warn(`Creating empty doc for dangling ref: ${filePath}`);
        const hexActorId = this.getHexActorId();
        this.fileDocs.set(entry.docId, createFileDoc("", hexActorId));
      }
    }

    const localDocs = new Map<string, Uint8Array>();
    localDocs.set("structure", Automerge.save(this.structureDoc));
    for (const [docId, fileDoc] of this.fileDocs) {
      localDocs.set(docId, Automerge.save(fileDoc));
    }

    const mergedDocs = await withRetry(() => this.provider!.sync(localDocs));

    this.structureDoc = Automerge.load<StructureDoc>(
      mergedDocs.get("structure")!,
    );

    const referencedDocIds = new Set(
      Object.values(this.structureDoc.files).map((f) => f.docId),
    );

    this.fileDocs.clear();
    for (const [docId, data] of mergedDocs) {
      if (docId !== "structure" && referencedDocIds.has(docId)) {
        this.fileDocs.set(docId, Automerge.load<FileDoc>(data));
      }
    }

    await this.save();
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

    const previousSave = this.savePromise ?? Promise.resolve();
    this.savePromise = previousSave.then(() =>
      this.save().catch((err) => {
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
      this.sync()
        .then(() => {
          this.dirty = false;
        })
        .catch((err) => {
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
