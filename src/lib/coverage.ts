/**
 * Review-coverage helpers.
 *
 * Spans are contiguous 0-based line ranges of the record body (the text
 * after the frontmatter) the reviewer asserts they checked. Prototype
 * anchoring: line indices at submission time, migrated later when the
 * record format gains permanent per-line IDs.
 */

export interface CoverageSpan {
  from: number;
  to: number;
}

/** Coverage tiers. "played" is weak coverage recorded automatically while
 *  media plays through a segment; "observed" is strong coverage the
 *  reviewer asserted (manual mark or an edit). */
export type CoverageKind = "played" | "observed";

export interface KindedSpan extends CoverageSpan {
  kind: CoverageKind;
}

export interface CoverageReview {
  by: string;
  at: string;
  spans: (CoverageSpan & { kind?: CoverageKind })[];
  notes?: string;
  parent_commit?: string;
}

/** Strip frontmatter, returning just the record body. */
export function bodyOf(docText: string): string {
  const match = docText.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return match ? match[1] : docText;
}

/** Merge overlapping/adjacent spans into a minimal sorted list. */
export function mergeSpans(spans: CoverageSpan[]): CoverageSpan[] {
  const sorted = [...spans].sort((a, b) => a.from - b.from);
  const out: CoverageSpan[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.from <= last.to + 1) {
      last.to = Math.max(last.to, s.to);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** Remove every index covered by `remove` from `spans`. Both inputs may be
 *  unsorted/overlapping; output is merged and sorted. */
export function subtractSpans(spans: CoverageSpan[], remove: CoverageSpan[]): CoverageSpan[] {
  const rem = mergeSpans(remove);
  const out: CoverageSpan[] = [];
  for (const s of mergeSpans(spans)) {
    let cur: CoverageSpan | null = { ...s };
    for (const r of rem) {
      if (!cur || r.from > cur.to) break;
      if (r.to < cur.from) continue;
      if (r.from <= cur.from && r.to >= cur.to) {
        cur = null;
      } else if (r.from > cur.from && r.to < cur.to) {
        out.push({ from: cur.from, to: r.from - 1 });
        cur = { from: r.to + 1, to: cur.to };
      } else if (r.from <= cur.from) {
        cur = { from: r.to + 1, to: cur.to };
      } else {
        cur = { from: cur.from, to: r.from - 1 };
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

/** Merge the two pending tiers into one kinded span list. Observed wins
 *  wherever the tiers overlap; played keeps only its remainder. */
export function mergeTiers(observed: CoverageSpan[], played: CoverageSpan[]): KindedSpan[] {
  const obs: KindedSpan[] = mergeSpans(observed).map((s) => ({ ...s, kind: "observed" }));
  const ply: KindedSpan[] = subtractSpans(played, observed).map((s) => ({ ...s, kind: "played" }));
  return [...obs, ...ply].sort((a, b) => a.from - b.from);
}

/** A window of continuous playback: media played from `start` seconds to
 *  `end` seconds without seeking away or pausing. */
export interface PlayWindow {
  start: number;
  end: number;
}

/** Fold a playback-clock sample into a continuous-play window. A jump of
 *  more than `maxStep` seconds forwards (seek/skip) or any move backwards
 *  starts a fresh window - skipped material must not count as played. */
export function advancePlayWindow(win: PlayWindow | null, time: number, maxStep = 2): PlayWindow {
  if (!win || time < win.end || time > win.end + maxStep) {
    return { start: time, end: time };
  }
  return { start: win.start, end: time };
}

/** True when a segment spanning [segStart, segEnd] was played through
 *  end-to-end inside one continuous-play window. */
export function playedThrough(window: PlayWindow, segStart: number, segEnd: number): boolean {
  return window.start <= segStart && window.end >= segEnd;
}

/** Per-segment [start, end) bounds from sorted segment start times. The
 *  last segment ends at `duration` when known, otherwise it can only
 *  complete when playback reaches Infinity (i.e. never). */
export function segmentBounds(starts: number[], duration?: number): PlayWindow[] {
  return starts.map((start, i) => ({
    start,
    end: i + 1 < starts.length ? starts[i + 1] : (duration ?? Infinity),
  }));
}

/** Parse-order positions of segments fully played through by the window. */
export function playedSegmentPositions(window: PlayWindow, bounds: PlayWindow[]): number[] {
  const out: number[] = [];
  bounds.forEach((b, i) => {
    if (b.end > b.start && playedThrough(window, b.start, b.end)) out.push(i);
  });
  return out;
}

/** Line-level diff between the original and current body, returned as
 *  spans over the CURRENT body's line indices. Deleted lines mark the
 *  line now sitting at the deletion point so a pure removal still
 *  registers as touched. */
export function editedLineSpans(originalBody: string, currentBody: string): CoverageSpan[] {
  const oldLines = originalBody.split("\n");
  const newLines = currentBody.split("\n");
  if (originalBody === currentBody) return [];

  const m = oldLines.length;
  const n = newLines.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      lcs[i][j] =
        oldLines[i - 1] === newLines[j - 1]
          ? lcs[i - 1][j - 1] + 1
          : Math.max(lcs[i - 1][j], lcs[i][j - 1]);
    }
  }

  const touched = new Set<number>();
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      i--;
      j--;
    } else if (j > 0 && (i === 0 || lcs[i][j - 1] >= lcs[i - 1][j])) {
      touched.add(j - 1); // added/changed line in current body
      j--;
    } else {
      touched.add(Math.min(j, n - 1)); // deletion point in current body
      i--;
    }
  }

  return mergeSpans([...touched].map((line) => ({ from: line, to: line })));
}

/** Map each body line index to the parse-order index of the transcript
 *  segment it belongs to (-1 before the first segment). New-format
 *  transcripts have one segment per timestamped line in document order;
 *  this mirrors that so coverage spans can light up segment rows. */
export function lineToSegmentMap(body: string): number[] {
  const TIMESTAMPED = /^\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+.+$/;
  const lines = body.split("\n");
  const map: number[] = [];
  let seg = -1;
  for (const raw of lines) {
    if (TIMESTAMPED.test(raw.trim())) seg++;
    map.push(seg);
  }
  return map;
}

/** Per-segment body line ranges, indexed by parse-order segment index.
 *  A segment owns its timestamped line plus any following lines up to the
 *  next timestamped line. */
export function segmentLineRanges(body: string): CoverageSpan[] {
  const map = lineToSegmentMap(body);
  const ranges: CoverageSpan[] = [];
  for (let line = 0; line < map.length; line++) {
    const seg = map[line];
    if (seg < 0) continue;
    if (!ranges[seg]) ranges[seg] = { from: line, to: line };
    else ranges[seg].to = line;
  }
  return ranges;
}

/** Add the given segment indices to the pending runs as observed.
 *  Overlapping and index-adjacent runs coalesce into one. */
export function markObserved(runs: CoverageSpan[], indices: Iterable<number>): CoverageSpan[] {
  return mergeSpans([...runs, ...[...indices].map((i) => ({ from: i, to: i }))]);
}

/** Convert segment-index runs to body line spans. */
export function runsToLineSpans(body: string, runs: CoverageSpan[]): CoverageSpan[] {
  const ranges = segmentLineRanges(body);
  const out: CoverageSpan[] = [];
  for (const r of runs) {
    const from = ranges[r.from]?.from;
    const to = ranges[Math.min(r.to, ranges.length - 1)]?.to;
    if (from === undefined || to === undefined) continue;
    out.push({ from, to });
  }
  return mergeSpans(out);
}

/** Convert body line spans to runs over segment indices, used to
 *  pre-seed pending runs from the lines edited this session. */
export function segmentRunsFromLineSpans(body: string, spans: CoverageSpan[]): CoverageSpan[] {
  return mergeSpans([...coveredSegmentIndices(body, spans)].map((seg) => ({ from: seg, to: seg })));
}

/** Total number of lines covered by a (merged) span list. */
export function spanLineCount(spans: CoverageSpan[]): number {
  return mergeSpans(spans).reduce((acc, s) => acc + (s.to - s.from + 1), 0);
}

/** Segment indices that fall (even partially) inside the given spans. */
export function coveredSegmentIndices(body: string, spans: CoverageSpan[]): Set<number> {
  const map = lineToSegmentMap(body);
  const out = new Set<number>();
  for (const s of spans) {
    for (let line = s.from; line <= Math.min(s.to, map.length - 1); line++) {
      if (map[line] >= 0) out.add(map[line]);
    }
  }
  return out;
}
