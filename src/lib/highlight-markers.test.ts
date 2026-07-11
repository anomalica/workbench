import { describe, it, expect } from "vitest";
import {
  parseHighlights,
  hasHighlights,
  removeHighlightMarkers,
  decompose,
  makeHighlightId,
} from "./highlight-markers";

/** The text under highlight `id`, reconstructed from the parse. */
function highlighted(body: string, id: string): string[] {
  const { text, highlights } = parseHighlights(body);
  return highlights.filter((h) => h.id === id).map((h) => text.slice(h.start, h.end));
}

describe("parseHighlights - stripping", () => {
  it("removes both markers and leaves the text between them", () => {
    const { text } = parseHighlights("a {{highlight-start: x1}}bright{{highlight-end: x1}} day");
    expect(text).toBe("a bright day");
  });

  it("leaves other annotations ({{t:}}, comments, [notes]) in place", () => {
    const body =
      "<!-- speaker: Bob -->\n{{t:1.0}}my {{highlight-start: a}}word{{highlight-end: a}} [note]";
    const { text } = parseHighlights(body);
    expect(text).toBe("<!-- speaker: Bob -->\n{{t:1.0}}my word [note]");
  });

  it("reports a clean body as having no highlights and no spans", () => {
    const body = "just prose, no markers";
    expect(hasHighlights(body)).toBe(false);
    expect(parseHighlights(body)).toEqual({ text: body, highlights: [] });
  });

  it("detects a body that carries a marker", () => {
    expect(hasHighlights("x {{highlight-start: a}}y{{highlight-end: a}}")).toBe(true);
  });
});

describe("parseHighlights - resolution", () => {
  it("resolves a single pair to the span it wraps", () => {
    expect(highlighted("the {{highlight-start: a}}cat sat{{highlight-end: a}} here", "a")).toEqual([
      "cat sat",
    ]);
  });

  it("keeps two overlapping highlights distinct via their ids", () => {
    // a: "big red", b: "red car"  -> they share "red".
    const body =
      "a {{highlight-start: a}}big {{highlight-start: b}}red{{highlight-end: a}} car{{highlight-end: b}}!";
    expect(highlighted(body, "a")).toEqual(["big red"]);
    expect(highlighted(body, "b")).toEqual(["red car"]);
  });

  it("handles nested highlights", () => {
    const body =
      "{{highlight-start: out}}a {{highlight-start: in}}b{{highlight-end: in}} c{{highlight-end: out}}";
    expect(highlighted(body, "out")).toEqual(["a b c"]);
    expect(highlighted(body, "in")).toEqual(["b"]);
  });

  it("drops an end with no matching open", () => {
    const { text, highlights } = parseHighlights("a {{highlight-end: ghost}}b");
    expect(text).toBe("a b");
    expect(highlights).toEqual([]);
  });

  it("auto-closes an unclosed start at a blank-line block boundary", () => {
    const body = "{{highlight-start: a}}first para keeps going\n\nsecond para is clear";
    expect(highlighted(body, "a")).toEqual(["first para keeps going"]);
  });

  it("auto-closes an unclosed start at a speaker change", () => {
    const body =
      "<!-- speaker: A -->\n{{highlight-start: a}}A talks on\n<!-- speaker: B -->\nB talks";
    // The highlight ends where B's turn begins, not spilling into it.
    expect(highlighted(body, "a")).toEqual(["A talks on\n"]);
  });

  it("does not let a highlight span a speaker change even when closed later", () => {
    const body =
      "<!-- speaker: A -->\n{{highlight-start: a}}A talks\n<!-- speaker: B -->\nB talks{{highlight-end: a}}";
    // Auto-closed at B's turn; the stray end is then dropped.
    const spans = parseHighlights(body).highlights;
    expect(spans).toHaveLength(1);
    expect(spans[0].id).toBe("a");
    expect(highlighted(body, "a")[0]).not.toContain("B talks");
  });

  it("closes a duplicate open before reopening the id", () => {
    const body = "{{highlight-start: a}}one {{highlight-start: a}}two{{highlight-end: a}}";
    // First open closes where the second opens; second runs to its end.
    expect(highlighted(body, "a")).toEqual(["one ", "two"]);
  });

  it("ignores a zero-length pair (start immediately followed by end)", () => {
    const { highlights } = parseHighlights("a{{highlight-start: a}}{{highlight-end: a}}b");
    expect(highlights).toEqual([]);
  });

  it("returns spans in start order", () => {
    const body =
      "{{highlight-start: z}}a{{highlight-end: z}} {{highlight-start: m}}b{{highlight-end: m}}";
    expect(parseHighlights(body).highlights.map((h) => h.id)).toEqual(["z", "m"]);
  });

  it("tolerates whitespace in the marker", () => {
    expect(highlighted("x {{highlight-start:   a1  }}y{{highlight-end:a1}} z", "a1")).toEqual([
      "y",
    ]);
  });
});

