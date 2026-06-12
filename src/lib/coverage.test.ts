import { describe, it, expect } from "vitest";
import {
  bodyOf,
  mergeSpans,
  editedLineSpans,
  lineToSegmentMap,
  coveredSegmentIndices,
  segmentLineRanges,
  markObserved,
  selectionCoverageState,
  runsToLineSpans,
  segmentRunsFromLineSpans,
  spanLineCount,
  subtractSpans,
  mergeTiers,
  advancePlayWindow,
  segmentBounds,
  playedSegmentPositions,
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

describe("markObserved", () => {
  it("starts a run from a single selected segment", () => {
    expect(markObserved([], [4])).toEqual([{ from: 4, to: 4 }]);
  });

  it("adds a contiguous selection as one run", () => {
    expect(markObserved([], [3, 4, 5])).toEqual([{ from: 3, to: 5 }]);
  });

  it("keeps non-adjacent selections as separate runs", () => {
    expect(markObserved([], [1, 5])).toEqual([
      { from: 1, to: 1 },
      { from: 5, to: 5 },
    ]);
  });

  it("merges into an overlapping existing run", () => {
    expect(markObserved([{ from: 2, to: 4 }], [3, 4, 5])).toEqual([{ from: 2, to: 5 }]);
  });

  it("coalesces with an index-adjacent existing run", () => {
    expect(markObserved([{ from: 0, to: 2 }], [3])).toEqual([{ from: 0, to: 3 }]);
  });

  it("bridges two existing runs when the selection joins them", () => {
    expect(
      markObserved(
        [
          { from: 0, to: 2 },
          { from: 6, to: 8 },
        ],
        [3, 4, 5],
      ),
    ).toEqual([{ from: 0, to: 8 }]);
  });

  it("is idempotent for already-observed segments", () => {
    expect(markObserved([{ from: 2, to: 5 }], [3, 4])).toEqual([{ from: 2, to: 5 }]);
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

describe("subtractSpans", () => {
  it("removes a fully-covering range", () => {
    expect(subtractSpans([{ from: 2, to: 5 }], [{ from: 0, to: 9 }])).toEqual([]);
  });

  it("splits a span when the removal sits inside it", () => {
    expect(subtractSpans([{ from: 0, to: 9 }], [{ from: 3, to: 5 }])).toEqual([
      { from: 0, to: 2 },
      { from: 6, to: 9 },
    ]);
  });

  it("trims overlapping edges", () => {
    expect(
      subtractSpans(
        [{ from: 2, to: 8 }],
        [
          { from: 0, to: 3 },
          { from: 7, to: 9 },
        ],
      ),
    ).toEqual([{ from: 4, to: 6 }]);
  });

  it("leaves disjoint spans untouched", () => {
    expect(subtractSpans([{ from: 0, to: 1 }], [{ from: 5, to: 6 }])).toEqual([{ from: 0, to: 1 }]);
  });
});

describe("mergeTiers", () => {
  it("observed wins over played on overlap", () => {
    expect(mergeTiers([{ from: 2, to: 4 }], [{ from: 0, to: 6 }])).toEqual([
      { from: 0, to: 1, kind: "played" },
      { from: 2, to: 4, kind: "observed" },
      { from: 5, to: 6, kind: "played" },
    ]);
  });

  it("keeps tiers separate when disjoint", () => {
    expect(mergeTiers([{ from: 5, to: 6 }], [{ from: 0, to: 1 }])).toEqual([
      { from: 0, to: 1, kind: "played" },
      { from: 5, to: 6, kind: "observed" },
    ]);
  });

  it("drops played entirely when observed covers it", () => {
    expect(mergeTiers([{ from: 0, to: 9 }], [{ from: 2, to: 3 }])).toEqual([
      { from: 0, to: 9, kind: "observed" },
    ]);
  });
});

describe("advancePlayWindow", () => {
  it("starts a window from the first sample", () => {
    expect(advancePlayWindow(null, 10)).toEqual({ start: 10, end: 10 });
  });

  it("extends the window for small forward steps", () => {
    let w = advancePlayWindow(null, 10);
    w = advancePlayWindow(w, 10.25);
    w = advancePlayWindow(w, 11);
    expect(w).toEqual({ start: 10, end: 11 });
  });

  it("resets on a forward seek beyond the step threshold", () => {
    const w = advancePlayWindow({ start: 10, end: 11 }, 30);
    expect(w).toEqual({ start: 30, end: 30 });
  });

  it("resets on any backward seek", () => {
    const w = advancePlayWindow({ start: 10, end: 20 }, 15);
    expect(w).toEqual({ start: 15, end: 15 });
  });
});

describe("segmentBounds / playedSegmentPositions", () => {
  const starts = [0, 10, 20, 30];

  it("derives [start, next-start) bounds; last segment ends at duration", () => {
    expect(segmentBounds(starts, 40)).toEqual([
      { start: 0, end: 10 },
      { start: 10, end: 20 },
      { start: 20, end: 30 },
      { start: 30, end: 40 },
    ]);
  });

  it("last segment never completes without a known duration", () => {
    const bounds = segmentBounds(starts);
    expect(playedSegmentPositions({ start: 0, end: 1e9 }, bounds)).toEqual([0, 1, 2]);
  });

  it("marks only segments played start-to-end", () => {
    const bounds = segmentBounds(starts, 40);
    // Joined at 5s (mid-segment 0), played to 25s: only segment 1 completed.
    expect(playedSegmentPositions({ start: 5, end: 25 }, bounds)).toEqual([1]);
  });

  it("a seek-started window does not mark skipped segments", () => {
    const bounds = segmentBounds(starts, 40);
    // Window starting at 20 after a seek covers segments 2 and 3 only.
    expect(playedSegmentPositions({ start: 20, end: 40 }, bounds)).toEqual([2, 3]);
  });

  it("ignores zero or negative-width bounds from non-monotonic timestamps", () => {
    const bounds = segmentBounds([0, 10, 5], 40);
    expect(playedSegmentPositions({ start: 0, end: 40 }, bounds)).toEqual([0, 2]);
  });
});

describe("selectionCoverageState", () => {
  it("returns none for an empty selection", () => {
    expect(selectionCoverageState([], [{ from: 0, to: 5 }], [])).toBe("none");
  });

  it("returns none when no selected segment is covered", () => {
    expect(selectionCoverageState([3, 4], [{ from: 0, to: 1 }], [{ from: 7, to: 9 }])).toBe("none");
  });

  it("returns all-covered when observed runs cover everything", () => {
    expect(selectionCoverageState([2, 3], [{ from: 1, to: 4 }], [])).toBe("all-covered");
  });

  it("counts played runs as coverage", () => {
    expect(selectionCoverageState([2, 3], [], [{ from: 2, to: 3 }])).toBe("all-covered");
  });

  it("combines tiers - observed plus played covering the whole selection", () => {
    expect(selectionCoverageState([1, 2, 3], [{ from: 1, to: 1 }], [{ from: 2, to: 3 }])).toBe(
      "all-covered",
    );
  });

  it("returns partial when only some segments are covered", () => {
    expect(selectionCoverageState([1, 2, 5], [{ from: 1, to: 2 }], [])).toBe("partial");
  });

  it("works with a Set selection", () => {
    expect(selectionCoverageState(new Set([0]), [{ from: 0, to: 0 }], [])).toBe("all-covered");
  });
});
