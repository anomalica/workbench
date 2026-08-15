import { describe, expect, it } from "vitest";
import { parseWords, serializeWords } from "./transcript-words";

const W = (t: string, i: number) => `{{t:${(i + 1).toFixed(2)}}}${t}`;
const body = (inner: string) => `<!-- speaker: Jesse Michels -->\n${inner}\n`;
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
    p.citedWorks,
  );
};

describe("cited works", () => {
  const CITED = body(
    `${W("He", 0)} {{cites-start: [a1, "book", "The Invisible College", "Jacques Vallee"]}}${W("wrote", 1)} ${W("this", 2)}{{cites-end: a1}} ${W("one", 3)}`,
  );

  it("records what the speaker named, and its extent", () => {
    const p = parseWords(CITED);
    expect(p.citedWorks).toHaveLength(1);
    expect(p.citedWorks[0]).toMatchObject({
      kind: "book",
      title: "The Invisible College",
      creator: "Jacques Vallee",
      fromWord: 1,
      toWord: 2,
    });
  });

  it("keeps the markers out of the spoken words", () => {
    expect(parseWords(CITED).words.map((w) => w.text)).toEqual(["He", "wrote", "this", "one"]);
  });

  it("survives a round-trip, which is what an edit does to it", () => {
    expect(round(CITED)).toContain(
      '{{cites-start: [a1, "book", "The Invisible College", "Jacques Vallee"]}}',
    );
    expect(parseWords(round(CITED)).citedWorks).toEqual(parseWords(CITED).citedWorks);
  });

  it("holds a work with no creator", () => {
    const b = body(
      `{{cites-start: [a2, "book", "Passport to Magonia"]}}${W("that", 0)}{{cites-end: a2}}`,
    );
    const p = parseWords(b);
    expect(p.citedWorks[0].title).toBe("Passport to Magonia");
    expect(p.citedWorks[0].creator).toBeUndefined();
    expect(round(b)).toContain('{{cites-start: [a2, "book", "Passport to Magonia"]}}');
  });

  it("carries the record's hash once the work has been ingested", () => {
    // Acquisition ADDS a hash; it never has to invalidate an assertion, which
    // is the whole reason the marker records the citation and not held-ness.
    const b = body(
      `{{cites-start: [a3, "book", "Dimensions", "Jacques Vallee", "sha256:7bf2c20d"]}}${W("it", 0)}{{cites-end: a3}}`,
    );
    expect(parseWords(b).citedWorks[0].target).toBe("sha256:7bf2c20d");
    expect(round(b)).toContain('"Jacques Vallee", "sha256:7bf2c20d"');
  });

  it("auto-closes a half-deleted pair rather than corrupting the record", () => {
    const b = body(`{{cites-start: [a4, "book", "A Title"]}}${W("one", 0)} ${W("two", 1)}`);
    expect(parseWords(b).citedWorks[0]).toMatchObject({ fromWord: 0, toWord: 1 });
  });

  it("does not confuse a cited work with a span note over the same words", () => {
    const b = body(
      `{{cites-start: [a5, "book", "A Title"]}}{{note-start: [n1, "he holds it up"]}}${W("this", 0)}{{note-end: n1}}{{cites-end: a5}}`,
    );
    const p = parseWords(b);
    expect(p.citedWorks).toHaveLength(1);
    expect(p.spanNotes).toHaveLength(1);
    expect(p.spanNotes[0].text).toBe("he holds it up");
  });
});