describe("removeHighlightMarkers", () => {
  it("removes only the named highlight, leaving the rest", () => {
    const body =
      "{{highlight-start: a}}x {{highlight-start: b}}y{{highlight-end: b}} z{{highlight-end: a}}";
    const out = removeHighlightMarkers(body, "b");
    expect(out).toBe("{{highlight-start: a}}x y z{{highlight-end: a}}");
    expect(highlighted(out, "a")).toEqual(["x y z"]);
  });

  it("is a no-op for an id that is not present", () => {
    const body = "{{highlight-start: a}}x{{highlight-end: a}}";
    expect(removeHighlightMarkers(body, "nope")).toBe(body);
  });
});

describe("decompose", () => {
  it("returns one plain segment when there are no spans", () => {
    expect(decompose([], 0, 10)).toEqual([{ from: 0, to: 10, ids: [] }]);
  });

  it("splits a single span into before / inside / after", () => {
    expect(decompose([{ id: "a", start: 3, end: 6 }], 0, 10)).toEqual([
      { from: 0, to: 3, ids: [] },
      { from: 3, to: 6, ids: ["a"] },
      { from: 6, to: 10, ids: [] },
    ]);
  });

  it("carries the id set of every overlapping span per segment", () => {
    // a:[0,6) b:[3,9) -> [a] [a,b] [b]
    const segs = decompose(
      [
        { id: "a", start: 0, end: 6 },
        { id: "b", start: 3, end: 9 },
      ],
      0,
      9,
    );
    expect(segs).toEqual([
      { from: 0, to: 3, ids: ["a"] },
      { from: 3, to: 6, ids: ["a", "b"] },
      { from: 6, to: 9, ids: ["b"] },
    ]);
  });

  it("handles three mutually overlapping spans", () => {
    const segs = decompose(
      [
        { id: "a", start: 0, end: 4 },
        { id: "b", start: 2, end: 6 },
        { id: "c", start: 3, end: 8 },
      ],
      0,
      8,
    );
    // boundaries at 0,2,3,4,6,8
    expect(segs.map((s) => s.ids)).toEqual([["a"], ["a", "b"], ["a", "b", "c"], ["b", "c"], ["c"]]);
  });

  it("clips spans to the requested range", () => {
    const segs = decompose([{ id: "a", start: -5, end: 100 }], 0, 10);
    expect(segs).toEqual([{ from: 0, to: 10, ids: ["a"] }]);
  });

  it("tiles the whole range contiguously", () => {
    const segs = decompose([{ id: "a", start: 2, end: 4 }], 0, 10);
    expect(segs[0].from).toBe(0);
    expect(segs[segs.length - 1].to).toBe(10);
    for (let i = 1; i < segs.length; i++) expect(segs[i].from).toBe(segs[i - 1].to);
  });

  it("returns nothing for an empty range", () => {
    expect(decompose([{ id: "a", start: 0, end: 5 }], 5, 5)).toEqual([]);
  });
});

describe("makeHighlightId", () => {
  it("mints an id not already taken", () => {
    const id = makeHighlightId(["10", "11"]);
    expect(id).not.toBe("10");
    expect(id).not.toBe("11");
    expect(id.length).toBeGreaterThanOrEqual(2);
  });

  it("mints distinct ids as they accumulate", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = makeHighlightId(taken);
      expect(taken.has(id)).toBe(false);
      taken.add(id);
    }
    expect(taken.size).toBe(50);
  });

  it("mints an id that survives a parse round-trip (no marker collision)", () => {
    const id = makeHighlightId([]);
    const body = `x {{highlight-start: ${id}}}y{{highlight-end: ${id}}} z`;
    expect(highlighted(body, id)).toEqual(["y"]);
  });
});
