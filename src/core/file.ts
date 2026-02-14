import * as Automerge from "@automerge/automerge";

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
    const len = d.content.length;
    if (len > 0) d.content.deleteAt(0, len);
    if (content.length > 0) d.content.insertAt(0, ...content.split(""));
  });
}

export function applyPatch(
  doc: Automerge.Doc<FileDoc>,
  start: number,
  end: number,
  text: string,
): Automerge.Doc<FileDoc> {
  return Automerge.change(doc, (d) => {
    const deleteCount = end - start;
    if (deleteCount > 0) d.content.deleteAt(start, deleteCount);
    if (text.length > 0) d.content.insertAt(start, ...text.split(""));
  });
}
