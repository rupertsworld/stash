import { describe, it, expect } from "vitest";
import * as Automerge from "@automerge/automerge";
import {
  createFileDoc,
  getContent,
  setContent,
  applyPatch,
} from "../../src/core/file.js";

describe("File Document", () => {
  it("should create an empty file doc", () => {
    const doc = createFileDoc();
    expect(getContent(doc)).toBe("");
  });

  it("should create a file doc with content", () => {
    const doc = createFileDoc("Hello, world!");
    expect(getContent(doc)).toBe("Hello, world!");
  });

  it("should set content", () => {
    let doc = createFileDoc("old content");
    doc = setContent(doc, "new content");
    expect(getContent(doc)).toBe("new content");
  });

  it("should apply a patch (insert)", () => {
    let doc = createFileDoc("Hello world");
    doc = applyPatch(doc, 5, 5, ",");
    expect(getContent(doc)).toBe("Hello, world");
  });

  it("should apply a patch (replace)", () => {
    let doc = createFileDoc("Hello world");
    doc = applyPatch(doc, 0, 5, "Goodbye");
    expect(getContent(doc)).toBe("Goodbye world");
  });

  it("should apply a patch (delete)", () => {
    let doc = createFileDoc("Hello world");
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

    // Actor 1 edits the beginning
    const doc1a = applyPatch(doc1, 0, 5, "Goodbye");

    // Actor 2 edits the end
    const doc2a = applyPatch(doc2, 6, 11, "universe");

    // Merge
    const merged = Automerge.merge(doc1a, doc2a);
    const content = getContent(merged);
    expect(content).toContain("Goodbye");
    expect(content).toContain("universe");
  });
});
