import { describe, it, expect } from "vitest";
import {
  parseWords,
  serializeWords,
  splitWord,
  replaceWordRange,
  type ParsedWords,
} from "./transcript-words";

const body = (...lines: string[]) => lines.join("\n");
const SP = "<!-- speaker: A -->";

/** The words each span note covers, mapped to its text, from a parse. */
function noted(parsed: ParsedWords): Record<string, { words: string; text: string }> {
  const out: Record<string, { words: string; text: string }> = {};
  for (const n of parsed.spanNotes) {
    out[n.id] = {
      words: parsed.words
        .slice(n.fromWord, n.toWord + 1)
        .map((w) => w.text)
        .join(" "),
      text: n.text,
    };
  }
  return out;
}

const ser = (p: ParsedWords) =>
  serializeWords(p.words, p.runs, p.lineEndWords, p.preamble, p.highlights, p.spanNotes);

describe("parseWords - span-note markers", () => {
  it("parses a span note over a word range, strips its markers, keeps the text", () => {
    const p = parseWords(
      body(
        SP,
        '{{t:1.00}}the {{note-start: [a, "on screen: a chart"]}}{{t:1.50}}quick brown{{note-end: a}} {{t:2.50}}fox',
      ),
    );
    expect(p.words.map((w) => w.text)).toEqual(["the", "quick brown", "fox"]);
    expect(p.words.some((w) => w.text.includes("note"))).toBe(false);
    expect(noted(p)).toEqual({ a: { words: "quick brown", text: "on screen: a chart" } });
  });

  it("keeps two overlapping span notes distinct", () => {
    // a covers words 0..1, b covers words 1..2 -> they share word 1.
    const p = parseWords(
      body(
        SP,
        '{{note-start: [a, "first"]}}{{t:1}}big {{note-start: [b, "second"]}}{{t:2}}red{{note-end: a}} {{t:3}}car{{note-end: b}}',
      ),
    );
    expect(noted(p)).toEqual({
      a: { words: "big red", text: "first" },
      b: { words: "red car", text: "second" },
    });
  });

  it("auto-closes an unclosed span note at a speaker change", () => {
    const p = parseWords(
      body(
        SP,
        '{{note-start: [a, "ctx"]}}{{t:1}}one {{t:2}}two',
        "<!-- speaker: B -->",
        "{{t:3}}three",
      ),
    );
    expect(noted(p)).toEqual({ a: { words: "one two", text: "ctx" } });
  });

  it("drops a note-end with no matching open", () => {
    const p = parseWords(body(SP, "{{t:1}}a{{note-end: ghost}} {{t:2}}b"));
    expect(p.spanNotes).toEqual([]);
    expect(p.words.map((w) => w.text)).toEqual(["a", "b"]);
  });

  it("carries a span note across a line break within a turn", () => {
    const p = parseWords(
      body(SP, '{{note-start: [a, "ctx"]}}{{t:1}}one {{t:2}}two', "{{t:3}}three{{note-end: a}}"),
    );
    expect(noted(p)).toEqual({ a: { words: "one two three", text: "ctx" } });
  });

  it("does not treat note markers as words or event notes", () => {
    const p = parseWords(body(SP, '{{note-start: [a, "ctx"]}}{{t:1}}word{{note-end: a}}'));
    expect(p.words).toHaveLength(1);
    expect(p.words[0].notes).toBeUndefined();
    expect(p.words[0].text).toBe("word");
  });

  it("coexists with a highlight and an event note on the noted word", () => {
    const p = parseWords(
      body(
        SP,
        '{{highlight-start: h}}{{note-start: [a, "ctx"]}}{{t:1}}word {{laughs}}{{note-end: a}}{{highlight-end: h}}',
      ),
    );
    expect(p.words[0].text).toBe("word");
    expect(p.words[0].notes).toEqual(["laughs"]);
    expect(noted(p)).toEqual({ a: { words: "word", text: "ctx" } });
    expect(p.highlights.map((h) => h.id)).toEqual(["h"]);
  });

  it("preserves colons and escaped quotes in the note text", () => {
    const p = parseWords(
      body(SP, '{{note-start: [a, "shows: \\"Area 52\\" logo"]}}{{t:1}}word{{note-end: a}}'),
    );
    expect(p.spanNotes[0].text).toBe('shows: "Area 52" logo');
  });
});

describe("serializeWords - span-note markers", () => {
  it("round-trips a span-noted body byte-for-byte", () => {
    const src = body(
      SP,
      '{{t:1.00}}the {{note-start: [a, "on screen"]}}{{t:1.50}}quick brown{{note-end: a}} {{t:2.50}}fox',
    );
    expect(ser(parseWords(src))).toBe(`${src}\n`);
  });

  it("round-trips text containing a colon and quotes", () => {
    const src = body(SP, '{{note-start: [a, "shows: \\"logo\\""]}}{{t:1.00}}word{{note-end: a}}');
    const round = parseWords(ser(parseWords(src)));
    expect(round.spanNotes[0].text).toBe('shows: "logo"');
  });

  it("emits nothing extra when there are no span notes", () => {
    const src = body(SP, "{{t:1.00}}plain {{t:2.00}}words");
    expect(ser(parseWords(src))).toBe(`${src}\n`);
    expect(
      serializeWords(parseWords(src).words, parseWords(src).runs, parseWords(src).lineEndWords, ""),
    ).not.toContain("note-");
  });
});

describe("span notes survive word edits", () => {
  const src = body(
    SP,
    '{{note-start: [a, "ctx"]}}{{t:1.00}}alpha {{t:2.00}}beta {{t:3.00}}gamma{{note-end: a}} {{t:4.00}}delta',
  );

  it("a span note follows its words when a later word is split", () => {
    const next = splitWord(parseWords(src), 3, ["del", "ta"]);
    expect(noted(next)).toEqual({ a: { words: "alpha beta gamma", text: "ctx" } });
  });

  it("a span note grows and keeps its text when a word inside it is split", () => {
    const next = splitWord(parseWords(src), 1, ["be", "ta"]);
    expect(next.words.map((w) => w.text)).toEqual(["alpha", "be", "ta", "gamma", "delta"]);
    expect(noted(next)).toEqual({ a: { words: "alpha be ta gamma", text: "ctx" } });
  });

  it("a span note clamps and keeps its text when its own words are replaced", () => {
    const next = replaceWordRange(parseWords(src), 0, 2, [
      { text: "one", start: 1.0 },
      { text: "two", start: 2.0 },
    ]);
    expect(next.words.map((w) => w.text)).toEqual(["one", "two", "delta"]);
    expect(noted(next)).toEqual({ a: { words: "one two", text: "ctx" } });
  });

  it("a span note drops when the words it covered are all deleted", () => {
    const only = body(
      SP,
      '{{t:1.00}}alpha {{note-start: [b, "ctx"]}}{{t:2.00}}beta{{note-end: b}} {{t:3.00}}gamma',
    );
    const next = replaceWordRange(parseWords(only), 1, 1, []); // delete beta
    expect(next.words.map((w) => w.text)).toEqual(["alpha", "gamma"]);
    expect(next.spanNotes).toEqual([]);
  });

  it("a span note survives a retime and keeps its text", () => {
    const p = parseWords(src);
    p.words[1] = { ...p.words[1], start: 2.4 };
    const round = parseWords(ser(p));
    expect(noted(round)).toEqual({ a: { words: "alpha beta gamma", text: "ctx" } });
  });
});
