import { describe, it, expect } from "vitest";
import * as Automerge from "@automerge/automerge";
import {
  createFileDoc,
  createBinaryFileDoc,
  getContent,
  setContent,
  applyPatch,
  isTextFileDoc,
  isBinaryFileDoc,
  type FileDoc,
} from "../../src/core/file.js";

describe("File Document", () => {
  describe("text files", () => {
    it("should create an empty file doc", () => {
      const doc = createFileDoc();
      expect(getContent(doc)).toBe("");
      expect(doc.type).toBe("text");
    });

    it("should create a file doc with content", () => {
      const doc = createFileDoc("Hello, world!");
      expect(getContent(doc)).toBe("Hello, world!");
    });

    it("should set content", () => {
      let doc: Automerge.Doc<FileDoc> = createFileDoc("old content");
      doc = setContent(doc, "new content");
      expect(getContent(doc)).toBe("new content");
    });

    it("should apply a patch (insert)", () => {
      let doc: Automerge.Doc<FileDoc> = createFileDoc("Hello world");
      doc = applyPatch(doc, 5, 5, ",");
      expect(getContent(doc)).toBe("Hello, world");
    });

    it("should apply a patch (replace)", () => {
      let doc: Automerge.Doc<FileDoc> = createFileDoc("Hello world");
      doc = applyPatch(doc, 0, 5, "Goodbye");
      expect(getContent(doc)).toBe("Goodbye world");
    });

    it("should apply a patch (delete)", () => {
      let doc: Automerge.Doc<FileDoc> = createFileDoc("Hello world");
      doc = applyPatch(doc, 5, 11, "");
      expect(getContent(doc)).toBe("Hello");
    });

    it("should serialize and deserialize", () => {
      const doc = createFileDoc("Test content");
      const binary = Automerge.save(doc);
      const loaded = Automerge.load<typeof doc>(binary);
      expect(getContent(loaded)).toBe("Test content");
    });

    it("should merge concurrent edits", () => {
      const actor1 = "aa".repeat(32);
      const actor2 = "bb".repeat(32);

      const doc1 = createFileDoc("Hello world", actor1);

      const binary = Automerge.save(doc1);
      const doc2 = Automerge.load<typeof doc1>(binary, {
        actor: actor2 as Automerge.ActorId,
      });

      const doc1a = applyPatch(doc1, 0, 5, "Goodbye");
      const doc2a = applyPatch(doc2, 6, 11, "universe");

      const merged = Automerge.merge(doc1a, doc2a);
      const content = getContent(merged);
      expect(content).toContain("Goodbye");
      expect(content).toContain("universe");
    });
  });

  describe("binary files", () => {
    it("should create a binary file doc", () => {
      const doc = createBinaryFileDoc("abc123", 1024);
      expect(doc.type).toBe("binary");
      expect(doc.hash).toBe("abc123");
      expect(doc.size).toBe(1024);
    });

    it("should throw when reading content of binary file", () => {
      const doc: Automerge.Doc<FileDoc> = createBinaryFileDoc("abc", 100);
      expect(() => getContent(doc)).toThrow("Cannot read content of binary file");
    });

    it("should throw when setting content of binary file", () => {
      const doc: Automerge.Doc<FileDoc> = createBinaryFileDoc("abc", 100);
      expect(() => setContent(doc, "text")).toThrow("Cannot set content of binary file");
    });

    it("should throw when patching binary file", () => {
      const doc: Automerge.Doc<FileDoc> = createBinaryFileDoc("abc", 100);
      expect(() => applyPatch(doc, 0, 0, "text")).toThrow("Cannot patch binary file");
    });
  });

  describe("type guards", () => {
    it("should identify text file docs", () => {
      const textDoc = createFileDoc("hello");
      expect(isTextFileDoc(textDoc)).toBe(true);
      expect(isBinaryFileDoc(textDoc)).toBe(false);
    });

    it("should identify binary file docs", () => {
      const binaryDoc: Automerge.Doc<FileDoc> = createBinaryFileDoc("hash", 100);
      expect(isBinaryFileDoc(binaryDoc)).toBe(true);
      expect(isTextFileDoc(binaryDoc)).toBe(false);
    });
  });
});
