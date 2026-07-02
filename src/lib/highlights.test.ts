import { describe, expect, it } from "vitest";
import {
  addSpan,
  buildChunks,
  buildRuns,
  codePointToUtf16,
  loadSpans,
  overlapFraction,
  reanchorSpans,
  saveSpans,
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

describe("buildRuns", () => {
  it("hides word-timing tokens and dims comments", () => {
    const body = "<!-- speaker: A -->\n{{t:1.00}}hello {{t:1.50}}world";
    const runs = buildRuns(body);
    expect(runs.map((r) => [r.kind, r.text])).toEqual([
      ["meta", "<!-- speaker: A -->"],
      ["text", "\n"],
      ["hidden", "{{t:1.00}}"],
      ["text", "hello "],
      ["hidden", "{{t:1.50}}"],
      ["text", "world"],
    ]);
  });

  it("partitions the body exactly (offsets are continuous)", () => {
    const body = "a---\nfile_page: 2\n---b<!-- c -->d";
    const runs = buildRuns(body);
    let pos = 0;
    for (const run of runs) {
      expect(run.start).toBe(pos);
      pos += run.text.length;
    }
    expect(pos).toBe(body.length);
  });

  it("marks annotation fences as meta", () => {
    const body = "before\n---\nfile_page: 2\n---\nafter";
    const runs = buildRuns(body);
    const fence = runs.find((r) => r.kind === "meta");
    expect(fence?.text).toBe("---\nfile_page: 2\n---");
  });
});

describe("buildChunks", () => {
  it("splits runs at span boundaries", () => {
    const body = "hello brave world";
    const spans = [{ start: 6, end: 11, text: "brave" }];
    const chunks = buildChunks(buildRuns(body), spans);
    expect(chunks.map((c) => [c.text, c.spanIndex])).toEqual([
      ["hello ", -1],
      ["brave", 0],
      [" world", -1],
    ]);
  });

  it("carries highlights across hidden runs", () => {
    const body = "{{t:1.00}}alpha {{t:2.00}}beta";
    const spans = [{ start: 10, end: body.length, text: "alpha {{t:2.00}}beta" }];
    const chunks = buildChunks(buildRuns(body), spans);
    // Every chunk after the first hidden token is inside the span,
    // including the hidden token in the middle.
    expect(chunks[0]).toMatchObject({ kind: "hidden", spanIndex: -1 });
    for (const chunk of chunks.slice(1)) {
      expect(chunk.spanIndex).toBe(0);
    }
  });
});
