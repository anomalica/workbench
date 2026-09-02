import { describe, it, expect } from "vitest";
import {
  readPageMarkers,
  claimedPages,
  applyPageMarkers,
  pageMarkerLines,
} from "$lib/page-markers";

describe("readPageMarkers", () => {
  it("believes numbers that count the file", () => {
    const m = readPageMarkers([1, 2, 3, 4], 4);
    expect(m.trustworthy).toBe(true);
    expect(m.pageFor(2)).toBe(3);
    expect(m.fault).toBe("");
  });

  it("believes a record whose page count is not recorded", () => {
    expect(readPageMarkers([1, 2, 3], null).trustworthy).toBe(true);
  });

  it("counts the page breaks when the numbers contradict themselves", () => {
    // The Sandia record: 116 markers, 116 pages, numbers invented per chunk.
    const claimed = [
      ...range(1, 25),
      ...range(76, 87),
      ...range(63, 74),
      124,
      ...range(101, 150),
      ...range(101, 116),
    ];
    expect(claimed).toHaveLength(116);
    const m = readPageMarkers(claimed, 116);
    expect(m.trustworthy).toBe(false);
    expect(m.derived).toBe(true);
    expect(m.pageFor(0)).toBe(1);
    expect(m.pageFor(25)).toBe(26); // read 76; the table that is really page 26
    expect(m.pageFor(115)).toBe(116);
    expect(m.fault).toContain("116 page breaks");
  });

  it("refuses to guess when the markers do not account for every page", () => {
    // 14 markers claiming up to 59 on a 15-page file: a page is missing, so
    // position identifies nothing and moving the source pane would be a lie.
    const m = readPageMarkers([1, 2, 59, 4, 5], 15);
    expect(m.derived).toBe(false);
    expect(m.pageFor(0)).toBeNull();
    expect(m.fault).toContain("cannot be followed");
  });

  it("names every fault it found, not just the first", () => {
    const m = readPageMarkers([5, 5, 900], 10);
    expect(m.fault).toContain("do not run in order");
    expect(m.fault).toContain("repeat");
    expect(m.fault).toContain("past the end");
  });

  it("treats an empty record as nothing to distrust", () => {
    expect(readPageMarkers([], 10).trustworthy).toBe(true);
  });
});

describe("applyPageMarkers", () => {
  const body = "<!-- file_page: 76 -->\na\n<!-- printed_page: 4 -->\n<!-- file_page: 77 -->\nb";

  it("reads the claimed numbers in document order", () => {
    expect(claimedPages(body)).toEqual([76, 77]);
  });

  it("rewrites them to what is shown", () => {
    const out = applyPageMarkers(body, readPageMarkers([76, 77], 2));
    expect(out).toContain("file_page: 1");
    expect(out).toContain("file_page: 2");
  });

  it("leaves the number printed on the paper alone", () => {
    // A document that restarts its own numbering is not wrong about itself.
    const out = applyPageMarkers(body, readPageMarkers([76, 77], 2));
    expect(out).toContain("printed_page: 4");
  });

  it("keeps an unplaceable break but strips the number that would mislead", () => {
    const out = applyPageMarkers(body, readPageMarkers([1, 59, 3], 15));
    expect(out).not.toContain("file_page");
    expect(out.match(/page_break/g)).toHaveLength(2);
  });

  it("continues the count when a block starts partway through the record", () => {
    // The prose renders block by block, so a block must be told which marker
    // it is starting from or every block restarts the numbering at page 1.
    const markers = readPageMarkers(
      range(1, 100).map((n) => 200 - n),
      100,
    );
    const out = applyPageMarkers("<!-- file_page: 130 -->", markers, 29);
    expect(out).toContain("file_page: 30");
  });
});

function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

describe("pageMarkerLines", () => {
  it("numbers markers by their place in the whole record", () => {
    const body = "a\n<!-- file_page: 76 -->\nb\n\n<!-- file_page: 63 -->\nc";
    expect([...pageMarkerLines(body)]).toEqual([
      [1, 0],
      [4, 1],
    ]);
  });

  it("counts markers the same way the reading does", () => {
    // Both must agree on what a marker IS, or the Nth line maps to the N+1th
    // claimed number and every page is silently off by one.
    const body = "<!-- file_page: 1 -->\nx\n<!-- printed_page: 4 -->\n<!-- file_page: 2 -->\ny";
    expect(pageMarkerLines(body).size).toBe(claimedPages(body).length);
  });
});
