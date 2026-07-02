/**
 * Relevance-tuning highlights: span logic for the tuning-mode page.
 *
 * The sidecar contract (anomalica/highlights/1) indexes spans by Unicode
 * CODE POINTS into the raw stored body. JS strings index UTF-16 code units,
 * which diverge on astral characters, so the UI works in UTF-16 throughout
 * and converts at the API boundary (loadSpans/saveSpans).
 *
 * The page never shows the raw body. It renders a pre-processed readable
 * view (buildDisplay): annotation comments become non-selectable speaker
 * labels or vanish, word-timing tokens and line timecodes vanish, and the
 * remaining prose is merged into a few large segments - one element per
 * speaker turn, not one per word. (Rendering a chunk per word froze the
 * tab on long word-timed records: the browser recalculates the selection
 * across tens of thousands of inline elements during the drag.) Each
 * segment carries a piecewise map from display offsets back to raw-body
 * offsets, so saved spans still index the raw body exactly.
 *
 * Spec: anomalica/decisions/drafts/relevance-tuning-mode.md.
 */

/** A span in UTF-16 code units (UI-internal representation). */
export interface UiSpan {
  start: number;
  end: number;
  text: string;
  note?: string;
}

/** A span as stored in the sidecar (Unicode code points). */
export interface WireSpan {
  start: number;
  end: number;
  text: string;
  note?: string;
}

/** Convert a UTF-16 index into a code-point index. */
export function utf16ToCodePoint(body: string, utf16Index: number): number {
  let cp = 0;
  for (let i = 0; i < utf16Index && i < body.length; i++) {
    const code = body.charCodeAt(i);
    // Skip the low half of a surrogate pair (counted with its high half).
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    cp++;
  }
  return cp;
}

/** Convert a code-point index into a UTF-16 index. */
export function codePointToUtf16(body: string, cpIndex: number): number {
  let cp = 0;
  let i = 0;
  while (i < body.length && cp < cpIndex) {
    const code = body.charCodeAt(i);
    i += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
    cp++;
  }
  return i;
}

/** Sidecar (code-point) spans to UI (UTF-16) spans. */
export function loadSpans(body: string, spans: WireSpan[]): UiSpan[] {
  return spans.map((s) => {
    const start = codePointToUtf16(body, s.start ?? 0);
    const end = codePointToUtf16(body, s.end ?? 0);
    return { ...s, start, end, text: body.slice(start, end) };
  });
}

/** UI (UTF-16) spans to sidecar (code-point) spans. */
export function saveSpans(body: string, spans: UiSpan[]): WireSpan[] {
  return spans.map((s) => {
    const out: WireSpan = {
      start: utf16ToCodePoint(body, s.start),
      end: utf16ToCodePoint(body, s.end),
      text: body.slice(s.start, s.end),
    };
    if (s.note) out.note = s.note;
    return out;
  });
}

/** Trim a selection to non-whitespace content. Returns null if nothing left. */
export function trimSpan(body: string, start: number, end: number): UiSpan | null {
  while (start < end && /\s/.test(body[start])) start++;
  while (end > start && /\s/.test(body[end - 1])) end--;
  if (start >= end) return null;
  return { start, end, text: body.slice(start, end) };
}

/** Insert a new span, merging any existing spans it touches into one.
 *  The merged span keeps the first non-empty note among the merged. */
export function addSpan(body: string, spans: UiSpan[], next: UiSpan): UiSpan[] {
  let { start, end } = next;
  let note = next.note;
  const kept: UiSpan[] = [];
  for (const s of spans) {
    if (s.end < start || s.start > end) {
      kept.push(s);
    } else {
      start = Math.min(start, s.start);
      end = Math.max(end, s.end);
      if (!note && s.note) note = s.note;
    }
  }
  const merged: UiSpan = { start, end, text: body.slice(start, end) };
  if (note) merged.note = note;
  kept.push(merged);
  kept.sort((a, b) => a.start - b.start || a.end - b.end);
  return kept;
}

/** Re-anchor spans from an older body onto the current one by exact text
 *  search (nearest occurrence to the original offset wins). Spans whose
 *  text no longer occurs are returned in `lost`. */
