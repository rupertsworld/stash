import * as Automerge from "@automerge/automerge";
import { ulid } from "ulid";

export interface FileEntry {
  docId: string;
  created: number;
  deleted?: boolean;
}

export interface StructureDoc {
  files: { [path: string]: FileEntry };
  [key: string]: unknown;
}

export function createStructureDoc(
  actorId?: string,
): Automerge.Doc<StructureDoc> {
  return Automerge.from<StructureDoc>(
    { files: {} },
    actorId ? { actor: actorId as Automerge.ActorId } : undefined,
  );
}

export function addFile(
  doc: Automerge.Doc<StructureDoc>,
  path: string,
  docId?: string,
): { doc: Automerge.Doc<StructureDoc>; docId: string } {
  // Always create new docId when resurrecting or creating
  const id = docId ?? ulid();
  const newDoc = Automerge.change(doc, (d) => {
    d.files[path] = { docId: id, created: Date.now() };
    // Explicitly unset deleted flag (handles resurrection)
    delete (d.files[path] as { deleted?: boolean }).deleted;
  });
  return { doc: newDoc, docId: id };
}

export function removeFile(
  doc: Automerge.Doc<StructureDoc>,
  path: string,
): Automerge.Doc<StructureDoc> {
  return Automerge.change(doc, (d) => {
    if (d.files[path]) {
      d.files[path].deleted = true;
    }
  });
}

export function isDeleted(
  doc: Automerge.Doc<StructureDoc>,
  path: string,
): boolean {
  const entry = doc.files[path];
  return entry?.deleted === true;
}

export function moveFile(
  doc: Automerge.Doc<StructureDoc>,
  from: string,
  to: string,
): Automerge.Doc<StructureDoc> {
  const entry = doc.files[from];
  if (!entry) throw new Error(`File not found: ${from}`);
  return Automerge.change(doc, (d) => {
    d.files[to] = { docId: entry.docId, created: entry.created };
    delete d.files[from];
  });
}

export function getEntry(
  doc: Automerge.Doc<StructureDoc>,
  path: string,
): FileEntry | undefined {
  return doc.files[path];
}

export function listPaths(doc: Automerge.Doc<StructureDoc>): string[] {
  return Object.entries(doc.files)
    .filter(([_, entry]) => !entry.deleted)
    .map(([path]) => path);
}

export function listAllPathsIncludingDeleted(doc: Automerge.Doc<StructureDoc>): string[] {
  return Object.keys(doc.files);
}

/**
 * Returns paths where the entry has `deleted === true`.
 */
export function listDeletedPaths(doc: Automerge.Doc<StructureDoc>): string[] {
  return Object.entries(doc.files)
    .filter(([_, entry]) => entry.deleted === true)
    .map(([path]) => path);
}
