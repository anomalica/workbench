/**
 * Reviewer highlights, embedded in the record body as inline paired markers.
 *
 * A highlight is a pair `{{highlight-start: id}}` ... `{{highlight-end: id}}`
 * carrying a short opaque id. Two highlights can overlap; the ids are what let a
 * close match the right open, so partially-overlapping ranges interleave instead
 * of merging. The markers are zero-width and ride inside the text, so they
 * survive the small edits (casing, acronym fixes, word retiming) that a stored
 * character offset would not - the reason this is embedded, not a sidecar.
 *
 * Grammar ratified with anomalica/master (2026-07-11):
 *  - `highlight-start` / `highlight-end` are RESERVED marker keys (with `t`),
 *    machine-read, never authored notes.
 *  - Orphan semantics: an unclosed start auto-closes at the end of its block or
 *    speaker turn; an end with no live open is dropped. The digester parses to
 *    the same rule, so the two stay in agreement.
 *
 * This module is coordinate-agnostic: it returns highlight ranges as character
 * offsets into the marker-stripped body. Each renderer maps those to its own
 * units (word indices for the transcript, display offsets for prose) and calls
 * `decompose` to turn overlapping ranges into per-segment id sets.
 */

const MARKER = /\{\{highlight-(start|end):\s*([A-Za-z0-9_-]+)\s*\}\}/g;

/** A highlight as a half-open character range `[start, end)` into the
 *  marker-stripped body, tagged with its id. */
export interface HighlightSpan {
  id: string;
  start: number;
  end: number;
}

export interface ParsedHighlights {
  /** The body with every highlight marker removed. Other annotations
   *  (`{{t:}}`, `<!-- speaker -->`, `[notes]`) are left in place. */
  text: string;
  /** Resolved highlight ranges, in start order. */
  highlights: HighlightSpan[];
}

interface MarkerHit {
  kind: "start" | "end";
  id: string;
  /** Offset in the STRIPPED text where the (zero-width) marker sits. */
  at: number;
}

/** Offsets in the stripped text where a block/turn ends and any still-open
 *  highlight must auto-close: a blank line (paragraph break) or a
 *  `<!-- speaker -->` line (turn change). Word records separate turns with a
 *  speaker comment and never a blank line within a turn; prose records use
 *  blank lines. One rule covers both: a highlight never crosses a paragraph
 *  break or a speaker change. */
function blockBoundaries(text: string): number[] {
  const bounds: number[] = [];
  // A run of blank lines: close at the first newline that begins the gap.
  for (const m of text.matchAll(/\n[ \t]*\n/g)) bounds.push(m.index ?? 0);
  // A speaker comment: close at its line's start.
  for (const m of text.matchAll(/^[ \t]*<!--\s*speaker:[\s\S]*?-->/gm)) bounds.push(m.index ?? 0);
  return bounds.sort((a, b) => a - b);
}

/** Strip highlight markers from `body` and resolve the surviving pairs into
 *  character ranges over the stripped text. */
export function parseHighlights(body: string): ParsedHighlights {
  // Strip the markers, remembering each one's position in the stripped text.
  const hits: MarkerHit[] = [];
  let text = "";
  let last = 0;
  MARKER.lastIndex = 0;
  for (const m of body.matchAll(MARKER)) {
    const idx = m.index ?? 0;
    text += body.slice(last, idx);
    hits.push({ kind: m[1] as "start" | "end", id: m[2], at: text.length });
    last = idx + m[0].length;
  }
  text += body.slice(last);

  if (hits.length === 0) return { text, highlights: [] };

  // Walk markers and block boundaries together, left to right. `open` maps a
  // live highlight id to where it started in the stripped text.
  const bounds = blockBoundaries(text);
  const open = new Map<string, number>();
  const highlights: HighlightSpan[] = [];
  let bi = 0;

  const closeAllOpenAt = (at: number) => {
    for (const [id, start] of open) if (at > start) highlights.push({ id, start, end: at });
    open.clear();
  };

  for (const hit of hits) {
    // Any block boundary strictly before this marker closes everything open.
    while (bi < bounds.length && bounds[bi] <= hit.at) {
      if (bounds[bi] > 0) closeAllOpenAt(bounds[bi]);
      bi++;
    }
    if (hit.kind === "start") {
      // A duplicate open for a live id closes the earlier one first - the id is
      // meant to be unique per record, so this only guards a malformed body.
      if (open.has(hit.id)) highlights.push({ id: hit.id, start: open.get(hit.id)!, end: hit.at });
      open.set(hit.id, hit.at);
    } else if (open.has(hit.id)) {
      const start = open.get(hit.id)!;
      if (hit.at > start) highlights.push({ id: hit.id, start, end: hit.at });
      open.delete(hit.id);
    }
    // An end with no live open is dropped (nothing to do).
  }
  // Block boundaries after the last marker still close what they enclose.
  while (bi < bounds.length) {
    if (bounds[bi] > 0) closeAllOpenAt(bounds[bi]);
    bi++;
  }
  closeAllOpenAt(text.length);

  highlights.sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
  return { text, highlights };
}

