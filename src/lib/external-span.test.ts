import { describe, expect, it } from "vitest";
import { parseWords, serializeWords } from "./transcript-words";

const body = (inner: string) => `<!-- speaker: Jesse Michels -->\n${inner}\n`;
const W = (t: string, i: number) => `{{t:${(i + 1).toFixed(2)}}}${t}`;
const words = (...ws: string[]) => ws.map(W).join(" ");

const round = (b: string) => {
  const p = parseWords(b);
  return serializeWords(
    p.words,
    p.runs,
    p.lineEndWords,
    p.preamble,
    p.highlights,
    p.spanNotes,
    p.highlightContexts,
    p.links,
    p.externals,
  );
};

describe("external passages", () => {
  const SIMPLE = body(
    `${words("Then", "he")} {{external-start: [x1, "Larry King Live, 1996"]}}${words("I", "saw", "it")}{{external-end: x1}} ${words("and", "that")}`,
  );

  it("parses the region, its description and its extent", () => {
    const p = parseWords(SIMPLE);
    expect(p.externals).toHaveLength(1);
    expect(p.externals[0].description).toBe("Larry King Live, 1996");
    expect(p.externals[0].fromWord).toBe(2);
    expect(p.externals[0].toWord).toBe(4);
    expect(p.externals[0].target).toBeUndefined();
  });

  it("keeps the words out of the markers", () => {
    // A marker that leaked into the word stream would be spoken text as far as
    // everything downstream is concerned.
    const p = parseWords(SIMPLE);
    expect(p.words.map((w) => w.text)).toEqual(["Then", "he", "I", "saw", "it", "and", "that"]);
  });

  it("survives a round-trip unchanged", () => {
    // The failure that matters: an edit re-serialises the body, and a marker
    // family the serialiser does not know about is silently deleted.
    expect(round(SIMPLE)).toContain('{{external-start: [x1, "Larry King Live, 1996"]}}');
    expect(round(SIMPLE)).toContain("{{external-end: x1}}");
    expect(parseWords(round(SIMPLE)).externals).toEqual(parseWords(SIMPLE).externals);
  });

  it("carries the source record's hash when there is one", () => {
    // The hash is what lets the assimilator collapse one clip quoted by three
    // records into one piece of evidence rather than three independent ones.
    const b = body(
      `${words("as")} {{external-start: [x2, "Larry King Live, 1996", "sha256:7bf2c20d"]}}${words("I", "saw")}{{external-end: x2}}`,
    );
    const p = parseWords(b);
    expect(p.externals[0].target).toBe("sha256:7bf2c20d");
    expect(round(b)).toContain('"Larry King Live, 1996", "sha256:7bf2c20d"');
  });

  it("holds other markup inside it", () => {
    const b = body(
      `{{external-start: [x3, "A clip"]}}${W("Quoted", 0)} {{highlight-start: h1}}${W("words", 1)}{{highlight-end: h1}}{{external-end: x3}}`,
    );
    const p = parseWords(b);
    expect(p.externals[0]).toMatchObject({ fromWord: 0, toWord: 1 });
    expect(p.highlights[0]).toMatchObject({ fromWord: 1, toWord: 1 });
    expect(parseWords(round(b)).highlights).toEqual(p.highlights);
  });

  it("auto-closes a region whose end marker was deleted", () => {
    // Same orphan rule as highlights: half a pair must never corrupt a record.
    const b = body(`{{external-start: [x4, "A clip"]}}${words("one", "two")}`);
    expect(parseWords(b).externals[0]).toMatchObject({ fromWord: 0, toWord: 1 });
  });

  it("drops an end marker with nothing open", () => {
    const b = body(`${words("one")}{{external-end: x5}}${words("two")}`);
    expect(parseWords(b).externals).toEqual([]);
  });
});
