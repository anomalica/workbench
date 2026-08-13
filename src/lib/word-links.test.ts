import { describe, it, expect } from "vitest";
import { parseWords, serializeWords, splitWord, replaceWordRange } from "./transcript-words";

/**
 * Cross-record links: the third paired-marker type (ingest-format.md, spec
 * 4da321f). `{{link-start: [id, "sha256:...", "quote"?]}}` ... `{{link-end: id}}`
 * rides the same machinery as highlights and span notes: same overlap-by-id and
 * orphan rules, same word-edit remapping, same single overlay id space.
 *
 * The properties pinned here are the durable ones from the spec: target pinned
 * by content_hash (never a symlink name), the optional anchor as a verbatim
 * QUOTE (never an offset), and the link surviving the body edits that move
 * every word.
 */

const HASH = "sha256:" + "a".repeat(64);

/** Round-trip through parse -> serialize, as every document edit does. */
function roundTrip(body: string): string {
  const p = parseWords(body);
  return serializeWords(
    p.words,
    p.runs,
    p.lineEndWords,
    p.preamble,
    p.highlights,
    p.spanNotes,
    p.highlightContexts,
    p.links,
  );
}

const BODY =
  "<!-- speaker: Alice -->\n" +
  `{{link-start: [a1, "${HASH}"]}}{{t:0.00}}the {{t:0.50}}AARO {{t:1.00}}report{{link-end: a1}} {{t:1.50}}said\n`;

describe("cross-record links: parsing", () => {
  it("reads a link span with its target", () => {
    const p = parseWords(BODY);
    expect(p.links).toEqual([{ id: "a1", fromWord: 0, toWord: 2, target: HASH }]);
  });

  it("reads the optional target quote", () => {
    const p = parseWords(
      "<!-- speaker: Alice -->\n" +
        `{{link-start: [a1, "${HASH}", "phenomena remain unexplained"]}}{{t:0.00}}that {{t:0.50}}passage{{link-end: a1}}\n`,
    );
    expect(p.links).toEqual([
      { id: "a1", fromWord: 0, toWord: 1, target: HASH, quote: "phenomena remain unexplained" },
    ]);
  });

  it("a link may cross speaker turns, like any markup span", () => {
    const p = parseWords(
      "<!-- speaker: Alice -->\n" +
        `{{link-start: [a1, "${HASH}"]}}{{t:0.00}}see {{t:0.50}}the\n` +
        "<!-- speaker: Bob -->\n" +
        "{{t:1.00}}document{{link-end: a1}} {{t:1.50}}here\n",
    );
    expect(p.links).toEqual([{ id: "a1", fromWord: 0, toWord: 2, target: HASH }]);
  });

  it("an unclosed link auto-closes at end of body; an orphan end is dropped", () => {
    const open = parseWords(
      `<!-- speaker: Alice -->\n{{link-start: [a1, "${HASH}"]}}{{t:0.00}}one {{t:0.50}}two\n`,
    );
    expect(open.links).toEqual([{ id: "a1", fromWord: 0, toWord: 1, target: HASH }]);
    const orphan = parseWords(
      "<!-- speaker: Alice -->\n{{t:0.00}}one{{link-end: zz}} {{t:0.50}}two\n",
    );
    expect(orphan.links).toEqual([]);
  });

  it("the markers never leak into word text", () => {
    const p = parseWords(BODY);
    expect(p.words.map((w) => w.text)).toEqual(["the", "AARO", "report", "said"]);
  });
});

describe("cross-record links: serialisation", () => {
  it("round-trips byte-identical", () => {
    expect(roundTrip(BODY)).toBe(BODY);
  });

  it("round-trips the quote form byte-identical", () => {
    const b =
      "<!-- speaker: Alice -->\n" +
      `{{link-start: [a1, "${HASH}", "the \\"exact\\" phrase"]}}{{t:0.00}}that {{t:0.50}}passage{{link-end: a1}}\n`;
    expect(roundTrip(b)).toBe(b);
    expect(parseWords(b).links[0].quote).toBe('the "exact" phrase');
  });

  it("emits no quote field when there is none - not an empty string", () => {
    const p = parseWords(BODY);
    const out = serializeWords(p.words, p.runs, p.lineEndWords, p.preamble, [], [], [], p.links);
    expect(out).toContain(`{{link-start: [a1, "${HASH}"]}}`);
    expect(out).not.toContain(`, ""]`);
  });
});

describe("cross-record links: word edits move the span, not the link", () => {
  it("splitting a word inside the span grows it", () => {
    const p = parseWords(BODY);
    const next = splitWord(p, 1, ["A.", "A.", "R.", "O."]);
    expect(next.links).toEqual([{ id: "a1", fromWord: 0, toWord: 5, target: HASH }]);
  });

  it("replacing words after the span leaves it alone", () => {
    const p = parseWords(BODY);
    const next = replaceWordRange(p, 3, 3, [{ text: "stated", start: 1.5 }]);
    expect(next.links).toEqual([{ id: "a1", fromWord: 0, toWord: 2, target: HASH }]);
  });

  it("deleting the whole spanned range drops the link, never mis-anchors it", () => {
    const p = parseWords(BODY);
    const next = replaceWordRange(p, 0, 2, []);
    expect(next.links).toEqual([]);
  });
});

describe("every write path carries links", () => {
  it("no serializeWords call site omits them", async () => {
    // The context-edge version of this guard caught a real bug (5ad1212): a new
    // parse field silently defaults to [] at any call site that predates it,
    // and the first write from that path DELETES every link in the record.
    const src = (await import("./document.svelte.ts?raw")).default as string;
    const calls = src.match(/serializeWords\((?:[^()]|\([^()]*\))*\)/gs) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    const missing = calls.filter((c: string) => !c.includes("links"));
    expect(missing).toEqual([]);
  });

  it("link ids join the single overlay id space at every mint site", async () => {
    // The spec's non-reuse rule quantifies over "any overlay construct (a
    // marker, a context edge, or a link payload)". overlayIdsOf is the one
    // collector feeding mintOverlayId, so it must name links - and both mint
    // paths must go through it rather than an inline list.
    const src = (await import("./document.svelte.ts?raw")).default as string;
    const helper = src.slice(
      src.indexOf("function overlayIdsOf"),
      src.indexOf("function readOverlayNextId"),
    );
    expect(helper).toContain("parsed.links.map((l) => l.id)");
    expect(src.match(/mintOverlayId\(\s*overlayIdsOf\(parsed\)/g)?.length).toBe(3);
  });
});
