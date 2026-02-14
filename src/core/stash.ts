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
  getContent,
  setContent,
  applyPatch,
  type FileDoc,
} from "./file.js";
import type { SyncProvider } from "../providers/types.js";
import { withRetry } from "./errors.js";

export interface StashMeta {
  localName: string;
  provider: string | null;
  key: string | null;
  actorId: string;
}

export class Stash {
  readonly name: string;
  private structureDoc: Automerge.Doc<StructureDoc>;
  private fileDocs: Map<string, Automerge.Doc<FileDoc>>;
  private provider: SyncProvider | null;
  private baseDir: string;
  private meta: StashMeta;
  private dirty = false;
  private savePromise: Promise<void> | null = null;
  private syncTimeout: ReturnType<typeof setTimeout> | null = null;
  private static SYNC_DEBOUNCE_MS = 2000;

  constructor(
    name: string,
    baseDir: string,
    structureDoc: Automerge.Doc<StructureDoc>,
    fileDocs: Map<string, Automerge.Doc<FileDoc>>,
    meta: StashMeta,
    provider: SyncProvider | null = null,
  ) {
    this.name = name;
    this.baseDir = baseDir;
    this.structureDoc = structureDoc;
    this.fileDocs = fileDocs;
    this.meta = meta;
    this.provider = provider;
  }

  static create(
    name: string,
    baseDir: string,
    provider: SyncProvider | null = null,
    providerType: string | null = null,
    key: string | null = null,
  ): Stash {
    const actorId = ulid();
    // Convert ULID to hex for Automerge (pad to 64 hex chars)
    const hexActorId = Buffer.from(actorId).toString("hex").padEnd(64, "0");
    const structureDoc = createStructureDoc(hexActorId);
    const meta: StashMeta = {
      localName: name,
      provider: providerType,
      key,
      actorId,
    };
    return new Stash(
      name,
      baseDir,
      structureDoc,
      new Map(),
      meta,
      provider,
    );
  }

