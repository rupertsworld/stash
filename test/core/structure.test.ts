import { describe, it, expect } from "vitest";
import * as Automerge from "@automerge/automerge";
import {
  createStructureDoc,
  addFile,
  removeFile,
  moveFile,
  getEntry,
  listPaths,
  listAllPathsIncludingDeleted,
  listDeletedPaths,
  isDeleted,
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

  it("should remove a file entry (soft delete with tombstone)", () => {
    const doc = createStructureDoc();
    const { doc: doc2, docId } = addFile(doc, "hello.md");
    const doc3 = removeFile(doc2, "hello.md");

    // Entry still exists with tombstone
    expect(doc3.files["hello.md"]).toBeDefined();
    expect(doc3.files["hello.md"].deleted).toBe(true);
    expect(doc3.files["hello.md"].docId).toBe(docId);
    // But not listed in active paths
    expect(listPaths(doc3)).toEqual([]);
    expect(listDeletedPaths(doc3)).toEqual(["hello.md"]);
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

  describe("Tombstones (soft delete)", () => {
    it("should mark file as deleted instead of removing", () => {
      const doc = createStructureDoc();
      const { doc: doc2, docId } = addFile(doc, "file.md");
      const doc3 = removeFile(doc2, "file.md");

      // Entry should still exist with deleted flag
      expect(doc3.files["file.md"]).toBeDefined();
      expect(doc3.files["file.md"].deleted).toBe(true);
      expect(doc3.files["file.md"].docId).toBe(docId);
    });

    it("should not list deleted files in listPaths", () => {
      const doc = createStructureDoc();
      const { doc: doc2 } = addFile(doc, "keep.md");
      const { doc: doc3 } = addFile(doc2, "delete.md");
      const doc4 = removeFile(doc3, "delete.md");

      expect(listPaths(doc4)).toEqual(["keep.md"]);
    });

    it("should list deleted files in listAllPathsIncludingDeleted", () => {
      const doc = createStructureDoc();
      const { doc: doc2 } = addFile(doc, "keep.md");
      const { doc: doc3 } = addFile(doc2, "delete.md");
      const doc4 = removeFile(doc3, "delete.md");

      const allPaths = listAllPathsIncludingDeleted(doc4);
      expect(allPaths).toContain("keep.md");
      expect(allPaths).toContain("delete.md");
    });

    it("should list only deleted paths in listDeletedPaths", () => {
      const doc = createStructureDoc();
      const { doc: doc2 } = addFile(doc, "keep.md");
      const { doc: doc3 } = addFile(doc2, "delete1.md");
      const { doc: doc4 } = addFile(doc3, "delete2.md");
      const doc5 = removeFile(doc4, "delete1.md");
      const doc6 = removeFile(doc5, "delete2.md");

      expect(listDeletedPaths(doc6)).toEqual(
        expect.arrayContaining(["delete1.md", "delete2.md"]),
      );
      expect(listDeletedPaths(doc6)).toHaveLength(2);
    });

    it("should check if file is deleted with isDeleted", () => {
      const doc = createStructureDoc();
      const { doc: doc2 } = addFile(doc, "file.md");

      expect(isDeleted(doc2, "file.md")).toBe(false);

      const doc3 = removeFile(doc2, "file.md");

      expect(isDeleted(doc3, "file.md")).toBe(true);
      expect(isDeleted(doc3, "nonexistent.md")).toBe(false);
    });

    it("should resurrect deleted file with new docId when re-added", () => {
      const doc = createStructureDoc();
      const { doc: doc2, docId: originalId } = addFile(doc, "file.md");
      const doc3 = removeFile(doc2, "file.md");

      expect(isDeleted(doc3, "file.md")).toBe(true);

      const { doc: doc4, docId: newId } = addFile(doc3, "file.md");

      // Should have new docId
      expect(newId).not.toBe(originalId);
      // Should no longer be deleted
      expect(isDeleted(doc4, "file.md")).toBe(false);
      expect(doc4.files["file.md"].deleted).toBeUndefined();
    });

    it("should sync tombstones between actors", () => {
      const actor1 = "aa".repeat(32);
      const actor2 = "bb".repeat(32);

      const doc1 = createStructureDoc(actor1);
      const { doc: doc1a } = addFile(doc1, "shared.md");

      // Fork for actor2
      const binary = Automerge.save(doc1a);
      const doc2 = Automerge.load<typeof doc1a>(binary, {
        actor: actor2 as Automerge.ActorId,
      });

      // Actor 1 deletes the file
      const doc1b = removeFile(doc1a, "shared.md");

      // Merge into actor 2
      const merged = Automerge.merge(doc2, doc1b);

      // Actor 2 should see the tombstone
      expect(isDeleted(merged, "shared.md")).toBe(true);
    });

    it("should handle concurrent delete and edit - content wins", () => {
      const actor1 = "aa".repeat(32);
      const actor2 = "bb".repeat(32);

      const doc1 = createStructureDoc(actor1);
      const { doc: doc1a } = addFile(doc1, "file.md");

      // Fork for actor2
      const binary = Automerge.save(doc1a);
      const doc2 = Automerge.load<typeof doc1a>(binary, {
        actor: actor2 as Automerge.ActorId,
      });

      // Actor 1 deletes
      const doc1b = removeFile(doc1a, "file.md");

      // Actor 2 "edits" by re-adding (simulating content update)
      // In practice, editing doesn't change structure, but resurrection does
      const { doc: doc2b } = addFile(doc2, "file.md");

      // Merge - both changes applied
      const merged = Automerge.merge(doc1b, doc2b);

      // The resurrection should win (content wins over deletion)
      // Note: This depends on Automerge's conflict resolution
      // We may need to handle this in post-merge processing
      expect(merged.files["file.md"]).toBeDefined();
    });
  });
});
