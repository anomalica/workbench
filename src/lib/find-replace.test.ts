import { describe, it, expect } from "vitest";
import {
  buildSearchText,
  findMatches,
  rawRangesFor,
  applyReplacements,
  matchContext,
} from "./find-replace";
import { parseWords, serializeWords } from "./transcript-words";

const find = (body: string, q: string, cs = false) => {
  const st = buildSearchText(body);
  return { st, matches: findMatches(st, q, cs) };
};
const replace = (body: string, q: string, r: string, pick?: (i: number) => boolean) => {
  const { st, matches } = find(body, q);
  const chosen = pick ? matches.filter((_, i) => pick(i)) : matches;
  return applyReplacements(body, st, chosen, r);
};

describe("buildSearchText", () => {
  it("hides word timestamps so adjacent words become adjacent prose", () => {
    const st = buildSearchText("{{t:2.79}}my {{t:2.93}}consciousness {{t:3.43}}was");
    expect(st.text).toBe("my consciousness was");
  });

  it("hides speaker, page and irrelevant comments", () => {
    const st = buildSearchText("<!-- speaker: Bob -->\nhello\n<!-- file_page: 2 -->\nworld");
    expect(st.text).toBe("\nhello\n\nworld");
    expect(st.text).not.toContain("Bob");
  });

  it("hides highlight markers so a search crosses them", () => {
    const st = buildSearchText("{{highlight-start: a}}my {{highlight-end: a}}consciousness");
    expect(st.text).toBe("my consciousness");
    expect(findMatches(st, "my consciousness")).toHaveLength(1);
  });

  it("hides a keyed note so its interior is not matched as prose", () => {
    const st = buildSearchText("the {{Fravor: holds up photo}} evidence");
    expect(st.text).toBe("the  evidence");
    expect(findMatches(st, "holds")).toHaveLength(0);
  });

  it("hides a line-leading timecode but not a time inside the prose", () => {
    const st = buildSearchText("00:01:24.1 we met at 00:01:24.1 sharp");
    expect(st.text).toBe("we met at 00:01:24.1 sharp");
  });

  it("keeps a bare --- line, which is a horizontal rule and not an annotation", () => {
    const body = "before\n\n---\n\nafter";
    expect(buildSearchText(body).text).toBe(body);
  });

  it("leaves a body with no annotations exactly as it is", () => {
    expect(buildSearchText("the cat sat").text).toBe("the cat sat");
  });
});

