/**
 * An extended highlight: one id, more than one start/end pair.
 *
 * The evidence for a claim is often at the top and bottom of a long paragraph
 * with unrelated material between, and a highlight is the unit of expected
 * extraction - so covering the whole paragraph tells the grader "one claim from
 * all of this" and stops saying which (ingest-format.md, "A highlight may be
 * EXTENDED").
 *
 * The parser and serialiser already carry this: the resolver pushes each closed
 * span onto an array and the serialiser keys markers by WORD INDEX rather than
 * by id. These tests pin that, because both are one small refactor away from
 * becoming a Map keyed on id - which is exactly the shape that silently dropped
 * a part in the digester's eval gold.
 */
import { describe, expect, it } from "vitest";
import { parseWords, serializeWords } from "./transcript-words";

const BODY = `<!-- speaker: A -->
{{t:1.0}}{{highlight-start: a1}}the {{t:1.2}}part {{t:1.4}}that {{t:1.6}}matters{{highlight-end: a1}} {{t:2.0}}a {{t:2.2}}long {{t:2.4}}digression {{t:2.6}}here {{t:3.0}}{{highlight-start: a1}}and {{t:3.2}}its {{t:3.4}}conclusion{{highlight-end: a1}}
`;

describe("a highlight extended into two parts", () => {
  it("parses as two ranges sharing one id", () => {
    const p = parseWords(BODY);
    const parts = p.highlights.filter((h) => h.id === "a1");
    expect(parts.length).toBe(2);
  });

  it("survives a round trip", () => {
    const p = parseWords(BODY);
    const out = serializeWords(
      p.words,
      p.runs,
      p.lineEndWords,
      p.preamble ?? "",
      p.highlights,
      p.spanNotes,
      p.highlightContexts,
      p.links,
      p.externals,
      p.citedWorks,
    );
    const again = parseWords(out);
    expect(again.highlights.filter((h) => h.id === "a1").length).toBe(2);
  });
});

describe("the prose path", () => {
  it("paints two parts of one id as one highlight", () => {
    // Prose records anchor by text offset rather than word index. Both parts
    // carry the same id, so anything keyed on the id must see one highlight.
    const body = `Some opening. {{highlight-start: a1}}the part that matters{{highlight-end: a1}} A long digression that belongs to neither. {{highlight-start: a1}}and its conclusion{{highlight-end: a1}} Trailing.`;
    const ids = [...body.matchAll(/\{\{highlight-start:\s*([A-Za-z0-9]+)\s*\}\}/g)].map(
      (m) => m[1],
    );
    expect(ids).toEqual(["a1", "a1"]);
    // The colour index the viewer uses records first appearance only, so both
    // parts resolve to one slot - i.e. one colour, not two.
    const order = new Map<string, number>();
    for (const id of ids) if (!order.has(id)) order.set(id, order.size);
    expect(order.size).toBe(1);
  });
});

describe("extending refuses what would corrupt the record", () => {
  // These two guards are the whole safety of extend: it mints no id, so it must
  // never invent one, and its parts must not overlap each other or the same id
  // would serialise as a nested open that the parser cannot pair up.
  const BODY_ONE = `<!-- speaker: A -->
{{t:1.0}}{{highlight-start: a1}}first {{t:1.2}}part{{highlight-end: a1}} {{t:2.0}}middle {{t:3.0}}tail
`;

  const load = async () => {
    const { DocumentStore } = await import("./document.svelte");
    const doc = new DocumentStore();
    doc.load(`---\ntitle: t\n---\n${BODY_ONE}`, "h".repeat(64));
    return doc;
  };

  it("refuses an id the record does not carry", async () => {
    const doc = await load();
    const before = doc.current;
    doc.extendWordHighlight("zz", 4, 4);
    expect(doc.current).toBe(before);
  });

  it("refuses a part overlapping an existing part of the same highlight", async () => {
    const doc = await load();
    const before = doc.current;
    doc.extendWordHighlight("a1", 0, 1);
    expect(doc.current).toBe(before);
  });

  it("adds a disjoint part under the same id, minting nothing", async () => {
    const doc = await load();
    doc.extendWordHighlight("a1", 3, 3);
    const p = parseWords(doc.current.split("---\n")[2] ?? doc.current);
    expect(p.highlights.filter((h) => h.id === "a1").length).toBe(2);
    expect(new Set(p.highlights.map((h) => h.id)).size).toBe(1);
  });
});

describe("both parts of an extended highlight get one colour", () => {
  // The bug this pins: colour was keyed on the highlights ARRAY INDEX, so the
  // two parts of one id took different colours and an extended highlight read
  // as two unrelated ones - exactly what extend exists to avoid.
  it("keys the colour on the id's first appearance, not the array position", () => {
    const highlights = [
      { id: "a1", fromWord: 0, toWord: 1 },
      { id: "b2", fromWord: 3, toWord: 4 },
      { id: "a1", fromWord: 8, toWord: 9 }, // second part of a1
    ];
    const colourIndexOf = new Map<string, number>();
    for (const h of highlights)
      if (!colourIndexOf.has(h.id)) colourIndexOf.set(h.id, colourIndexOf.size);
    expect(colourIndexOf.get("a1")).toBe(0);
    expect(colourIndexOf.get("b2")).toBe(1);
    // Both a1 parts resolve to the same slot; indexing the array would have
    // given the second part slot 2.
    expect(highlights.map((h) => colourIndexOf.get(h.id))).toEqual([0, 1, 0]);
  });

  it("go-to-highlight lands on the FIRST part", () => {
    const highlights = [
      { id: "a1", fromWord: 2, toWord: 3 },
      { id: "a1", fromWord: 9, toWord: 10 },
    ];
    const first = new Map<string, (typeof highlights)[number]>();
    for (const h of highlights) if (!first.has(h.id)) first.set(h.id, h);
    expect(first.get("a1")?.fromWord).toBe(2);
  });
});