export function reanchorSpans(
  body: string,
  spans: UiSpan[],
): { anchored: UiSpan[]; lost: UiSpan[] } {
  const anchored: UiSpan[] = [];
  const lost: UiSpan[] = [];
  for (const s of spans) {
    const positions: number[] = [];
    let idx = body.indexOf(s.text);
    while (idx !== -1) {
      positions.push(idx);
      idx = body.indexOf(s.text, idx + 1);
    }
    if (positions.length === 0) {
      lost.push(s);
      continue;
    }
    let best = positions[0];
    for (const p of positions) {
      if (Math.abs(p - s.start) < Math.abs(best - s.start)) best = p;
    }
    const span: UiSpan = { start: best, end: best + s.text.length, text: s.text };
    if (s.note) span.note = s.note;
    anchored.push(span);
  }
  let merged: UiSpan[] = [];
  for (const s of anchored.sort((a, b) => a.start - b.start || a.end - b.end)) {
    merged = addSpan(body, merged, s);
  }
  return { anchored: merged, lost };
}

/** Fraction of a span's characters that fall inside any of the given spans. */
export function overlapFraction(span: UiSpan, spans: UiSpan[]): number {
  const length = span.end - span.start;
  if (length <= 0) return 0;
  let covered = 0;
  for (const s of spans) {
    covered += Math.max(0, Math.min(span.end, s.end) - Math.max(span.start, s.start));
  }
  return Math.min(1, covered / length);
}

// --- readable display model --------------------------------------------------

/** One visible slice of a text segment: `len` chars starting at display
 *  offset `d` within the segment, coming from raw offset `raw`. */
export interface SegPart {
  d: number;
  raw: number;
  len: number;
}

/** A block of the readable view: prose (selectable, offset-mapped) or a
 *  speaker label (decorative, never selectable). */
export interface DisplaySegment {
  kind: "text" | "label";
  index: number;
  /** Speaker name for kind=label. */
  label?: string;
  /** Concatenated visible text for kind=text ("" for labels). */
  text: string;
  parts: SegPart[];
  rawStart: number;
  rawEnd: number;
}

const WORD_TIMING = /\{\{t:[0-9.]+\}\}/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
// An annotation fence: a line of ---, its YAML lines, and the closing ---.
const ANNOTATION_FENCE = /^---\n[\s\S]*?\n---$/gm;
// A sentence-level timecode prefixing a transcript line, e.g. "00:01:24.1 ".
const LINE_TIMECODE = /^\d{2}:\d{2}:\d{2}(?:\.\d+)?[ \t]/gm;

const SPEAKER_IN_COMMENT = /speaker:\s*(.+?)\s*(?:\n|-->)/;

/** Build the readable view: prose merged into large segments with a
 *  display->raw offset map; annotations hidden or turned into labels. */
export function buildDisplay(body: string): DisplaySegment[] {
  const marks: Array<{ start: number; end: number; label?: string }> = [];
  for (const re of [HTML_COMMENT, ANNOTATION_FENCE, WORD_TIMING, LINE_TIMECODE]) {
    re.lastIndex = 0;
    for (const m of body.matchAll(re)) {
      const mark: { start: number; end: number; label?: string } = {
        start: m.index,
        end: m.index + m[0].length,
      };
      if (re === HTML_COMMENT) {
        const speaker = m[0].match(SPEAKER_IN_COMMENT);
        if (speaker) mark.label = speaker[1];
      }
      marks.push(mark);
    }
  }
  marks.sort((a, b) => a.start - b.start || a.end - b.end);

  const segments: DisplaySegment[] = [];
  let parts: SegPart[] = [];
  let text = "";

  const flushText = () => {
    if (parts.length === 0) return;
    segments.push({
      kind: "text",
      index: segments.length,
      text,
      parts,
      rawStart: parts[0].raw,
      rawEnd: parts[parts.length - 1].raw + parts[parts.length - 1].len,
    });
    parts = [];
    text = "";
  };
  const pushVisible = (from: number, to: number) => {
    if (to <= from) return;
    parts.push({ d: text.length, raw: from, len: to - from });
    text += body.slice(from, to);
  };

  let pos = 0;
  for (const mark of marks) {
    if (mark.start < pos) continue; // nested/overlapping match already covered
    pushVisible(pos, mark.start);
    if (mark.label) {
      flushText();
      segments.push({
        kind: "label",
        index: segments.length,
        label: mark.label,
        text: "",
        parts: [],
        rawStart: mark.start,
        rawEnd: mark.end,
      });
    }
    pos = mark.end;
  }
  pushVisible(pos, body.length);
  flushText();
  return segments;
}

