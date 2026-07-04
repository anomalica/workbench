import { describe, it, expect } from "vitest";
import {
  isContentLine,
  parseTextBlocks,
  totalUnits,
  observedLineSpans,
  blocksCoveredBySpans,
  unitsInSpans,
  markIrrelevantLines,
  unmarkIrrelevantAt,
  shiftSpansForMark,
  shiftSpansForRemoval,
} from "./text-blocks";

describe("isContentLine", () => {
  it("counts non-blank, non-comment lines only", () => {
    expect(isContentLine("Hello.")).toBe(true);
    expect(isContentLine("   ")).toBe(false);
    expect(isContentLine("")).toBe(false);
    expect(isContentLine("<!-- file_page: 5 -->")).toBe(false);
    expect(isContentLine("  <!-- image:")).toBe(false);
    // A comment-continuation line does NOT start with <!-- so the gate counts
    // it; we must match that to keep the verdict and recompute in agreement.
    expect(isContentLine("  file: abc123def456.jpg")).toBe(true);
  });
});

describe("parseTextBlocks", () => {
  const body = "# Title\n\nFirst paragraph line one.\nline two.\n\nSecond paragraph.\n";

  it("splits on blank lines into blocks with source line ranges", () => {
    const blocks = parseTextBlocks(body);
    expect(blocks.map((b) => [b.lineFrom, b.lineTo])).toEqual([
      [0, 0],
      [2, 3],
      [5, 5],
    ]);
    expect(blocks[1].source).toBe("First paragraph line one.\nline two.");
  });

  it("counts content lines per block, excluding comments", () => {
    const withComment = "Intro.\n\n<!-- file_page: 1 -->\n\nBody text.\n";
    const blocks = parseTextBlocks(withComment);
    // The lone comment block has zero units.
    expect(blocks.map((b) => b.contentLines.length)).toEqual([1, 0, 1]);
    expect(totalUnits(blocks)).toBe(2);
  });
});

describe("observed line spans and coverage", () => {
  const body = "# Title\n\nPara one.\nstill one.\n\nPara two.\n\nPara three.\n";
  const blocks = parseTextBlocks(body);
  // blocks: 0 -> [0,0], 1 -> [2,3], 2 -> [5,5], 3 -> [7,7]

  it("converts observed blocks to merged line spans", () => {
    const spans = observedLineSpans(blocks, new Set([1, 2]));
    // [2,3] and [5,5] are not adjacent (line 4 is blank), so two spans.
    expect(spans).toEqual([
      { from: 2, to: 3 },
      { from: 5, to: 5 },
    ]);
  });

  it("round-trips: blocks -> spans -> covered blocks", () => {
    const spans = observedLineSpans(blocks, new Set([0, 3]));
    expect(blocksCoveredBySpans(blocks, spans)).toEqual(new Set([0, 3]));
  });

  it("counts units inside spans for the coverage fraction", () => {
    const spans = observedLineSpans(blocks, new Set([1])); // 2 content lines
    expect(unitsInSpans(blocks, spans)).toBe(2);
    expect(totalUnits(blocks)).toBe(5);
  });

  it("ignores comment-only blocks when reporting covered blocks", () => {
    const withComment = "Body.\n\n<!-- chapter: 2 -->\n";
    const cb = parseTextBlocks(withComment);
    // Even if a span covers the comment block's line, it has no units so it is
    // never reported as covered.
    expect(blocksCoveredBySpans(cb, [{ from: 0, to: 2 }])).toEqual(new Set([0]));
  });
});

describe("irrelevant regions", () => {
  const body = "Intro paragraph.\n\nAd for the sequel.\n\nBuy it now.\n\nAppendix A.";
  // blocks: 0 Intro [0,0], 1 Ad [2,2], 2 Buy [4,4], 3 Appendix [6,6]

  it("marks a block range and parses it back as irrelevant", () => {
    const marked = markIrrelevantLines(body, 2, 4);
    expect(marked).toBe(
      "Intro paragraph.\n\n<!-- irrelevant: start -->\n\nAd for the sequel.\n\nBuy it now.\n\n<!-- irrelevant: end -->\n\nAppendix A.",
    );
    const blocks = parseTextBlocks(marked);
    expect(blocks.map((b) => [b.source, b.irrelevant])).toEqual([
      ["Intro paragraph.", false],
      ["Ad for the sequel.", true],
      ["Buy it now.", true],
      ["Appendix A.", false],
    ]);
  });

  it("irrelevant blocks carry no reviewable units", () => {
    const blocks = parseTextBlocks(markIrrelevantLines(body, 2, 4));
    expect(totalUnits(blocks)).toBe(2); // only Intro + Appendix count
    expect(blocks[1].contentLines).toEqual([]);
  });

  it("unmark restores the original body exactly", () => {
    const marked = markIrrelevantLines(body, 2, 4);
    const regionLine = parseTextBlocks(marked).find((b) => b.irrelevant)?.lineFrom ?? -1;
    const result = unmarkIrrelevantAt(marked, regionLine);
    expect(result.body).toBe(body);
    expect(result.removed).toEqual([2, 3, 7, 8]);
  });

  it("unmark outside any region is a no-op", () => {
    const marked = markIrrelevantLines(body, 2, 4);
    expect(unmarkIrrelevantAt(marked, 0)).toEqual({ body: marked, removed: [] });
  });

  it("tolerates the no-space marker form when parsing", () => {
    const legacy = "Keep.\n\n<!-- irrelevant:start -->\nJunk.\n<!-- irrelevant:end -->";
    const blocks = parseTextBlocks(legacy);
    expect(blocks.map((b) => [b.source, b.irrelevant])).toEqual([
      ["Keep.", false],
      ["Junk.", true],
    ]);
  });

  it("supports multiple regions without nesting", () => {
    const two = markIrrelevantLines(markIrrelevantLines(body, 6, 6), 0, 0);
    const blocks = parseTextBlocks(two);
    expect(blocks.map((b) => b.irrelevant)).toEqual([true, false, false, true]);
  });

  it("shifts session coverage spans past inserted markers", () => {
    const spans = [
      { from: 0, to: 0 }, // before the region - unmoved
      { from: 2, to: 4 }, // inside - shifted by the start-side insert
      { from: 6, to: 6 }, // after - shifted by both inserts
    ];
    expect(shiftSpansForMark(spans, 2, 4)).toEqual([
      { from: 0, to: 0 },
      { from: 4, to: 6 },
      { from: 10, to: 10 },
    ]);
  });
});

describe("shiftSpansForRemoval", () => {
  it("shifts spans down past removed marker lines", () => {
    const spans = [
      { from: 0, to: 0 },
      { from: 4, to: 6 },
      { from: 12, to: 12 },
    ];
    expect(shiftSpansForRemoval(spans, [2, 3, 7, 8])).toEqual([
      { from: 0, to: 0 },
      { from: 2, to: 4 },
      { from: 8, to: 8 },
    ]);
  });
});
