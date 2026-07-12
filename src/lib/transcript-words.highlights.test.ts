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

/** The words each highlight covers, by id, from a parse. */
function covered(parsed: ParsedWords): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of parsed.highlights) {
    out[h.id] = parsed.words
      .slice(h.fromWord, h.toWord + 1)
      .map((w) => w.text)
      .join(" ");
  }
  return out;
}

const ser = (p: ParsedWords) =>
  serializeWords(p.words, p.runs, p.lineEndWords, p.preamble, p.highlights);

describe("parseWords - highlight markers", () => {
  it("parses a highlight over a word range and strips its markers from the words", () => {
    const p = parseWords(
      body(
        SP,
        "{{t:1.00}}the {{highlight-start: a}}{{t:1.50}}quick brown{{highlight-end: a}} {{t:2.50}}fox",
      ),
    );
    expect(p.words.map((w) => w.text)).toEqual(["the", "quick brown", "fox"]);
    expect(p.words.some((w) => w.text.includes("highlight"))).toBe(false);
    expect(covered(p)).toEqual({ a: "quick brown" });
  });

  it("keeps two overlapping highlights distinct", () => {
    // a covers words 0..1, b covers words 1..2 -> they share word 1.
    const p = parseWords(
      body(
        SP,
        "{{highlight-start: a}}{{t:1}}big {{highlight-start: b}}{{t:2}}red{{highlight-end: a}} {{t:3}}car{{highlight-end: b}}",
      ),
    );
    expect(covered(p)).toEqual({ a: "big red", b: "red car" });
  });

  it("handles nested highlights", () => {
    const p = parseWords(
      body(
        SP,
        "{{highlight-start: out}}{{t:1}}a {{highlight-start: in}}{{t:2}}b{{highlight-end: in}} {{t:3}}c{{highlight-end: out}}",
      ),
    );
    expect(covered(p)).toEqual({ out: "a b c", in: "b" });
  });

  it("auto-closes an unclosed highlight at a speaker change", () => {
    const p = parseWords(
      body(
        SP,
        "{{highlight-start: a}}{{t:1}}one {{t:2}}two",
        "<!-- speaker: B -->",
        "{{t:3}}three",
      ),
    );
    // Closes on A's last word (two), never spilling into B's turn.
    expect(covered(p)).toEqual({ a: "one two" });
  });

  it("drops an end with no matching open", () => {
    const p = parseWords(body(SP, "{{t:1}}a{{highlight-end: ghost}} {{t:2}}b"));
    expect(p.highlights).toEqual([]);
    expect(p.words.map((w) => w.text)).toEqual(["a", "b"]);
  });

  it("carries a highlight across a line break within a turn", () => {
    const p = parseWords(
      body(SP, "{{highlight-start: a}}{{t:1}}one {{t:2}}two", "{{t:3}}three{{highlight-end: a}}"),
    );
    expect(covered(p)).toEqual({ a: "one two three" });
  });

  it("does not treat markers as words or notes", () => {
    const p = parseWords(body(SP, "{{highlight-start: a}}{{t:1}}word{{highlight-end: a}}"));
    expect(p.words).toHaveLength(1);
    expect(p.words[0].notes).toBeUndefined();
  });

  it("coexists with an event note on the highlighted word", () => {
    const p = parseWords(
      body(SP, "{{highlight-start: a}}{{t:1}}word {{laughs}}{{highlight-end: a}}"),
    );
    expect(p.words[0].text).toBe("word");
    expect(p.words[0].notes).toEqual(["laughs"]);
    expect(covered(p)).toEqual({ a: "word" });
  });
});

