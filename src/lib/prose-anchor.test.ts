import { describe, expect, it } from "vitest";
import {
  indexBody,
  rangeText,
  insertHighlight,
  insertSpanNote,
  locateSelection,
  mintId,
  insertStrikethrough,
  isStruck,
  normaliseSelection,
  quoteScalar,
  removeStrikethrough,
  spansBlankLine,
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

describe("equations", () => {
  const body = "The radius is \\( r = R\\sqrt{\\beta} \\) in the paper, as stated.";

  it("drops an equation from the index, like any other marker", () => {
    // It renders as glyphs bearing no relation to its source, so leaving it in
    // would make every selection around it unmatchable.
    expect(indexBody(body).text).toBe("The radius is in the paper, as stated.");
  });

  it("anchors a selection that spans an equation", () => {
    // The reviewer selected the whole sentence; what they can see of the maths
    // is not its source, so the anchor matches the prose either side and the
    // equation falls inside the span.
    const at = locateSelection(body, "The radius is in the paper, as stated.");
    expect(at).not.toBeNull();
    expect(body.slice(at!.start, at!.end)).toBe(body);
  });

  it("never places a marker inside the LaTeX", () => {
    // The splice offsets come from the index, and the index has no offset
    // pointing into an equation - so a note cannot corrupt one.
    const at = locateSelection(body, "The radius is in the paper, as stated.")!;
    const noted = insertSpanNote(body, at, "n1", "check the radical");
    expect(noted).toContain("r = R\\sqrt{\\beta}");
    expect(noted.indexOf("{{note-start")).toBeLessThan(noted.indexOf("\\("));
    expect(noted.indexOf("{{note-end")).toBeGreaterThan(noted.indexOf("\\)"));
  });

  it("handles a display equation the same way", () => {
    const withBlock = "Result follows.\n\n\\[ F_{sky} \\Omega \\]\n\nAnd then more prose.";
    expect(indexBody(withBlock).text).toBe("Result follows. And then more prose.");
  });

  it("leaves an unclosed delimiter as ordinary text", () => {
    // A stray "\\(" is a typo, not an equation. Skipping to the end of the body
    // would silently swallow the rest of the record.
    expect(indexBody("A stray \\( bracket here.").text).toBe("A stray \\( bracket here.");
  });
});

describe("rangeText", () => {
  /** What the reader's selection actually contains once KaTeX has drawn the
   *  equation into it. */
  function selectAll(html: string): string {
    document.body.innerHTML = `<div id="host">${html}</div>`;
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("host")!);
    return rangeText(range);
  }

  it("leaves a rendered equation out of the selected text", () => {
    // Without this, the selection carries KaTeX's glyphs and indexBody carries
    // none, so the two can never agree and the reviewer is told the passage
    // cannot be placed.
    const text = selectAll(
      'The radius is <span class="wb-math" data-tex="r = R\\sqrt{\\beta}">' +
        '<span class="katex"><span class="katex-html">r=R√β</span></span></span> in the paper.',
    );
    expect(normaliseSelection(text)).toBe("The radius is in the paper.");
  });

  it("agrees with indexBody on the same passage", () => {
    // These two are a pair: the anchor works only while both drop equations.
    const body = "The radius is \\( r = R\\sqrt{\\beta} \\) in the paper.";
    const selected = selectAll(
      'The radius is <span class="wb-math" data-tex="r = R\\sqrt{\\beta}">' +
        '<span class="katex"><span class="katex-html">r=R√β</span></span></span> in the paper.',
    );
    expect(locateSelection(body, selected)).not.toBeNull();
  });

  it("keeps ordinary prose intact", () => {
    expect(normaliseSelection(selectAll("<p>Plain <em>prose</em> only.</p>"))).toBe(
      "Plain prose only.",
    );
  });
});

describe("striking text the source struck", () => {
  // The extraction model strikes NOFORN and misses SECRET on adjacent,
  // identically-shaped lines - it recognises a classification marking and tags
  // it instead. The words survive either way; this is a reviewer putting the
  // line back through them.
  const body = "Classification: SECRET\n\nAssociated Caveats: NOFORN";

  it("wraps the selected words and nothing else", () => {
    const at = locateSelection(body, "SECRET")!;
    expect(insertStrikethrough(body, at)).toBe(
      "Classification: ~~SECRET~~\n\nAssociated Caveats: NOFORN",
    );
  });

  it("recognises what it already struck, so the action reverses", () => {
    const struck = "Classification: ~~SECRET~~";
    const at = locateSelection(struck, "SECRET")!;
    expect(isStruck(struck, at)).toBe(true);
    expect(removeStrikethrough(struck, at)).toBe("Classification: SECRET");
    expect(isStruck(body, locateSelection(body, "SECRET")!)).toBe(false);
  });

  it("refuses to cross a paragraph break", () => {
    // `~~` does not span a blank line, so the pair would render as tildes.
    const at = locateSelection(body, "SECRET Associated Caveats: NOFORN")!;
    expect(spansBlankLine(body, at)).toBe(true);
    expect(spansBlankLine(body, locateSelection(body, "SECRET")!)).toBe(false);
  });

  it("round-trips through the renderer as a strike", () => {
    const at = locateSelection(body, "SECRET")!;
    expect(insertStrikethrough(body, at)).toContain("~~SECRET~~");
  });
});
