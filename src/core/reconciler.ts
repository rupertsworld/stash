import * as Automerge from "@automerge/automerge";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import * as crypto from "node:crypto";
import chokidar from "chokidar";
import diff from "fast-diff";
import type { Stash } from "./stash.js";
import type { FileDoc, TextFileDoc } from "./file.js";

interface Patch {
  type: "insert" | "delete";
  index: number;
  text?: string; // for insert
  count?: number; // for delete
}

interface DiskSnapshot {
  doc: Automerge.Doc<FileDoc>;
  content: string;
}

interface PendingDelete {
  path: string;
  docId: string;
  contentHash: string;
  timer: ReturnType<typeof setTimeout>;
}

export class StashReconciler {
  private fsWatcher: chokidar.FSWatcher | null = null;
  private stash: Stash;
  private writing = false;
  private diskSnapshots: Map<string, DiskSnapshot> = new Map();
  private pendingDeletes: Map<string, PendingDelete> = new Map();

  constructor(stash: Stash) {
    this.stash = stash;
  }

  async start(): Promise<void> {
    await this.initializeSnapshots();

    this.fsWatcher = chokidar.watch(this.stash.path, {
      ignored: [/\.stash[/\\]/, /[/\\]\./],
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 50,
      },
    });

    this.fsWatcher.on("add", (filePath) => this.onFileCreated(filePath));
    this.fsWatcher.on("change", (filePath) => this.onFileModified(filePath));
    this.fsWatcher.on("unlink", (filePath) => this.onFileDeleted(filePath));

