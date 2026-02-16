import * as Automerge from "@automerge/automerge";
import { splice } from "@automerge/automerge/next";

export interface FileDoc {
  content: Automerge.Text;
  [key: string]: unknown;
}

export function createFileDoc(
  content: string = "",
  actorId?: string,
): Automerge.Doc<FileDoc> {
  return Automerge.from<FileDoc>(
    { content: new Automerge.Text(content) },
    actorId ? { actor: actorId as Automerge.ActorId } : undefined,
  );
}

export function getContent(doc: Automerge.Doc<FileDoc>): string {
  return doc.content.toString();
}

export function setContent(
  doc: Automerge.Doc<FileDoc>,
  content: string,
): Automerge.Doc<FileDoc> {
  return Automerge.change(doc, (d) => {
    splice(d, ["content"], 0, d.content.length, content);
  });
}

export function applyPatch(
  doc: Automerge.Doc<FileDoc>,
  start: number,
  end: number,
  text: string,
): Automerge.Doc<FileDoc> {
  return Automerge.change(doc, (d) => {
    splice(d, ["content"], start, end - start, text);
  });
}
