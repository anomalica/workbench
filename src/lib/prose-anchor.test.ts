import { describe, expect, it } from "vitest";
import {
  expandToWords,
  indexBody,
  rangeText,
  insertHighlight,
  insertSpanNote,
  locateSelection,
  mintId,
  insertStrikethrough,
  isStruck,
  normaliseSelection,
  occurrenceIndex,
  quoteScalar,
  removeStrikethrough,
  spansBlankLine,
  strikeClassification,
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

describe("striking a classification marking", () => {
  // {{classification: X}} asserts a marking IN FORCE; a struck banner says it
  // was removed. Wrapping the annotation would assert both at once, and
  // neither the ingester's quality strip nor the digester's annotation strip
  // keeps the marker - the reviewer would be left with ~~~~ around nothing.
  const body = '{{classification: "SECRET//REL TO USA, FVEY"}} AT 301639ZJUL22, TF CHOSIN TASKED.';

  it("replaces the annotation with struck prose", () => {
    expect(strikeClassification(body, "(SECRET//REL TO USA, FVEY)")).toBe(
      "~~(SECRET//REL TO USA, FVEY)~~ AT 301639ZJUL22, TF CHOSIN TASKED.",
    );
  });

  it("leaves no annotation behind for a stripper to remove", () => {
    const out = strikeClassification(body, "(SECRET//REL TO USA, FVEY)")!;
    expect(out).not.toContain("{{");
    expect(out).not.toContain("~~~~");
  });

  it("declines when the selection is ordinary prose, so the caller wraps it", () => {
    // NOFORN and the like, which the model does strike correctly, and any
    // other text a reviewer wants struck.
    expect(strikeClassification(body, "TF CHOSIN TASKED")).toBeNull();
  });

  it("picks the marking the reviewer is looking at, not the first in the file", () => {
    // Every multi-page classified record repeats its banner.
    const repeated =
      "{{classification: SECRET}} Page one text.\n\n{{classification: SECRET}} Page two text.";
    const out = strikeClassification(repeated, "(SECRET)", "Page one text.")!;
    expect(out).toBe("{{classification: SECRET}} Page one text.\n\n~~(SECRET)~~ Page two text.");
  });

  it("matches however the value was quoted", () => {
    expect(strikeClassification("{{classification: S/RELIDO}} Mission", "(S/RELIDO)")).toBe(
      "~~(S/RELIDO)~~ Mission",
    );
  });

  it("the result is ordinary text, so the strike can be taken off again", () => {
    const struck = strikeClassification(body, "(SECRET//REL TO USA, FVEY)")!;
    const at = locateSelection(struck, "(SECRET//REL TO USA, FVEY)")!;
    expect(isStruck(struck, at)).toBe(true);
    expect(removeStrikethrough(struck, at)).toContain("(SECRET//REL TO USA, FVEY) AT");
  });
});

describe("snapping a selection to whole words", () => {
  function selectChars(text: string, from: number, to: number) {
    document.body.innerHTML = `<p id="p">${text}</p>`;
    const node = document.getElementById("p")!.firstChild!;
    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    return expandToWords(range).toString();
  }

  it("grows a part-word drag out to the words it touched", () => {
    // A drag stops wherever the pointer was: "as been repeatedly proposed to ex".
    const text = "It has been repeatedly proposed to expand the scope for SETI.";
    expect(selectChars(text, 5, 36)).toBe("has been repeatedly proposed to expand");
  });

  it("leaves a selection that already sits on boundaries alone", () => {
    expect(selectChars("It has been proposed.", 3, 11)).toBe("has been");
  });

  it("keeps a hyphenated word together", () => {
    // "forward-looking" is one word to a reader, and splitting it reads as a bug.
    expect(selectChars("The forward-looking infrared camera.", 12, 15)).toBe("forward-looking");
  });

  it("keeps a possessive together", () => {
    expect(selectChars("Fravor's account of it.", 2, 5)).toBe("Fravor's");
  });

  it("does not swallow the punctuation after a word", () => {
    // The stop is not part of the passage being marked.
    expect(selectChars("It has been proposed. Then more.", 12, 19)).toBe("proposed");
  });

  it("handles a selection running to the end of the text", () => {
    expect(selectChars("One two three", 8, 13)).toBe("three");
  });
});

describe("choosing between passages that read alike", () => {
  // A military report repeats its classification banner and its timestamped
  // lines, so the words around a phrase are often identical. Guessing from
  // them declined outright - "these words appear more than once and the
  // surrounding text does not say which" - and a reviewer could not place a
  // note at all. Which occurrence it is was knowable the whole time.
  const body = [
    "## Narrative",
    "",
    "(SECRET//REL TO USA, FVEY) AT 301639ZJUL22, TF CHOSIN TASKED.",
    "",
    "## Gentext",
    "",
    "(SECRET//REL TO USA, FVEY) AT 301822ZJUL22, DEPARTED.",
    "",
    "## Weather",
    "",
    "(SECRET//REL TO USA, FVEY) AT 302028ZJUL22, ARRIVED.",
  ].join("\n");

  it("places the note on the occurrence the reviewer selected", () => {
    const first = locateSelection(body, "FVEY", "", undefined, 0)!;
    const third = locateSelection(body, "FVEY", "", undefined, 2)!;
    expect(body.slice(first.start, first.end)).toBe("FVEY");
    expect(first.start).toBeLessThan(third.start);
    // The third one is the one in the Weather section.
    expect(body.slice(third.end, third.end + 20)).toContain("302028");
  });

  it("counts occurrences over what the reader can see above the selection", () => {
    const rendered = "Narrative (SECRET//REL TO USA, FVEY) AT 1. Gentext (SECRET//REL TO USA, ";
    expect(occurrenceIndex(rendered, "FVEY")).toBe(1);
    expect(occurrenceIndex("", "FVEY")).toBe(0);
  });

  it("without an occurrence, it still declines - which is the bug this fixes", () => {
    // The lead-in is compared backwards from the selection, so all three
    // candidates score identically on "(SECRET//REL TO USA, " and the section
    // heading further back never gets looked at. This is what a reviewer hit:
    // a note they could not place anywhere.
    expect(locateSelection(body, "FVEY", "## Weather")).toBeNull();
    // It only ever worked when the words just before the selection were
    // themselves unique.
    expect(locateSelection(body, "301822ZJUL22", "FVEY AT")).not.toBeNull();
  });

  it("ignores an occurrence that is not there", () => {
    // A stale count must not place the note somewhere arbitrary; it falls
    // through to the lead-in, which declines when it cannot tell.
    expect(locateSelection(body, "FVEY", "", undefined, 99)).toBeNull();
  });
});