    await new Promise<void>((resolve) => {
      this.fsWatcher!.on("ready", resolve);
    });
  }

  async close(): Promise<void> {
    if (this.fsWatcher) {
      await this.fsWatcher.close();
      this.fsWatcher = null;
    }
    // Clear pending delete timers
    for (const pending of this.pendingDeletes.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingDeletes.clear();
    this.diskSnapshots.clear();
  }

  async flush(): Promise<void> {
    this.writing = true;

    try {
      const files = this.stash.listAllFiles();

      for (const [filePath, docId] of files) {
        const doc = this.stash.getFileDoc(docId);
        if (!doc) continue;

        const diskPath = nodePath.join(this.stash.path, filePath);
        await fs.mkdir(nodePath.dirname(diskPath), { recursive: true });

        if (doc.type === "text") {
          const automergeContent = (doc as Automerge.Doc<TextFileDoc>).content.toString();

          let diskContent: string | null = null;
          try {
            diskContent = await fs.readFile(diskPath, "utf-8");
          } catch {
            // File doesn't exist on disk
          }

          if (diskContent !== automergeContent) {
            await fs.writeFile(diskPath, automergeContent);
          }

          this.diskSnapshots.set(filePath, {
            doc: Automerge.clone(doc),
            content: automergeContent,
          });
        } else if (doc.type === "binary") {
          const binaryDoc = doc as { type: "binary"; hash: string; size: number };
          const blobPath = nodePath.join(
            this.stash.path,
            ".stash",
            "blobs",
            `${binaryDoc.hash}.bin`,
          );
          const currentHash = await this.hashFile(diskPath).catch(() => null);
          if (currentHash !== binaryDoc.hash) {
            try {
              await fs.copyFile(blobPath, diskPath);
            } catch {
              // blob might not exist yet
            }
          }
        }
      }

      // Handle deletions: files on disk not in automerge
      await this.cleanupOrphanedFiles();
    } finally {
      this.writing = false;
    }

    // Re-check for changes made during write window
    await this.reconcile();
  }

  private async initializeSnapshots(): Promise<void> {
    for (const [relativePath, docId] of this.stash.listAllFiles()) {
      const doc = this.stash.getFileDoc(docId);
      if (doc && doc.type === "text") {
        const textDoc = doc as Automerge.Doc<TextFileDoc>;
        this.diskSnapshots.set(relativePath, {
          doc: Automerge.clone(doc),
          content: textDoc.content.toString(),
        });
      }
    }
  }

  private getRelativePath(filePath: string): string {
    return nodePath.relative(this.stash.path, filePath).split(nodePath.sep).join("/");
  }

  private async onFileModified(filePath: string): Promise<void> {
    if (this.writing) return;

    const relativePath = this.getRelativePath(filePath);
    if (relativePath.startsWith(".stash/")) return;

    let content: Buffer;
    try {
      content = await fs.readFile(filePath);
    } catch {
      return; // File might have been deleted
    }

    const isText = this.isUtf8(content);
    const currentDoc = this.stash.getFileDocByPath(relativePath);

    // Check for type change
    if (currentDoc && currentDoc.type === "text" && !isText) {
      // Text → Binary
      this.diskSnapshots.delete(relativePath);
      const hash = this.hashBuffer(content);
      const size = content.length;
      await this.storeBinaryBlob(hash, content);
      this.stash.writeBinary(relativePath, hash, size);
      await this.stash.save();
      this.stash.scheduleSync();
      return;
    }

    if (currentDoc && currentDoc.type === "binary" && isText) {
      // Binary → Text
      const textContent = content.toString("utf-8");
      this.stash.write(relativePath, textContent);
      const newDoc = this.stash.getFileDocByPath(relativePath);
      if (newDoc) {
        this.diskSnapshots.set(relativePath, {
          doc: Automerge.clone(newDoc),
          content: textContent,
        });
      }
      await this.stash.save();
      this.stash.scheduleSync();
      return;
    }

    if (!isText) {
      // Binary file modified
      const hash = this.hashBuffer(content);
      const size = content.length;
      await this.storeBinaryBlob(hash, content);
      this.stash.writeBinary(relativePath, hash, size);
      await this.stash.save();
      this.stash.scheduleSync();
      return;
    }

    const diskContent = content.toString("utf-8");
    const snapshot = this.diskSnapshots.get(relativePath);
    if (!snapshot) {
      return this.onFileCreated(filePath);
    }

    if (diskContent === snapshot.content) return;

    // Fork from snapshot
    const userDoc = Automerge.clone(snapshot.doc) as Automerge.Doc<TextFileDoc>;

    // Compute user's changes relative to snapshot
    const patches = this.computeDiff(snapshot.content, diskContent);
    const patchedDoc = this.applyPatchesToDoc(userDoc, patches);

    // Merge user's branch with current automerge
    const currentDocForMerge = this.stash.getFileDocByPath(relativePath);
    if (currentDocForMerge && currentDocForMerge.type === "text") {
      const mergedDoc = Automerge.merge(
        Automerge.clone(currentDocForMerge) as Automerge.Doc<TextFileDoc>,
        patchedDoc,
      );

      this.stash.setFileDoc(relativePath, mergedDoc);

      const mergedContent = mergedDoc.content.toString();
      this.writing = true;
      try {
        await fs.writeFile(filePath, mergedContent);
      } finally {
        this.writing = false;
      }

      this.diskSnapshots.set(relativePath, {
        doc: Automerge.clone(mergedDoc),
        content: mergedContent,
      });
    } else {
      // No current doc, just use the patched one
      this.stash.write(relativePath, diskContent);
      const newDoc = this.stash.getFileDocByPath(relativePath);
      if (newDoc) {
        this.diskSnapshots.set(relativePath, {
          doc: Automerge.clone(newDoc),
          content: diskContent,
        });
      }
    }

    await this.stash.save();
    this.stash.scheduleSync();
  }

  private async onFileCreated(filePath: string): Promise<void> {
    if (this.writing) return;

    const relativePath = this.getRelativePath(filePath);
    if (relativePath.startsWith(".stash/")) return;

    let content: Buffer;
    try {
      content = await fs.readFile(filePath);
    } catch {
      return;
    }

    const isText = this.isUtf8(content);
    const contentHash = isText
      ? this.hashContent(content.toString("utf-8"))
      : this.hashBuffer(content);

    // Check if this matches a pending delete (rename detection)
    const pending = this.pendingDeletes.get(contentHash);
    const sameBasename =
      pending &&
      nodePath.basename(pending.path) === nodePath.basename(relativePath);

    if (pending && sameBasename) {
      clearTimeout(pending.timer);
      this.pendingDeletes.delete(contentHash);

      this.stash.renameFile(pending.path, relativePath);

      const snapshot = this.diskSnapshots.get(pending.path);
      if (snapshot) {
        this.diskSnapshots.delete(pending.path);
        this.diskSnapshots.set(relativePath, snapshot);
      }

      await this.stash.save();
      this.stash.scheduleSync();
      return;
    }

    // Not a rename, create new file
    if (isText) {
      const textContent = content.toString("utf-8");
      this.stash.write(relativePath, textContent);

      const doc = this.stash.getFileDocByPath(relativePath);
      if (doc) {
        this.diskSnapshots.set(relativePath, {
          doc: Automerge.clone(doc),
          content: textContent,
        });
      }
    } else {
      const hash = this.hashBuffer(content);
      const size = content.length;
      await this.storeBinaryBlob(hash, content);
      this.stash.writeBinary(relativePath, hash, size);
    }

    await this.stash.save();
    this.stash.scheduleSync();
  }

  private async onFileDeleted(filePath: string): Promise<void> {
    if (this.writing) return;

    const relativePath = this.getRelativePath(filePath);
    if (relativePath.startsWith(".stash/")) return;

    const docId = this.stash.getDocId(relativePath);
    if (!docId) return;

    const fileDoc = this.stash.getFileDoc(docId);
    if (!fileDoc) return;

    let contentHash: string;
    if (fileDoc.type === "binary") {
      contentHash = (fileDoc as { type: "binary"; hash: string }).hash;
    } else {
      try {
        contentHash = this.hashContent(this.stash.read(relativePath));
      } catch {
        contentHash = "";
      }
    }

    // Buffer the delete for 500ms to detect renames
    const timer = setTimeout(() => {
      this.finalizeDelete(relativePath, docId, fileDoc);
      this.pendingDeletes.delete(contentHash);
    }, 500);

    this.pendingDeletes.set(contentHash, {
      path: relativePath,
      docId,
      contentHash,
      timer,
    });
  }

  private async finalizeDelete(
    relativePath: string,
    docId: string,
    fileDoc: Automerge.Doc<FileDoc>,
  ): Promise<void> {
    try {
      this.stash.delete(relativePath);
    } catch {
      return; // Already deleted
    }

    // GC binary blobs immediately if unreferenced
    if (fileDoc.type === "binary") {
      const binaryDoc = fileDoc as { type: "binary"; hash: string };
      const stillReferenced = this.stash.isHashReferenced(binaryDoc.hash);
      if (!stillReferenced) {
        const blobPath = nodePath.join(
          this.stash.path,
          ".stash",
          "blobs",
          `${binaryDoc.hash}.bin`,
        );
        try {
          await fs.unlink(blobPath);
        } catch {
          // Already cleaned up
        }
      }
    }

    // Clean up snapshot
    this.diskSnapshots.delete(relativePath);

    await this.stash.save();
    this.stash.scheduleSync();
  }

  // --- Diffing ---
  private computeDiff(oldText: string, newText: string): Patch[] {
    const changes = diff(oldText, newText);
    const patches: Patch[] = [];
    let oldIndex = 0;

    for (const [op, text] of changes) {
      if (op === diff.EQUAL) {
        oldIndex += text.length;
      } else if (op === diff.DELETE) {
        patches.push({ type: "delete", index: oldIndex, count: text.length });
        oldIndex += text.length; // Consumed from old text
      } else if (op === diff.INSERT) {
        patches.push({ type: "insert", index: oldIndex, text });
        // Don't advance oldIndex - nothing consumed from old text
      }
    }

    return patches;
  }

  private applyPatchesToDoc(
    doc: Automerge.Doc<TextFileDoc>,
    patches: Patch[],
  ): Automerge.Doc<TextFileDoc> {
    return Automerge.change(doc, (d) => {
      let offset = 0;

      for (const patch of patches) {
        const adjustedIndex = patch.index + offset;

        if (patch.type === "delete" && patch.count) {
          d.content.deleteAt(adjustedIndex, patch.count);
          offset -= patch.count;
        } else if (patch.type === "insert" && patch.text) {
          d.content.insertAt(adjustedIndex, ...patch.text.split(""));
          offset += patch.text.length;
        }
      }
    });
  }

  // --- Binary helpers ---
  private isUtf8(buffer: Buffer): boolean {
    try {
      const text = buffer.toString("utf-8");
      return !text.includes("\uFFFD");
    } catch {
      return false;
    }
  }

  private hashBuffer(buffer: Buffer): string {
    return crypto.createHash("sha256").update(buffer).digest("hex");
  }

  private hashContent(content: string): string {
    return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
  }

  private async hashFile(filePath: string): Promise<string> {
    const content = await fs.readFile(filePath);
    return this.hashBuffer(content);
  }

  private async storeBinaryBlob(hash: string, content: Buffer): Promise<void> {
    const blobDir = nodePath.join(this.stash.path, ".stash", "blobs");
    await fs.mkdir(blobDir, { recursive: true });
    const blobPath = nodePath.join(blobDir, `${hash}.bin`);
    await fs.writeFile(blobPath, content);
  }

  // --- Cleanup ---
  private async cleanupOrphanedFiles(): Promise<void> {
    const trackedPaths = new Set(
      this.stash.listAllFiles().map(([p]) => p),
    );

    try {
      await this.walkAndClean(this.stash.path, "", trackedPaths);
    } catch {
      // Root dir might not exist
    }
  }

  private async walkAndClean(
    rootDir: string,
    relativePath: string,
    trackedPaths: Set<string>,
  ): Promise<void> {
    const fullPath = relativePath
      ? nodePath.join(rootDir, relativePath)
      : rootDir;

    const entries = await fs.readdir(fullPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === ".stash") continue;
      if (entry.name.startsWith(".")) continue;

      const childRelative = relativePath
        ? `${relativePath}/${entry.name}`
        : entry.name;

      if (entry.isDirectory()) {
        await this.walkAndClean(rootDir, childRelative, trackedPaths);
      } else if (entry.isFile()) {
        if (!trackedPaths.has(childRelative)) {
          await fs.unlink(nodePath.join(fullPath, entry.name));
        }
      }
    }
  }

  private async reconcile(): Promise<void> {
    // Scan disk for any changes that happened during the write window
    try {
      const trackedPaths = new Set(
        this.stash.listAllFiles().map(([p]) => p),
      );

      for (const filePath of trackedPaths) {
        const diskPath = nodePath.join(this.stash.path, filePath);
        try {
          const diskContent = await fs.readFile(diskPath, "utf-8");
          const snapshot = this.diskSnapshots.get(filePath);
          if (snapshot && diskContent !== snapshot.content) {
            // File was modified during write window
            await this.onFileModified(diskPath);
          }
        } catch {
          // File might not exist
        }
      }
    } catch {
      // Ignore errors during reconcile
    }
  }
}
