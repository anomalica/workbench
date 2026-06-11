import { describe, it, expect } from "vitest";
import {
  bodyOf,
  mergeSpans,
  editedLineSpans,
  lineToSegmentMap,
  coveredSegmentIndices,
} from "./coverage";

describe("bodyOf", () => {
  it("strips frontmatter", () => {
    expect(bodyOf("---\ntitle: x\n---\nbody line")).toBe("body line");
  });

  it("returns the whole text when there is no frontmatter", () => {
    expect(bodyOf("just text")).toBe("just text");
  });
});

describe("mergeSpans", () => {
  it("merges overlapping and adjacent spans, sorted", () => {
    expect(
      mergeSpans([
        { from: 5, to: 7 },
        { from: 0, to: 2 },
        { from: 3, to: 4 },
        { from: 10, to: 12 },
      ]),
    ).toEqual([
      { from: 0, to: 7 },
      { from: 10, to: 12 },
    ]);
  });
});

describe("editedLineSpans", () => {
  const original = "alpha\nbravo\ncharlie\ndelta\necho";

  it("returns no spans when nothing changed", () => {
    expect(editedLineSpans(original, original)).toEqual([]);
  });

  it("marks a single changed line", () => {
    const current = "alpha\nbravo\nCHARLIE\ndelta\necho";
    expect(editedLineSpans(original, current)).toEqual([{ from: 2, to: 2 }]);
  });

  it("marks inserted lines at their current position", () => {
    const current = "alpha\nbravo\nnew one\nnew two\ncharlie\ndelta\necho";
    expect(editedLineSpans(original, current)).toEqual([{ from: 2, to: 3 }]);
  });

  it("marks the deletion point when lines are removed", () => {
    const current = "alpha\ndelta\necho";
    expect(editedLineSpans(original, current)).toEqual([{ from: 1, to: 1 }]);
  });

  it("returns separate spans for distant edits", () => {
    const current = "ALPHA\nbravo\ncharlie\ndelta\nECHO";
    expect(editedLineSpans(original, current)).toEqual([
      { from: 0, to: 0 },
      { from: 4, to: 4 },
    ]);
  });

  it("handles edits at the very end of the body", () => {
    const current = "alpha\nbravo\ncharlie\ndelta";
    expect(editedLineSpans(original, current)).toEqual([{ from: 3, to: 3 }]);
  });
});

describe("lineToSegmentMap / coveredSegmentIndices", () => {
  const body = [
    "<!-- speaker: Alice -->", // 0 -> -1
    "00:00:01.0 First sentence.", // 1 -> 0
    "00:00:05.0 Second sentence.", // 2 -> 1
    "", // 3 -> 1
    "<!-- speaker: Bob -->", // 4 -> 1
    "00:00:09.0 Third sentence.", // 5 -> 2
  ].join("\n");

  it("maps lines to parse-order segment indices", () => {
    expect(lineToSegmentMap(body)).toEqual([-1, 0, 1, 1, 1, 2]);
  });

  it("collects segments touched by spans", () => {
    expect(coveredSegmentIndices(body, [{ from: 2, to: 5 }])).toEqual(new Set([1, 2]));
    expect(coveredSegmentIndices(body, [{ from: 0, to: 0 }])).toEqual(new Set());
  });
});
