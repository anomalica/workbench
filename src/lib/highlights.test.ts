import { describe, expect, it } from "vitest";
import {
  addSpan,
  buildDisplay,
  cleanExcerpt,
  codePointToUtf16,
  displayToRaw,
  loadSpans,
  overlapFraction,
  rawToDisplay,
  reanchorSpans,
  saveSpans,
  segmentChunks,
  trimSpan,
  utf16ToCodePoint,
} from "./highlights";

describe("offset conversion", () => {
  it("is the identity on BMP-only text", () => {
    const body = "plain ascii text";
    expect(utf16ToCodePoint(body, 7)).toBe(7);
    expect(codePointToUtf16(body, 7)).toBe(7);
  });

  it("counts an astral char as one code point but two UTF-16 units", () => {
    const body = "a\u{1F6F8}b"; // a, UFO emoji (surrogate pair), b
    expect(body.length).toBe(4);
    expect(utf16ToCodePoint(body, 3)).toBe(2); // index of "b" in code points
    expect(codePointToUtf16(body, 2)).toBe(3);
  });

  it("round-trips spans through the wire format", () => {
    const body = "café \u{1F6F8} sighting";
    const text = "\u{1F6F8} sighting";
    const startU16 = body.indexOf(text);
    const ui = [{ start: startU16, end: startU16 + text.length, text }];
    const wire = saveSpans(body, ui);
    expect(wire[0].start).toBe(5); // code points: c,a,f,é,space
    expect(wire[0].text).toBe(text);
    expect(loadSpans(body, wire)).toEqual(ui);
  });
});

describe("trimSpan", () => {
  it("strips surrounding whitespace", () => {
    const body = "say  hello  now";
    const span = trimSpan(body, 3, 12);
    expect(span).toEqual({ start: 5, end: 10, text: "hello" });
  });

  it("returns null for whitespace-only selections", () => {
    expect(trimSpan("a   b", 1, 4)).toBeNull();
  });
});

describe("addSpan", () => {
  const body = "the tic-tac moved erratically over the water";

  it("keeps disjoint spans sorted", () => {
    const a = { start: 12, end: 17, text: "moved" };
    const b = { start: 4, end: 11, text: "tic-tac" };
    const spans = addSpan(body, [a], b);
    expect(spans.map((s) => s.text)).toEqual(["tic-tac", "moved"]);
  });

  it("merges overlapping spans into their union", () => {
    const a = { start: 4, end: 17, text: "tic-tac moved" };
    const b = { start: 12, end: 29, text: "moved erratically" };
    const spans = addSpan(body, [a], b);
    expect(spans).toEqual([{ start: 4, end: 29, text: "tic-tac moved erratically" }]);
  });

  it("keeps the first note when merging", () => {
    const a = { start: 4, end: 11, text: "tic-tac", note: "object" };
    const b = { start: 8, end: 17, text: "tac moved" };
    expect(addSpan(body, [a], b)[0].note).toBe("object");
  });
});

describe("reanchorSpans", () => {
  it("re-finds spans by text after the body shifts", () => {
    const body = "PREFIX added. the tic-tac moved";
    const { anchored, lost } = reanchorSpans(body, [{ start: 4, end: 11, text: "tic-tac" }]);
    expect(lost).toEqual([]);
    expect(anchored).toEqual([{ start: 18, end: 25, text: "tic-tac" }]);
  });

  it("reports spans whose text vanished", () => {
    const { anchored, lost } = reanchorSpans("nothing matches here", [
      { start: 0, end: 7, text: "tic-tac" },
    ]);
    expect(anchored).toEqual([]);
    expect(lost.map((s) => s.text)).toEqual(["tic-tac"]);
  });

  it("prefers the occurrence nearest the original offset", () => {
    const body = "echo ... echo";
    const { anchored } = reanchorSpans(body, [{ start: 8, end: 12, text: "echo" }]);
    expect(anchored[0].start).toBe(9);
  });
});

