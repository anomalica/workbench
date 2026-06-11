import { describe, it, expect } from "vitest";
import {
  bodyOf,
  mergeSpans,
  editedLineSpans,
  lineToSegmentMap,
  coveredSegmentIndices,
  segmentLineRanges,
  markReviewedUpTo,
  runsToLineSpans,
  segmentRunsFromLineSpans,
  spanLineCount,
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

  it("maps segments back to their owning line ranges", () => {
    expect(segmentLineRanges(body)).toEqual([
      { from: 1, to: 1 },
      { from: 2, to: 4 },
      { from: 5, to: 5 },
    ]);
  });

  it("converts segment runs to merged line spans", () => {
    expect(runsToLineSpans(body, [{ from: 0, to: 1 }])).toEqual([{ from: 1, to: 4 }]);
    expect(
      runsToLineSpans(body, [
        { from: 0, to: 0 },
        { from: 2, to: 2 },
      ]),
    ).toEqual([
      { from: 1, to: 1 },
      { from: 5, to: 5 },
    ]);
  });

  it("clamps runs that point past the last segment", () => {
    expect(runsToLineSpans(body, [{ from: 0, to: 99 }])).toEqual([{ from: 1, to: 5 }]);
  });

  it("derives segment runs from edited line spans", () => {
    expect(segmentRunsFromLineSpans(body, [{ from: 2, to: 5 }])).toEqual([{ from: 1, to: 2 }]);
    expect(segmentRunsFromLineSpans(body, [{ from: 0, to: 0 }])).toEqual([]);
  });
});

describe("markReviewedUpTo", () => {
  it("starts a run at the first clicked segment", () => {
    expect(markReviewedUpTo([], 4)).toEqual([{ from: 4, to: 4 }]);
  });

  it("extends the run down to a later click", () => {
    expect(markReviewedUpTo([{ from: 4, to: 4 }], 9)).toEqual([{ from: 4, to: 9 }]);
  });

  it("extends the nearest run above when several exist", () => {
    expect(
      markReviewedUpTo(
        [
          { from: 0, to: 2 },
          { from: 10, to: 12 },
        ],
        15,
      ),
    ).toEqual([
      { from: 0, to: 2 },
      { from: 10, to: 15 },
    ]);
  });

  it("starts a new run on a click above all existing runs", () => {
    expect(markReviewedUpTo([{ from: 10, to: 12 }], 3)).toEqual([
      { from: 3, to: 3 },
      { from: 10, to: 12 },
    ]);
  });

  it("merges when an extension reaches the next run", () => {
    expect(
      markReviewedUpTo(
        [
          { from: 0, to: 2 },
          { from: 6, to: 8 },
        ],
        5,
      ),
    ).toEqual([{ from: 0, to: 8 }]);
  });

  it("truncates a run when clicking inside it", () => {
    expect(markReviewedUpTo([{ from: 2, to: 9 }], 5)).toEqual([{ from: 2, to: 5 }]);
  });

  it("truncates to the first segment, then removes on the next click", () => {
    const truncated = markReviewedUpTo([{ from: 2, to: 9 }], 2);
    expect(truncated).toEqual([{ from: 2, to: 2 }]);
    expect(markReviewedUpTo(truncated, 2)).toEqual([]);
  });
});

describe("spanLineCount", () => {
  it("counts lines across merged spans", () => {
    expect(spanLineCount([])).toBe(0);
    expect(
      spanLineCount([
        { from: 0, to: 4 },
        { from: 3, to: 6 },
        { from: 10, to: 10 },
      ]),
    ).toBe(8);
  });
});