/** True if the body carries any highlight marker. */
export function hasHighlights(body: string): boolean {
  return body.includes("{{highlight-");
}

/** Remove both markers of highlight `id` from a raw body, leaving the text and
 *  every other marker untouched. */
export function removeHighlightMarkers(body: string, id: string): string {
  return body.replace(MARKER, (m, _kind, mid) => (mid === id ? "" : m));
}

/** A contiguous slice `[from, to)` and the set of highlight ids covering it.
 *  `ids` is empty for the plain gaps between highlights. */
export interface HighlightSegment {
  from: number;
  to: number;
  ids: string[];
}

/** Decompose overlapping spans across `[lo, hi)` into contiguous, non-
 *  overlapping segments, each carrying the ids of the spans that cover it.
 *  Segments tile the whole range in order, so a caller renders each in turn -
 *  those with no ids are plain text, those with several are an overlap.
 *  Coordinate-agnostic: `lo`/`hi` and the span offsets can be char offsets or
 *  word indices, as long as they share a space. */
export function decompose(
  spans: { id: string; start: number; end: number }[],
  lo: number,
  hi: number,
): HighlightSegment[] {
  if (hi <= lo) return [];
  const clipped = spans
    .map((s) => ({ id: s.id, start: Math.max(lo, s.start), end: Math.min(hi, s.end) }))
    .filter((s) => s.end > s.start);
  if (clipped.length === 0) return [{ from: lo, to: hi, ids: [] }];

  const cuts = new Set<number>([lo, hi]);
  for (const s of clipped) {
    cuts.add(s.start);
    cuts.add(s.end);
  }
  const edges = [...cuts].sort((a, b) => a - b);

  const out: HighlightSegment[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const from = edges[i];
    const to = edges[i + 1];
    if (to <= from) continue;
    const mid = (from + to) / 2;
    const ids = clipped.filter((s) => s.start <= mid && mid < s.end).map((s) => s.id);
    out.push({ from, to, ids });
  }
  return out;
}

/** Mint a short opaque highlight id. Base-36 so ids stay short and
 *  human-distinguishable in the raw body.
 *
 *  IDS ARE NEVER REUSED. Minting is MONOTONIC - strictly above every id the
 *  record currently carries - so a deleted id is never reissued and deletions
 *  simply leave gaps. The old "lowest unused" rule reissued a freed id, which is
 *  fatal now that a `{{highlight-context: [...]}}` edge can name an id: delete
 *  highlight `11` and the next highlight minted took `11` back, so the edge
 *  silently re-pointed at an unrelated span. Not a dangling reference - a
 *  confidently wrong one, invisible to the reviewer. (Ruled by anomalica +
 *  master; the spec words it "a deleted id is never reissued".)
 *
 *  `existing` must therefore include every id the body mentions ANYWHERE -
 *  highlights, span notes, and the ids named by context edges (which are RETAINED
 *  when dangling, so they keep their id claimed). */
export function makeHighlightId(existing: Iterable<string>): string {
  const taken = new Set(existing);
  // The high-water mark: the largest base-36 value in use. Ids that aren't
  // base-36 counters (hand-written, legacy) can't raise it, but they still block
  // collision via `taken`.
  let high = -1;
  for (const id of taken) {
    if (!/^[0-9a-z]+$/.test(id)) continue;
    const n = Number.parseInt(id, 36);
    if (Number.isFinite(n) && n > high) high = n;
  }
  for (let n = Math.max(high + 1, 36); n < Number.MAX_SAFE_INTEGER; n++) {
    // Length >= 2 keeps an id from colliding with a reserved-looking token.
    const id = n.toString(36);
    if (!taken.has(id)) return id;
  }
  // Unreachable in practice; fall back long rather than ever reissue.
  let id = "h";
  while (taken.has(id)) id += "x";
  return id;
}
