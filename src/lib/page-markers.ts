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

/**
 * Finding the markers.
 *
 * A page marker is a comment CONTAINING a file_page line, not a comment of a
 * particular shape. Most records write it inline:
 *
 *     <!-- file_page: 12 -->
 *
 * but some group it with the printed number in one block:
 *
 *     <!--
 *     file_page: 12
 *     printed_page: 4
 *     -->
 *
 * The first version of this matched only the inline form. It found nothing in
 * the 63 markers of one record and 13 of 16 in another, and reported them as
 * records missing their pages - a confident, wrong answer in exactly the shape
 * of a right one. So the comment is parsed and then looked inside, rather than
 * its punctuation being enumerated.
 */
const COMMENT = /<!--([\s\S]*?)-->/g;
const FILE_PAGE_LINE = /(?:^|\n)[ \t]*file_page:[ \t]*(\d+)[ \t]*(?=\n|$)/;

function claimedIn(comment: string): number | null {
  const m = comment.match(FILE_PAGE_LINE);
  return m ? Number(m[1]) : null;
}

export function claimedPages(body: string): number[] {
  const out: number[] = [];
  for (const m of body.matchAll(COMMENT)) {
    const n = claimedIn(m[1]);
    if (n !== null) out.push(n);
  }
  return out;
}

/**
 * Rewrites the page numbers to the ones actually shown, so every path that
 * reads them downstream - the divider label, the scroll sync, the click target -
 * agrees without each having to know the numbers were suspect.
 *
 * `printed_page` is left alone wherever it appears: it is the number on the
 * paper, not a count of the file, and a document that restarts at 1 is telling
 * the truth about itself.
 */
export function applyPageMarkers(body: string, markers: PageMarkers, from = 0): string {
  let i = from - 1;
  return body.replace(COMMENT, (whole, inner: string) => {
    if (claimedIn(inner) === null) return whole;
    const page = markers.pageFor(++i);
    // Rewritten inside the comment, then put back: the delimiters are not part
    // of what a line matches, and replacing against the whole comment silently
    // matched nothing and left every number as it was.
    if (page !== null) {
      const fixed = inner.replace(FILE_PAGE_LINE, (line) => line.replace(/\d+/, String(page)));
      return `<!--${fixed}-->`;
    }
    // Unplaceable. Drop the number that would send the source pane somewhere
    // invented, but keep anything else the comment was carrying - and keep the
    // break itself, because the page did end here.
    const rest = inner.replace(FILE_PAGE_LINE, "").trim();
    return rest ? `<!--\n${rest}\n-->` : "<!-- page_break -->";
  });
}

/** Every page marker's line, and which marker of the whole record it is, so a
 *  caller rendering block by block can still place a block's first marker. */
export function pageMarkerLines(body: string): Map<number, number> {
  const at = new Map<number, number>();
  let ordinal = 0;
  for (const m of body.matchAll(COMMENT)) {
    if (claimedIn(m[1]) === null) continue;
    const line = body.slice(0, m.index).split("\n").length - 1;
    at.set(line, ordinal++);
  }
  return at;
}
