/**
 * Whether a record's page numbers can be believed, and what to show when not.
 *
 * `file_page` is meant to count the file: 1, 2, 3, 4, never skipping, because
 * it is what the reviewer is scrolling and what the source pane is sent to. One
 * record instead carried 1..25, 76..87, 63..74, 124, 101..150, 101..116 - for a
 * 116-page PDF. The extraction had asked a model which page it was on. It
 * cannot know, so it answered fluently and wrongly, once per chunk.
 *
 * The workbench then did as it was told and jumped the source pane to page 76
 * while the reviewer read page 26, with nothing on screen admitting the two
 * disagreed. Checking the text against the PDF showed every page was present,
 * once, in order - only the written numbers were wrong. So where the numbers
 * contradict themselves and there is exactly one marker per page, POSITION is
 * the better evidence and the numbers are discarded.
 *
 * Where the counts do not line up there is nothing to fall back to, and the
 * right answer is to stop moving the source pane rather than to move it
 * somewhere invented.
 */

export interface PageMarkers {
  /** Page to show for the Nth marker (0-based), or null when unknowable. */
  pageFor(ordinal: number): number | null;
  /** True when the numbers in the record agree with themselves. */
  trustworthy: boolean;
  /** True when position is being used in place of the recorded numbers. */
  derived: boolean;
  /** What is wrong, in terms a reviewer can act on. Empty when trustworthy. */
  fault: string;
}

export function readPageMarkers(claimed: number[], pageCount: number | null): PageMarkers {
  const faults: string[] = [];
  if (claimed.some((n, i) => i > 0 && n <= claimed[i - 1])) faults.push("do not run in order");
  if (new Set(claimed).size !== claimed.length) faults.push("repeat");
  if (pageCount && claimed.some((n) => n < 1 || n > pageCount))
    faults.push(`run past the end of a ${pageCount}-page file`);

  if (!claimed.length || !faults.length) {
    return {
      pageFor: (i) => claimed[i] ?? null,
      trustworthy: true,
      derived: false,
      fault: "",
    };
  }

  const said = `The page numbers in this record ${faults.join(", ")}.`;

  // One marker per page, in order, is enough to recover the numbering from
  // position alone. Fewer or more markers than pages means pages are missing or
  // doubled, and position no longer identifies anything.
  if (pageCount && claimed.length === pageCount) {
    return {
      pageFor: (i) => (i >= 0 && i < pageCount ? i + 1 : null),
      trustworthy: false,
      derived: true,
      fault: `${said} Counting the ${pageCount} page breaks instead.`,
    };
  }

  return {
    pageFor: () => null,
    trustworthy: false,
    derived: false,
    fault: `${said} The original cannot be followed against it.`,
  };
}

const FILE_PAGE = /<!--\s*file_page:\s*(\d+)\s*-->/g;

export function claimedPages(body: string): number[] {
  return [...body.matchAll(FILE_PAGE)].map((m) => Number(m[1]));
}

/**
 * Rewrites `file_page` values to the ones actually shown, so every path that
 * reads them downstream - the divider label, the scroll sync, the click target -
 * agrees without each having to know the numbers were suspect.
 *
 * `printed_page` is left alone: it is the number on the paper, not a count of
 * the file, and a document that restarts at 1 is telling the truth.
 */
export function applyPageMarkers(body: string, markers: PageMarkers, from = 0): string {
  let i = from - 1;
  return body.replace(FILE_PAGE, () => {
    const page = markers.pageFor(++i);
    // An unplaceable break is still a break. Keeping it - unnumbered - shows
    // the page ended where it ended, which is true, instead of dropping the
    // division or printing a number that sends the source pane elsewhere.
    return page === null ? "<!-- page_break -->" : `<!-- file_page: ${page} -->`;
  });
}

/** Every page marker with where it sits, so a caller rendering the body block
 *  by block can still tell which marker in the WHOLE record it is holding. */
export function pageMarkerLines(body: string): Map<number, number> {
  const lines = body.split("\n");
  const at = new Map<number, number>();
  let ordinal = 0;
  lines.forEach((line, i) => {
    for (const _ of line.matchAll(FILE_PAGE)) at.set(i, ordinal++);
  });
  return at;
}