describe("serializeWords - highlight markers", () => {
  it("round-trips a highlighted body byte-for-byte", () => {
    const src = body(
      SP,
      "{{t:1.00}}the {{highlight-start: a}}{{t:1.50}}quick brown{{highlight-end: a}} {{t:2.50}}fox",
    );
    // serialise always ends the transcript with a newline (as it does without
    // highlights); the markers themselves are reproduced exactly.
    expect(ser(parseWords(src))).toBe(`${src}\n`);
  });

  it("round-trips overlapping highlights", () => {
    const p = parseWords(
      body(
        SP,
        "{{highlight-start: a}}{{t:1.00}}big {{highlight-start: b}}{{t:2.00}}red{{highlight-end: a}} {{t:3.00}}car{{highlight-end: b}}",
      ),
    );
    // Re-parsing the serialised body yields the same coverage.
    expect(covered(parseWords(ser(p)))).toEqual({ a: "big red", b: "red car" });
  });

  it("emits nothing extra when there are no highlights", () => {
    const src = body(SP, "{{t:1.00}}plain {{t:2.00}}words");
    expect(ser(parseWords(src))).toBe(`${src}\n`);
    const p = parseWords(src);
    expect(serializeWords(p.words, p.runs, p.lineEndWords, "")).not.toContain("highlight");
  });
});

describe("highlights survive word edits", () => {
  const src = body(
    SP,
    "{{highlight-start: a}}{{t:1.00}}alpha {{t:2.00}}beta {{t:3.00}}gamma{{highlight-end: a}} {{t:4.00}}delta",
  );

  it("a highlight follows its words when an earlier word is split", () => {
    const p = parseWords(src);
    // Split word 3 ("delta"), which is AFTER the highlight - highlight unchanged.
    const next = splitWord(p, 3, ["del", "ta"]);
    expect(covered(next)).toEqual({ a: "alpha beta gamma" });
  });

  it("a highlight grows when a word inside it is split", () => {
    const p = parseWords(src);
    // Split word 1 ("beta") into two - the highlight must cover both pieces.
    const next = splitWord(p, 1, ["be", "ta"]);
    expect(next.words.map((w) => w.text)).toEqual(["alpha", "be", "ta", "gamma", "delta"]);
    expect(covered(next)).toEqual({ a: "alpha be ta gamma" });
  });

  it("a highlight is untouched when a word wholly before it is replaced", () => {
    // Highlight covers beta..gamma (words 1..2); alpha (word 0) is before it.
    const p = parseWords(
      body(
        SP,
        "{{t:1.00}}alpha {{highlight-start: a}}{{t:2.00}}beta {{t:3.00}}gamma{{highlight-end: a}} {{t:4.00}}delta",
      ),
    );
    const next = replaceWordRange(p, 0, 0, [{ text: "A", start: 1.0 }]);
    expect(covered(next)).toEqual({ a: "beta gamma" });
  });

  it("a highlight clamps when its own words are replaced", () => {
    const p = parseWords(src);
    // Replace words 0..2 ("alpha beta gamma", which contains the highlight 0..2)
    // with two words - the highlight clamps onto the new words.
    const next = replaceWordRange(p, 0, 2, [
      { text: "one", start: 1.0 },
      { text: "two", start: 2.0 },
    ]);
    expect(next.words.map((w) => w.text)).toEqual(["one", "two", "delta"]);
    // a started at word 0 and ended at word 2; both clamp into [0,1].
    expect(covered(next)).toEqual({ a: "one two" });
  });

  it("a highlight drops when the words it covered are all deleted", () => {
    // Highlight over just word 1 ("beta").
    const only = body(
      SP,
      "{{t:1.00}}alpha {{highlight-start: b}}{{t:2.00}}beta{{highlight-end: b}} {{t:3.00}}gamma",
    );
    const p = parseWords(only);
    const next = replaceWordRange(p, 1, 1, []); // delete beta
    expect(next.words.map((w) => w.text)).toEqual(["alpha", "gamma"]);
    expect(next.highlights).toEqual([]);
  });

  it("a highlight survives a retime (start-time change shifts no indices)", () => {
    const p = parseWords(src);
    p.words[1] = { ...p.words[1], start: 2.4 };
    const round = parseWords(ser(p));
    expect(covered(round)).toEqual({ a: "alpha beta gamma" });
  });
});
