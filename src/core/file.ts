import * as Automerge from "@automerge/automerge";
import { splice } from "@automerge/automerge/next";

// Text files: character-level CRDT
export interface TextFileDoc {
  type: "text";
  content: Automerge.Text;
  [key: string]: unknown;
}

// Binary files: metadata only, actual bytes live on disk
export interface BinaryFileDoc {
  type: "binary";
  hash: string; // SHA-256 of content
  size: number; // file size in bytes
  [key: string]: unknown;
}

export type FileDoc = TextFileDoc | BinaryFileDoc;

export function createFileDoc(
  content: string = "",
  actorId?: string,
): Automerge.Doc<TextFileDoc> {
  return Automerge.from<TextFileDoc>(
    { type: "text", content: new Automerge.Text(content) },
    actorId ? { actor: actorId as Automerge.ActorId } : undefined,
  );
}

export function createBinaryFileDoc(
  hash: string,
  size: number,
  actorId?: string,
): Automerge.Doc<BinaryFileDoc> {
  return Automerge.from<BinaryFileDoc>(
    { type: "binary", hash, size },
    actorId ? { actor: actorId as Automerge.ActorId } : undefined,
  );
}

export function getContent(doc: Automerge.Doc<FileDoc>): string {
  if (doc.type !== "text") throw new Error("Cannot read content of binary file");
  return (doc as Automerge.Doc<TextFileDoc>).content.toString();
}

export function setContent(
  doc: Automerge.Doc<FileDoc>,
  content: string,
): Automerge.Doc<TextFileDoc> {
  if (doc.type !== "text") throw new Error("Cannot set content of binary file");
  return Automerge.change(doc as Automerge.Doc<TextFileDoc>, (d) => {
    // Use splice for efficient bulk replacement (avoids N separate operations)
    splice(d, ["content"], 0, d.content.length, content);
  });
}

export function applyPatch(
  doc: Automerge.Doc<FileDoc>,
  start: number,
  end: number,
  text: string,
): Automerge.Doc<TextFileDoc> {
  if (doc.type !== "text") throw new Error("Cannot patch binary file");
  return Automerge.change(doc as Automerge.Doc<TextFileDoc>, (d) => {
    // Use splice for efficient patch (avoids N separate operations)
    splice(d, ["content"], start, end - start, text);
  });
}

export function isTextFileDoc(
  doc: Automerge.Doc<FileDoc>,
): doc is Automerge.Doc<TextFileDoc> {
  return doc.type === "text";
}

export function isBinaryFileDoc(
  doc: Automerge.Doc<FileDoc>,
): doc is Automerge.Doc<BinaryFileDoc> {
  return doc.type === "binary";
}