  static async load(
    name: string,
    baseDir: string,
    provider: SyncProvider | null = null,
  ): Promise<Stash> {
    const stashDir = path.join(baseDir, name);

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
        if (!referencedDocIds.has(docId)) continue; // Skip orphans
        const docBin = await fs.readFile(path.join(docsDir, entry));
        fileDocs.set(docId, Automerge.load<FileDoc>(new Uint8Array(docBin)));
      }
    } catch {
      // docs dir might not exist yet
    }

    return new Stash(name, baseDir, structureDoc, fileDocs, meta, provider);
  }

  read(filePath: string): string {
    const entry = getEntry(this.structureDoc, filePath);
    if (!entry) throw new Error(`File not found: ${filePath}`);
    const doc = this.fileDocs.get(entry.docId);
    if (!doc) throw new Error(`File not found: ${filePath}`);
    return getContent(doc);
  }

  write(filePath: string, content: string): void {
    const entry = getEntry(this.structureDoc, filePath);
    if (entry) {
      // Update existing file
      const doc = this.fileDocs.get(entry.docId);
      if (doc) {
        this.fileDocs.set(entry.docId, setContent(doc, content));
      }
    } else {
      // Create new file
      const hexActorId = Buffer.from(this.meta.actorId)
        .toString("hex")
        .padEnd(64, "0");
      const result = addFile(this.structureDoc, filePath);
      this.structureDoc = result.doc;
      this.fileDocs.set(
        result.docId,
        createFileDoc(content, hexActorId),
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
    // Orphan the file doc (remove from memory, leave on disk)
    this.fileDocs.delete(entry.docId);
    this.scheduleBackgroundSave();
  }

  move(from: string, to: string): void {
    const entry = getEntry(this.structureDoc, from);
    if (!entry) throw new Error(`File not found: ${from}`);
    this.structureDoc = moveStructureFile(this.structureDoc, from, to);
    this.scheduleBackgroundSave();
  }

  list(dir?: string): string[] {
    const allPaths = listPaths(this.structureDoc);

    if (!dir || dir === "") {
      // List immediate children of root
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

    // Normalize dir to end with /
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

  async sync(): Promise<void> {
    if (!this.provider) return;

    // 1. Pre-sync: create empty docs for dangling refs
    for (const [filePath, entry] of Object.entries(this.structureDoc.files)) {
      if (!this.fileDocs.has(entry.docId)) {
        console.warn(`Creating empty doc for dangling ref: ${filePath}`);
        const hexActorId = Buffer.from(this.meta.actorId)
          .toString("hex")
          .padEnd(64, "0");
        this.fileDocs.set(entry.docId, createFileDoc("", hexActorId));
      }
    }

    // 2. Gather all local documents
    const localDocs = new Map<string, Uint8Array>();
    localDocs.set("structure", Automerge.save(this.structureDoc));
    for (const [docId, fileDoc] of this.fileDocs) {
      localDocs.set(docId, Automerge.save(fileDoc));
    }

    // 3. Provider syncs with retry
    const mergedDocs = await withRetry(() => this.provider!.sync(localDocs));

    // 4. Load merged structure
    this.structureDoc = Automerge.load<StructureDoc>(
      mergedDocs.get("structure")!,
    );

    // 5. Load only referenced file docs
    const referencedDocIds = new Set(
      Object.values(this.structureDoc.files).map((f) => f.docId),
    );

    this.fileDocs.clear();
    for (const [docId, data] of mergedDocs) {
      if (docId !== "structure" && referencedDocIds.has(docId)) {
        this.fileDocs.set(docId, Automerge.load<FileDoc>(data));
      }
    }

    // 6. Persist
    await this.save();
  }

  async save(): Promise<void> {
    const stashDir = path.join(this.baseDir, this.name);
    const docsDir = path.join(stashDir, "docs");
    await fs.mkdir(docsDir, { recursive: true });

    // Write meta.json
    await atomicWrite(
      path.join(stashDir, "meta.json"),
      JSON.stringify(this.meta, null, 2) + "\n",
    );

    // Write structure doc
    await atomicWriteBinary(
      path.join(stashDir, "structure.automerge"),
      Automerge.save(this.structureDoc),
    );

    // Write file docs
    for (const [docId, doc] of this.fileDocs) {
      await atomicWriteBinary(
        path.join(docsDir, `${docId}.automerge`),
        Automerge.save(doc),
      );
    }
  }

  getMeta(): StashMeta {
    return { ...this.meta };
  }

  getProvider(): SyncProvider | null {
    return this.provider;
  }

  setProvider(provider: SyncProvider | null): void {
    this.provider = provider;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  /**
   * Wait for any pending background saves to complete.
   * Useful for tests.
   */
  async flush(): Promise<void> {
    if (this.savePromise) {
      await this.savePromise;
    }
  }

  private scheduleBackgroundSave(): void {
    this.dirty = true;

    // Chain saves to ensure they complete in order
    const previousSave = this.savePromise ?? Promise.resolve();
    this.savePromise = previousSave.then(() =>
      this.save().catch((err) => {
        console.error(`Save failed for ${this.name}:`, (err as Error).message);
      })
    );

    // Debounce sync
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
          console.error(`Sync failed for ${this.name}:`, (err as Error).message);
        });
    }, Stash.SYNC_DEBOUNCE_MS);
  }
}

async function atomicWrite(
  filePath: string,
  content: string,
): Promise<void> {
  const tmpPath = filePath + ".tmp";
  await fs.writeFile(tmpPath, content);
  await fs.rename(tmpPath, filePath);
}

async function atomicWriteBinary(
  filePath: string,
  data: Uint8Array,
): Promise<void> {
  const tmpPath = filePath + ".tmp";
  await fs.writeFile(tmpPath, data);
  await fs.rename(tmpPath, filePath);
}
