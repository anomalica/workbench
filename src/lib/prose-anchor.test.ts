import { describe, expect, it } from "vitest";
import {
  indexBody,
  insertHighlight,
  insertSpanNote,
  locateSelection,
  mintId,
  quoteScalar,
} from "./prose-anchor";

const MEMO = `<!-- file_page: 1 -->

HEADQUARTERS, DETACHMENT D
Campbell Air Force Base

**SUBJECT:** Security Inspection

1. Reference is made to secret letter, your headquarters.

<!-- file_page: 2 -->

**SUBJECT:** Security Inspection

3. With the exception of halting the erosion, all deficiencies were cleared.
`;

describe("indexBody", () => {
  it("drops what the reader never saw and keeps a map to the raw offsets", () => {
    const idx = indexBody(MEMO);
    expect(idx.text).not.toContain("<!--");
    expect(idx.text).not.toContain("**");
    expect(idx.text).toContain("SUBJECT: Security Inspection");
    // Every mapped offset points at the character it stands for.
    for (let i = 0; i < idx.text.length; i++) {
      if (idx.text[i] === " ") continue;
      expect(MEMO[idx.map[i]]).toBe(idx.text[i]);
    }
  });

  it("keeps a dropped comment from welding two words together", () => {
    // "...Kentucky<!-- page -->HEADQUARTERS..." must not read as one word, or a
    // selection either side of a page break stops matching.
    const idx = indexBody("a<!-- file_page: 2 -->b");
    expect(idx.text).toBe("a b");
  });

  it("steps over an annotation already anchored here", () => {
    // A second note over words the first one spans has to see prose, not
    // another note's markers.
    const idx = indexBody('the {{note-start: [a1, "x"]}}craft{{note-end: a1}} was silent');
    expect(idx.text).toBe("the craft was silent");
  });
});

describe("locateSelection", () => {
  it("finds a selection that spans markdown syntax the reader cannot see", () => {
    // The reader selected "SUBJECT: Security Inspection"; the body says
    // "**SUBJECT:** Security Inspection".
    const span = locateSelection(MEMO, "SUBJECT: Security Inspection", "Campbell Air Force Base");
    expect(span).not.toBeNull();
    // The span covers the characters the reader saw, so the opening `**` stays
    // outside it: a marker spliced between `**` and the word it emboldens is
    // stripped again before display, but one that swallowed the `**` would
    // change what the record says.
    expect(MEMO.slice(span!.start, span!.end)).toBe("SUBJECT:** Security Inspection");
  });

  it("uses the preceding text to pick between repeated wording", () => {
    // "SUBJECT: Security Inspection" is on both pages. The lead-in decides.
    const first = locateSelection(
      MEMO,
      "Security Inspection",
      "HEADQUARTERS, DETACHMENT D Campbell Air Force Base SUBJECT:",
    );
    const second = locateSelection(MEMO, "Security Inspection", "your headquarters. SUBJECT:");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.start).toBeGreaterThan(first!.start);
  });

  it("refuses rather than guesses when the context cannot tell them apart", () => {
    // Two identical occurrences with identical lead-ins: placing the note is a
    // coin toss, and the wrong offset corrupts the record.
    const body = "the craft was silent. the craft was silent.";
    expect(locateSelection(body, "craft was silent", "the")).toBeNull();
  });

  it("returns null for text that is not in the body", () => {
    expect(locateSelection(MEMO, "Fravor", "")).toBeNull();
    expect(locateSelection(MEMO, "   ", "")).toBeNull();
  });

  it("survives a selection whose whitespace differs from the body's", () => {
    // The rendered text is one line; the body wrapped it across two.
    const body = "HEADQUARTERS, DETACHMENT D\nCampbell Air Force Base";
    const span = locateSelection(body, "DETACHMENT D  Campbell", "");
    expect(span).not.toBeNull();
    expect(body.slice(span!.start, span!.end)).toBe("DETACHMENT D\nCampbell");
  });
});

describe("writing the markers", () => {
  it("wraps the located span in a note pair", () => {
    const span = locateSelection(MEMO, "Campbell Air Force Base", "")!;
    const out = insertSpanNote(MEMO, span, "a1", "handwritten in the margin");
    expect(out).toContain(
      '{{note-start: [a1, "handwritten in the margin"]}}Campbell Air Force Base{{note-end: a1}}',
    );
  });

  it("wraps the located span in a highlight pair", () => {
    const span = locateSelection(MEMO, "Campbell Air Force Base", "")!;
    expect(insertHighlight(MEMO, span, "b2")).toContain(
      "{{highlight-start: b2}}Campbell Air Force Base{{highlight-end: b2}}",
    );
  });

  it("quotes a note so a colon or a brace cannot break the marker scan", () => {
    expect(quoteScalar('see encl. 2: "the map"')).toBe('"see encl. 2: \\"the map\\""');
    expect(quoteScalar("a\nb")).toBe('"a b"');
  });

  it("mints an id no live marker is already using", () => {
    const taken = '{{note-start: [a, "x"]}}y{{note-end: a}}';
    expect(mintId(taken)).not.toBe("a");
    expect(mintId("")).toBe("a");
  });
});
