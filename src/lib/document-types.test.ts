import { describe, expect, it } from "vitest";
import { DOCUMENT_TYPES, isDocumentType, recordType } from "./document-types";

describe("what a record is, versus what file arrived", () => {
  it("reports the declared type", () => {
    // The whole point: a book that arrived as a JPEG is a book, and the AATIP
    // briefing slide read as "image" - true of the file, useless about the doc.
    const t = recordType({ document_type: "slide" });
    expect(t.label).toBe("slide");
    expect(t.known).toBe(true);
    expect(t.missing).toBe(false);
  });

  it("never borrows source_type to fill the slot", () => {
    // Putting "video" in the type slot reads as "this record is classified"
    // when nobody has said what it is. How it arrived is a different question
    // and is shown separately.
    const t = recordType({ document_type: undefined });
    expect(t.missing).toBe(true);
    expect(t.label).toBe("");
  });

  it("treats an absent type as ordinary, not a fault", () => {
    // The format emits it only where the artefact states its own form, so
    // about half the corpus is deliberately blank - an invitation, not an error.
    expect(recordType({}).missing).toBe(true);
  });

  it("surfaces a value outside the closed list rather than hiding it", () => {
    const t = recordType({ document_type: "screenplay" });
    expect(t.label).toBe("screenplay");
    expect(t.known).toBe(false);
    expect(t.missing).toBe(false);
  });

  it("ignores whitespace-only values", () => {
    expect(recordType({ document_type: "   " }).missing).toBe(true);
  });

  it("has the sixteen agreed types and no duplicates", () => {
    expect(DOCUMENT_TYPES).toHaveLength(16);
    expect(new Set(DOCUMENT_TYPES).size).toBe(16);
    for (const t of ["book", "slide", "interview", "recording"]) {
      expect(isDocumentType(t)).toBe(true);
    }
    expect(isDocumentType("ebook")).toBe(false); // a source_type, not a document_type
    // The format calls this an open set, so a value outside the list is legal
    // and must be reported rather than replaced.
    expect(recordType({ document_type: "memo" }).label).toBe("memo");
    expect(recordType({ document_type: "memo" }).known).toBe(false);
    expect(isDocumentType(undefined)).toBe(false);
  });
});
