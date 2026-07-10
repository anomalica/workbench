/**
 * Literal find/replace over a record body, run against the PROSE a reviewer can
 * actually see rather than the raw stored text.
 *
 * A word-timestamped body stores `{{t:2.79}}my {{t:2.93}}consciousness`, so a
 * raw search for "my consciousness" finds nothing - the timestamp sits between
 * the words. Every multi-word search failed for exactly that reason. Here the
 * annotations (word timestamps, speaker/page comments, line timecodes) are
 * removed to build a clean search text, each visible run remembering where it
 * came from, so matches map back to exact raw offsets.
 *
 * Replacement writes over the VISIBLE text only and steps around the hidden
 * annotations between the words it spans, so replacing across a word boundary
 * never destroys a timestamp or a speaker comment.
 *
 * No regex: the query is matched literally, always.
 */

/** A run of visible body text: `len` chars at display offset `d`, taken from
 *  raw offset `raw`. */
export interface VisiblePart {
  d: number;
  raw: number;
  len: number;
}

export interface SearchText {
  /** The body with every annotation removed - what the reviewer searches. */
  text: string;
  parts: VisiblePart[];
}

/** A match in `SearchText.text` coordinates. */
export interface Match {
  start: number;
  end: number;
}

/** A half-open range of the raw body. */
export interface RawRange {
  start: number;
  end: number;
}

// Annotations: never searched, never replaced, never shown. Deliberately NOT a
// `---` fence: a bare `---` line in a body is a markdown horizontal rule, and
// treating it as a fence would swallow everything up to the next one.
const HIDDEN_PATTERNS: RegExp[] = [
  /\{\{t:[0-9.]+\}\}/g, // per-word timestamps
  /<!--[\s\S]*?-->/g, // speaker, file_page, irrelevant markers
  /^\d{2}:\d{2}:\d{2}(?:\.\d+)?[ \t]/gm, // line-leading timecode
];

/** Lowercase without ever changing the string's length. `toLowerCase` lengthens
 *  a few characters (Turkish dotted capital I), which would shift every offset
 *  after them; those characters simply stay as they are. */
function foldCase(s: string): string {
  let out = "";
  for (const ch of s) {
    const lower = ch.toLowerCase();
    out += lower.length === ch.length ? lower : ch;
  }
  return out;
}

/** Strip annotations from `body`, keeping a map back to raw offsets. */
export function buildSearchText(body: string): SearchText {
  const marks: RawRange[] = [];
  for (const re of HIDDEN_PATTERNS) {
    re.lastIndex = 0;
    for (const m of body.matchAll(re)) {
      marks.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
    }
  }
  marks.sort((a, b) => a.start - b.start || a.end - b.end);

  const parts: VisiblePart[] = [];
  let text = "";
  const pushVisible = (from: number, to: number) => {
    if (to <= from) return;
    parts.push({ d: text.length, raw: from, len: to - from });
    text += body.slice(from, to);
  };

  let pos = 0;
  for (const mark of marks) {
    if (mark.start < pos) continue; // already inside an earlier annotation
    pushVisible(pos, mark.start);
    pos = mark.end;
  }
  pushVisible(pos, body.length);
  return { text, parts };
}

/** Every non-overlapping literal occurrence of `query`, left to right. */
export function findMatches(
  st: SearchText,
  query: string,
  caseSensitive = false,
  limit = Number.POSITIVE_INFINITY,
): Match[] {
  if (!query) return [];
  const haystack = caseSensitive ? st.text : foldCase(st.text);
  const needle = caseSensitive ? query : foldCase(query);
  const out: Match[] = [];
  let i = haystack.indexOf(needle);
  while (i !== -1 && out.length < limit) {
    out.push({ start: i, end: i + needle.length });
    i = haystack.indexOf(needle, i + needle.length);
  }
  return out;
}

/** The raw ranges a match covers, one per visible run it spans. Annotations
 *  sitting between those runs are deliberately absent - they are not part of
 *  the match and must survive a replacement. */
export function rawRangesFor(st: SearchText, m: Match): RawRange[] {
  const out: RawRange[] = [];
  for (const p of st.parts) {
    const from = Math.max(m.start, p.d);
    const to = Math.min(m.end, p.d + p.len);
    if (to > from) out.push({ start: p.raw + (from - p.d), end: p.raw + (to - p.d) });
  }
  return out;
}

/** Replace exactly the given matches, leaving every other match - and every
 *  annotation - untouched. The replacement lands at the match's first visible
 *  character; annotations the match spanned are carried through unchanged. */
export function applyReplacements(
  body: string,
  st: SearchText,
  matches: Match[],
  replacement: string,
): string {
  const sorted = [...matches].sort((a, b) => a.start - b.start);
  const out: string[] = [];
  let cursor = 0;
  for (const m of sorted) {
    const ranges = rawRangesFor(st, m);
    if (ranges.length === 0 || ranges[0].start < cursor) continue;
    out.push(body.slice(cursor, ranges[0].start));
    out.push(replacement);
    // Hidden annotations between the visible runs the match spanned.
    for (let k = 1; k < ranges.length; k++)
      out.push(body.slice(ranges[k - 1].end, ranges[k].start));
    cursor = ranges[ranges.length - 1].end;
  }
  out.push(body.slice(cursor));
  return out.join("");
}

/** The match shown in the prose around it, clipped to its own line so a result
 *  row never runs across a speaker turn. Whitespace is preserved verbatim -
 *  seeing that a replacement leaves a double space is the point. */
export interface MatchContext {
  before: string;
  matched: string;
  after: string;
  /** Context was clipped at `pad`, so the row should show an ellipsis. */
  clippedBefore: boolean;
  clippedAfter: boolean;
}

export function matchContext(st: SearchText, m: Match, pad = 80): MatchContext {
  const lineStart = st.text.lastIndexOf("\n", m.start - 1) + 1;
  const nextBreak = st.text.indexOf("\n", m.end);
  const lineEnd = nextBreak === -1 ? st.text.length : nextBreak;
  const from = Math.max(lineStart, m.start - pad);
  const to = Math.min(lineEnd, m.end + pad);
  return {
    before: st.text.slice(from, m.start),
    matched: st.text.slice(m.start, m.end),
    after: st.text.slice(m.end, to),
    clippedBefore: from > lineStart,
    clippedAfter: to < lineEnd,
  };
}