/** Map a display offset within a segment to a raw-body offset. At a hidden
 *  gap boundary, `start` bias rounds forward past the gap and `end` bias
 *  rounds backward, so spans never begin or end inside hidden text. */
export function displayToRaw(seg: DisplaySegment, d: number, bias: "start" | "end"): number {
  const parts = seg.parts;
  if (parts.length === 0) return seg.rawStart;
  if (d <= 0) return parts[0].raw;
  const last = parts[parts.length - 1];
  if (d >= last.d + last.len) return last.raw + last.len;
  if (bias === "start") {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (d >= p.d && d <= p.d + p.len) return p.raw + (d - p.d);
    }
  } else {
    for (const p of parts) {
      if (d >= p.d && d <= p.d + p.len) return p.raw + (d - p.d);
    }
  }
  return seg.rawStart;
}

/** Map a raw-body offset to a display offset within a segment (clamped).
 *  Raw offsets inside hidden gaps round forward (`start`) or backward
 *  (`end`) to the nearest visible character. */
export function rawToDisplay(seg: DisplaySegment, raw: number, bias: "start" | "end"): number {
  const parts = seg.parts;
  if (parts.length === 0) return 0;
  if (raw <= parts[0].raw) return 0;
  const last = parts[parts.length - 1];
  if (raw >= last.raw + last.len) return last.d + last.len;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (raw >= p.raw && raw <= p.raw + p.len) return p.d + (raw - p.raw);
    const next = parts[i + 1];
    if (next && raw > p.raw + p.len && raw < next.raw) {
      return bias === "start" ? next.d : p.d + p.len;
    }
  }
  return 0;
}

/** A slice of a text segment for rendering: either inside the highlight
 *  with the given span index, or plain (spanIndex -1). */
export interface SegChunk {
  d: number;
  text: string;
  spanIndex: number;
}

/** Split a text segment's display text at highlight boundaries. */
export function segmentChunks(seg: DisplaySegment, spans: UiSpan[]): SegChunk[] {
  if (seg.kind !== "text" || seg.text.length === 0) return [];
  const intervals: Array<{ from: number; to: number; spanIndex: number }> = [];
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    if (s.end <= seg.rawStart || s.start >= seg.rawEnd) continue;
    const from = rawToDisplay(seg, Math.max(s.start, seg.rawStart), "start");
    const to = rawToDisplay(seg, Math.min(s.end, seg.rawEnd), "end");
    if (from < to) intervals.push({ from, to, spanIndex: i });
  }
  if (intervals.length === 0) {
    return [{ d: 0, text: seg.text, spanIndex: -1 }];
  }
  const cuts = new Set<number>([0, seg.text.length]);
  for (const iv of intervals) {
    cuts.add(iv.from);
    cuts.add(iv.to);
  }
  const edges = [...cuts].sort((a, b) => a - b);
  const chunks: SegChunk[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const from = edges[i];
    const to = edges[i + 1];
    const hit = intervals.find((iv) => iv.from <= from && iv.to >= to);
    chunks.push({
      d: from,
      text: seg.text.slice(from, to),
      spanIndex: hit ? hit.spanIndex : -1,
    });
  }
  return chunks;
}

/** Strip annotation noise from a raw-body excerpt for sidebar display. */
export function cleanExcerpt(text: string, max = 90): string {
  const clean = text
    .replace(WORD_TIMING, "")
    .replace(HTML_COMMENT, "")
    .replace(/\d{2}:\d{2}:\d{2}(?:\.\d+)?[ \t]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
