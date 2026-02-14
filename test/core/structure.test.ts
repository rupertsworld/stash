import { describe, it, expect } from "vitest";
import * as Automerge from "@automerge/automerge";
import {
  createStructureDoc,
  addFile,
  removeFile,
  moveFile,
  getEntry,
  listPaths,
} from "../../src/core/structure.js";

describe("Structure Document", () => {
  it("should create an empty structure doc", () => {
    const doc = createStructureDoc();
    expect(doc.files).toEqual({});
    expect(listPaths(doc)).toEqual([]);
  });

  it("should add a file entry", () => {
    const doc = createStructureDoc();
    const result = addFile(doc, "hello.md");

    expect(result.docId).toBeTruthy();
    expect(result.doc.files["hello.md"]).toBeDefined();
    expect(result.doc.files["hello.md"].docId).toBe(result.docId);
    expect(result.doc.files["hello.md"].created).toBeGreaterThan(0);
  });

  it("should add a file with a custom docId", () => {
    const doc = createStructureDoc();
    const result = addFile(doc, "test.md", "custom-id-123");

    expect(result.docId).toBe("custom-id-123");
    expect(result.doc.files["test.md"].docId).toBe("custom-id-123");
  });

  it("should remove a file entry", () => {
    const doc = createStructureDoc();
    const { doc: doc2 } = addFile(doc, "hello.md");
    const doc3 = removeFile(doc2, "hello.md");

    expect(doc3.files["hello.md"]).toBeUndefined();
    expect(listPaths(doc3)).toEqual([]);
  });

  it("should rename/move preserving docId", () => {
    const doc = createStructureDoc();
    const { doc: doc2, docId } = addFile(doc, "old.md");
    const doc3 = moveFile(doc2, "old.md", "new.md");

    expect(doc3.files["old.md"]).toBeUndefined();
    expect(doc3.files["new.md"]).toBeDefined();
    expect(doc3.files["new.md"].docId).toBe(docId);
  });

  it("should throw when moving non-existent file", () => {
    const doc = createStructureDoc();
    expect(() => moveFile(doc, "nope.md", "new.md")).toThrow("File not found");
  });

  it("should serialize and deserialize", () => {
    const doc = createStructureDoc();
    const { doc: doc2, docId } = addFile(doc, "test.md");

    const binary = Automerge.save(doc2);
    const loaded = Automerge.load<typeof doc2>(binary);

    expect(loaded.files["test.md"].docId).toBe(docId);
  });

  it("should get entry by path", () => {
    const doc = createStructureDoc();
    const { doc: doc2, docId } = addFile(doc, "readme.md");

    const entry = getEntry(doc2, "readme.md");
    expect(entry).toBeDefined();
    expect(entry!.docId).toBe(docId);

    expect(getEntry(doc2, "nonexistent.md")).toBeUndefined();
  });

  it("should list all paths", () => {
    const doc = createStructureDoc();
    const r1 = addFile(doc, "a.md");
    const r2 = addFile(r1.doc, "b.md");
    const r3 = addFile(r2.doc, "dir/c.md");

    const paths = listPaths(r3.doc);
    expect(paths).toContain("a.md");
    expect(paths).toContain("b.md");
    expect(paths).toContain("dir/c.md");
    expect(paths).toHaveLength(3);
  });

  it("should merge concurrent changes from two actors", () => {
    const actor1 = "aa".repeat(32);
    const actor2 = "bb".repeat(32);

    const doc1 = createStructureDoc(actor1);
    const { doc: doc1a } = addFile(doc1, "file-a.md");

    // Fork for actor2
    const binary = Automerge.save(doc1a);
    const doc2 = Automerge.load<typeof doc1a>(binary, {
      actor: actor2 as Automerge.ActorId,
    });

    // Concurrent edits
    const { doc: doc1b } = addFile(doc1a, "from-actor1.md");
    const { doc: doc2b } = addFile(doc2, "from-actor2.md");

    // Merge
    const merged = Automerge.merge(doc1b, doc2b);

    expect(merged.files["file-a.md"]).toBeDefined();
    expect(merged.files["from-actor1.md"]).toBeDefined();
    expect(merged.files["from-actor2.md"]).toBeDefined();
  });
});
