import * as Automerge from "@automerge/automerge";
import { ulid } from "ulid";

export interface FileEntry {
  docId: string;
  created: number;
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
  const id = docId ?? ulid();
  const newDoc = Automerge.change(doc, (d) => {
    d.files[path] = { docId: id, created: Date.now() };
  });
  return { doc: newDoc, docId: id };
}

export function removeFile(
  doc: Automerge.Doc<StructureDoc>,
  path: string,
): Automerge.Doc<StructureDoc> {
  return Automerge.change(doc, (d) => {
    delete d.files[path];
  });
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
  return Object.keys(doc.files);
}