describe("findMatches", () => {
  const body = "{{t:1.00}}my {{t:1.50}}consciousness {{t:2.00}}was {{t:2.5}}flapping";

  it("finds a multi-word phrase that the raw body splits across timestamps", () => {
    expect(body).not.toContain("my consciousness"); // the bug, in one line
    expect(find(body, "my consciousness").matches).toHaveLength(1);
  });

  it("finds a phrase spanning three timestamped words", () => {
    expect(find(body, "consciousness was flapping").matches).toHaveLength(1);
  });

  it("never matches inside an annotation", () => {
    expect(find(body, "{{t:").matches).toHaveLength(0);
    expect(find(body, "1.50").matches).toHaveLength(0);
    expect(find("<!-- speaker: Bob -->\nhi", "Bob").matches).toHaveLength(0);
  });

  it("is case-insensitive by default and case-sensitive on request", () => {
    expect(find("Cat cat CAT", "cat").matches).toHaveLength(3);
    expect(find("Cat cat CAT", "cat", true).matches).toHaveLength(1);
  });

  it("treats the query literally - regex metacharacters are not special", () => {
    expect(find("a.b axb a.b", "a.b").matches).toHaveLength(2);
    expect(find("aaa", "a+").matches).toHaveLength(0);
    expect(find("cost $5", "$5").matches).toHaveLength(1);
  });

  it("returns non-overlapping matches", () => {
    expect(find("aaaa", "aa").matches).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it("honours the limit and returns nothing for an empty query", () => {
    expect(findMatches(buildSearchText("a a a"), "a", false, 2)).toHaveLength(2);
    expect(find("a a a", "").matches).toHaveLength(0);
  });
});

describe("rawRangesFor", () => {
  it("gives one range for a match inside a single word", () => {
    const { st, matches } = find("{{t:1.00}}cat", "cat");
    expect(rawRangesFor(st, matches[0])).toEqual([{ start: 10, end: 13 }]);
  });

  it("splits a match at each annotation it spans", () => {
    const { st, matches } = find("{{t:1.00}}my {{t:1.50}}cat", "my cat");
    const ranges = rawRangesFor(st, matches[0]);
    expect(ranges).toHaveLength(2);
    expect(ranges.map((r) => "{{t:1.00}}my {{t:1.50}}cat".slice(r.start, r.end))).toEqual([
      "my ",
      "cat",
    ]);
  });
});

describe("applyReplacements", () => {
  it("replaces a single-word match verbatim", () => {
    expect(replace("the cat sat", "cat", "dog")).toBe("the dog sat");
  });

  it("inserts a replacement containing $ verbatim (no regex substitution)", () => {
    expect(replace("price is X", "X", "$5")).toBe("price is $5");
    expect(replace("a b", "b", "$&$1")).toBe("a $&$1");
  });

  it("replaces across a timestamp and keeps the timestamp", () => {
    const out = replace("{{t:1.00}}my {{t:1.50}}cat {{t:2.00}}sat", "my cat", "our dog");
    expect(out).toBe("{{t:1.00}}our dog{{t:1.50}} {{t:2.00}}sat");
    expect(out).toContain("{{t:1.50}}");
  });

  it("a replacement never damages a speaker comment it spans", () => {
    const body = "hi there\n<!-- speaker: Bob -->\nhi again";
    const out = replace(body, "hi", "yo");
    expect(out).toBe("yo there\n<!-- speaker: Bob -->\nyo again");
  });

  it("replaces every occurrence when all are given", () => {
    expect(replace("cat cat cat", "cat", "dog")).toBe("dog dog dog");
  });

  it("replaces only the chosen occurrences, leaving the rest", () => {
    expect(replace("cat cat cat", "cat", "dog", (i) => i === 1)).toBe("cat dog cat");
    expect(replace("cat cat cat", "cat", "dog", (i) => i !== 1)).toBe("dog cat dog");
  });

  it("deletes the match when the replacement is empty", () => {
    expect(replace("a bad word here", "bad ", "")).toBe("a word here");
  });

  it("handles a match at the very start and very end of the body", () => {
    expect(replace("cat sat cat", "cat", "dog")).toBe("dog sat dog");
  });

  it("leaves the body untouched when nothing is selected", () => {
    const body = "cat cat";
    expect(replace(body, "cat", "dog", () => false)).toBe(body);
  });
});

describe("replacement keeps a word record parseable", () => {
  const body = "<!-- speaker: Bob -->\n{{t:1.00}}my {{t:1.50}}consciousness {{t:2.00}}was";

  it("a cross-word replacement leaves the surviving words' timestamps intact", () => {
    const out = replace(body, "my consciousness", "awareness");
    const { words } = parseWords(out);
    expect(words.map((w) => w.text)).toEqual(["awareness", "was"]);
    expect(words.map((w) => w.start)).toEqual([1.0, 2.0]);
  });

  it("the orphaned timestamp of a swallowed word drops out on re-serialise", () => {
    const out = replace(body, "my consciousness", "awareness");
    const parsed = parseWords(out);
    const round = serializeWords(parsed.words, parsed.runs, parsed.lineEndWords, parsed.preamble);
    expect(round).not.toContain("{{t:1.50}}");
    expect(parseWords(round).words.map((w) => w.text)).toEqual(["awareness", "was"]);
  });

  it("a within-word replacement keeps every word and timestamp", () => {
    const out = replace(body, "consciousness", "awareness");
    const { words } = parseWords(out);
    expect(words.map((w) => w.text)).toEqual(["my", "awareness", "was"]);
    expect(words.map((w) => w.start)).toEqual([1.0, 1.5, 2.0]);
  });

  it("the speaker run survives a replacement", () => {
    const out = replace(body, "was", "is");
    expect(parseWords(out).runs).toEqual([{ speaker: "Bob", startWord: 0, endWord: 2 }]);
  });
});

describe("matchContext", () => {
  it("shows the prose around the match, clipped to its own line", () => {
    const { st, matches } = find("first line\nthe cat sat\nlast line", "cat");
    const ctx = matchContext(st, matches[0]);
    expect(ctx.before).toBe("the ");
    expect(ctx.matched).toBe("cat");
    expect(ctx.after).toBe(" sat");
    expect(ctx.clippedBefore).toBe(false);
    expect(ctx.clippedAfter).toBe(false);
  });

  it("preserves whitespace verbatim so a bad replacement is visible", () => {
    const { st, matches } = find("a  cat  b", "cat");
    const ctx = matchContext(st, matches[0]);
    expect(ctx.before).toBe("a  ");
    expect(ctx.after).toBe("  b");
  });

  it("clips long context and flags it", () => {
    const { st, matches } = find(`${"x".repeat(200)}cat${"y".repeat(200)}`, "cat");
    const ctx = matchContext(st, matches[0], 10);
    expect(ctx.before).toBe("x".repeat(10));
    expect(ctx.after).toBe("y".repeat(10));
    expect(ctx.clippedBefore).toBe(true);
    expect(ctx.clippedAfter).toBe(true);
  });

  it("shows context without any annotation in it", () => {
    const { st, matches } = find("{{t:1.00}}my {{t:1.50}}cat {{t:2.00}}sat", "cat");
    const ctx = matchContext(st, matches[0]);
    expect(ctx.before).toBe("my ");
    expect(ctx.after).toBe(" sat");
  });
});