describe("overlapFraction", () => {
  it("is 1 when fully inside a span", () => {
    const spans = [{ start: 0, end: 20, text: "" }];
    expect(overlapFraction({ start: 5, end: 15, text: "" }, spans)).toBe(1);
  });

  it("is proportional for partial overlap", () => {
    const spans = [{ start: 0, end: 10, text: "" }];
    expect(overlapFraction({ start: 5, end: 15, text: "" }, spans)).toBe(0.5);
  });

  it("is 0 with no spans", () => {
    expect(overlapFraction({ start: 0, end: 4, text: "" }, [])).toBe(0);
  });
});

describe("buildDisplay", () => {
  it("merges word-timed text into one segment per speaker turn", () => {
    const body = "<!-- speaker: A -->\n{{t:1.00}}hello {{t:1.50}}world";
    const segments = buildDisplay(body);
    expect(segments.map((s) => [s.kind, s.kind === "label" ? s.label : s.text])).toEqual([
      ["label", "A"],
      ["text", "\nhello world"],
    ]);
    // ONE text segment despite two timing tokens - not a chunk per word.
    expect(segments[1].parts.length).toBe(3);
  });

  it("hides sentence timecodes and annotation fences", () => {
    const body = "---\nfile_page: 2\n---\n00:01:24.1 Some testimony here.";
    const segments = buildDisplay(body);
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe("\nSome testimony here.");
  });

  it("turns old-format block speaker comments into labels", () => {
    const body = "<!--\nspeaker: David Fravor\ntime: 00:07:17\n-->\nText content here.";
    const segments = buildDisplay(body);
    expect(segments[0]).toMatchObject({ kind: "label", label: "David Fravor" });
    expect(segments[1].text).toBe("\nText content here.");
  });

  it("maps display offsets back to raw offsets exactly", () => {
    const body = "{{t:1.00}}alpha {{t:2.00}}beta";
    const [seg] = buildDisplay(body);
    expect(seg.text).toBe("alpha beta");
    // "beta" starts at display 6, raw 26 (after the second token).
    expect(displayToRaw(seg, 6, "start")).toBe(26);
    expect(body.slice(displayToRaw(seg, 6, "start"), displayToRaw(seg, 10, "end"))).toBe("beta");
  });

  it("start bias skips a hidden gap, end bias stops before it", () => {
    const body = "one{{t:2.00}}two";
    const [seg] = buildDisplay(body);
    // Display offset 3 is the boundary between "one" and "two".
    expect(displayToRaw(seg, 3, "start")).toBe(13); // start of "two"
    expect(displayToRaw(seg, 3, "end")).toBe(3); // end of "one"
  });

  it("rawToDisplay rounds gap offsets to visible text", () => {
    const body = "one{{t:2.00}}two";
    const [seg] = buildDisplay(body);
    // Raw offset 8 sits inside the hidden token.
    expect(rawToDisplay(seg, 8, "start")).toBe(3);
    expect(rawToDisplay(seg, 8, "end")).toBe(3);
    expect(rawToDisplay(seg, 14, "start")).toBe(4); // inside "two"
  });
});

describe("segmentChunks", () => {
  it("splits a segment at highlight boundaries", () => {
    const body = "hello brave world";
    const [seg] = buildDisplay(body);
    const chunks = segmentChunks(seg, [{ start: 6, end: 11, text: "brave" }]);
    expect(chunks.map((c) => [c.text, c.spanIndex])).toEqual([
      ["hello ", -1],
      ["brave", 0],
      [" world", -1],
    ]);
  });

  it("renders a highlight spanning hidden tokens as continuous", () => {
    const body = "{{t:1.00}}alpha {{t:2.00}}beta";
    const [seg] = buildDisplay(body);
    const spans = [{ start: 10, end: body.length, text: "alpha {{t:2.00}}beta" }];
    const chunks = segmentChunks(seg, spans);
    expect(chunks).toEqual([{ d: 0, text: "alpha beta", spanIndex: 0 }]);
  });

  it("returns the whole segment as one plain chunk with no spans", () => {
    const [seg] = buildDisplay("just prose");
    expect(segmentChunks(seg, [])).toEqual([{ d: 0, text: "just prose", spanIndex: -1 }]);
  });
});

describe("cleanExcerpt", () => {
  it("strips timing tokens, comments, and timecodes", () => {
    const text = "00:01:24.1 The {{t:84.1}}craft <!-- speaker: A --> hovered";
    expect(cleanExcerpt(text)).toBe("The craft hovered");
  });
});
