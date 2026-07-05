/**
 * Block mapping for text-record review coverage.
 *
 * A text record (web, ebook) renders as markdown prose with no playback signal,
 * so coverage is marked explicitly: the reviewer selects blocks they have read.
 * A block is a run of consecutive non-blank source lines (markdown blocks are
 * blank-line separated). Each block carries its source line range so observed
 * blocks convert straight into the line spans the verification sidecar stores.
 *
 * The reviewable-unit count must match the digester gate's
 * `review_gate._content_line_numbers` exactly: a body line counts iff it is
 * non-blank AND its stripped form does not start with an HTML comment (`<!--`).
 * Counting plain non-blank lines would over-count annotation/comment lines and
 * disagree with the gate's recompute.
 */

import type { CoverageSpan } from "./coverage";
import { mergeSpans } from "./coverage";

export interface TextBlock {
  /** Sequential index among the emitted blocks. */
  index: number;
  /** 0-based inclusive source line range (into body.split("\n")). */
  lineFrom: number;
  lineTo: number;
  /** The block's verbatim source text. */
  source: string;
  /** Source line indices within the block that count as reviewable units.
   *  Empty for blocks inside an irrelevant region - they are excluded from
   *  extraction, so they are not reviewable content either. */
  contentLines: number[];
  /** True when the block sits inside an irrelevant region (between
   *  irrelevant:start/end markers). */
  irrelevant: boolean;
}

/** Flag every line that is part of an HTML comment - the opener, any
 *  continuation lines of a multi-line comment, and the closing `-->` line.
 *  A per-line `startsWith("<!--")` check is not enough: the canonical image
 *  annotation is a multi-line comment (`<!--` / `image:` / `  file: ...` /
 *  `-->`) whose middle and closing lines do not start with `<!--` and were
 *  wrongly counted as reviewable prose. Stateful, mirrors anomalica-common
 *  review_gate.comment_line_flags byte-for-byte. */
export function commentLineFlags(lines: string[]): boolean[] {
  const flags: boolean[] = [];
  let inComment = false;
  for (const line of lines) {
    if (inComment) {
      flags.push(true); // the closing line is still comment
      if (line.includes("-->")) inComment = false;
    } else if (line.trimStart().startsWith("<!--")) {
      flags.push(true);
      // Multi-line opener iff there is no `-->` after the `<!--` on this line.
      if (!line.trimStart().slice(4).includes("-->")) inComment = true;
    } else {
      flags.push(false);
    }
  }
  return flags;
}

/** A body line is a reviewable unit iff it is non-blank and is not part of an
 *  HTML comment. Mirrors review_gate._content_line_numbers. The comment test is
 *  stateful (multi-line comments), so callers pass the whole-body flags from
 *  {@link commentLineFlags}. */
export function isContentLine(line: string, isComment: boolean): boolean {
  return line.trim() !== "" && !isComment;
}

// Block-level irrelevant regions for prose records: whole blocks wrapped in
// marker comment lines. The text is never deleted - the digester strips the
// region before extraction. Non-nesting; multiple regions per body. The
// canonical form is `<!-- irrelevant: start -->` (record-format.md - the
// space makes it a YAML mapping); parsing tolerates a missing space.
const IRRELEVANT_START = /^<!--\s*irrelevant:\s*start\s*-->$/;
const IRRELEVANT_END = /^<!--\s*irrelevant:\s*end\s*-->$/;

export function isIrrelevantStart(line: string): boolean {
  return IRRELEVANT_START.test(line.trim());
}

export function isIrrelevantEnd(line: string): boolean {
  return IRRELEVANT_END.test(line.trim());
}

/** Split a record body (frontmatter already stripped) into blocks of
 *  consecutive non-blank lines. Irrelevant markers act as block boundaries
 *  and belong to no block; blocks between a marker pair carry
 *  `irrelevant: true` and no reviewable units. */
export function parseTextBlocks(body: string): TextBlock[] {
  const lines = body.split("\n");
  const comment = commentLineFlags(lines);
  const blocks: TextBlock[] = [];
  let i = 0;
  let index = 0;
  let inIrrelevant = false;
  while (i < lines.length) {
    if (lines[i].trim() === "") {
      i++;
      continue;
    }
    if (isIrrelevantStart(lines[i])) {
      inIrrelevant = true;
      i++;
      continue;
    }
    if (isIrrelevantEnd(lines[i])) {
      inIrrelevant = false;
      i++;
      continue;
    }
    const from = i;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !isIrrelevantStart(lines[i]) &&
      !isIrrelevantEnd(lines[i])
    ) {
      i++;
    }
    const to = i - 1;
    const contentLines: number[] = [];
    if (!inIrrelevant) {
      for (let j = from; j <= to; j++)
        if (isContentLine(lines[j], comment[j])) contentLines.push(j);
    }
    blocks.push({
      index: index++,
      lineFrom: from,
      lineTo: to,
      source: lines.slice(from, to + 1).join("\n"),
      contentLines,
      irrelevant: inIrrelevant,
    });
  }
  return blocks;
}

/** Wrap the inclusive line range in irrelevant markers, each on its own
 *  blank-line-separated annotation line (the canonical record-format.md
 *  layout). The range must be block-aligned (the caller passes block
 *  boundaries); the wrapped text itself is untouched. Returns the new body. */
export function markIrrelevantLines(body: string, lineFrom: number, lineTo: number): string {
  const lines = body.split("\n");
  lines.splice(lineTo + 1, 0, "", "<!-- irrelevant: end -->");
  lines.splice(lineFrom, 0, "<!-- irrelevant: start -->", "");
  return lines.join("\n");
}

/** Remove the marker pair enclosing `line` (any line inside the region),
 *  along with the blank spacer lines markIrrelevantLines added, restoring
 *  the pre-mark body exactly. Returns the new body plus the removed line
 *  indices (pre-removal coordinates) so callers can shift line-anchored
 *  coverage spans. The body comes back unchanged (removed: []) when no
 *  enclosing region exists. */
export function unmarkIrrelevantAt(
  body: string,
  line: number,
): { body: string; removed: number[] } {
  const lines = body.split("\n");
  let start = -1;
  for (let i = Math.min(line, lines.length - 1); i >= 0; i--) {
    if (isIrrelevantEnd(lines[i]) && i < line) return { body, removed: [] };
    if (isIrrelevantStart(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return { body, removed: [] };
  let end = -1;
  for (let i = Math.max(line, start + 1); i < lines.length; i++) {
    if (isIrrelevantEnd(lines[i])) {
      end = i;
      break;
    }
  }
  if (end === -1) return { body, removed: [] };
  // Delete from the highest index down so earlier splices don't shift later
  // ones. Adjacent spacer blanks are removed only where present, so a
  // hand-authored region without them unmarks cleanly too.
  const remove = [end];
  if (end - 1 > start && lines[end - 1].trim() === "") remove.push(end - 1);
  if (start + 1 < end && lines[start + 1].trim() === "") remove.push(start + 1);
  remove.push(start);
  const removed = [...new Set(remove)].sort((a, b) => b - a);
  for (const i of removed) lines.splice(i, 1);
  return { body: lines.join("\n"), removed: removed.reverse() };
}

/** Shift line spans down past removed lines (pre-removal coordinates).
 *  Removed lines are markers/spacers, never inside a coverage span. */
export function shiftSpansForRemoval(spans: CoverageSpan[], removed: number[]): CoverageSpan[] {
  return spans.map((s) => ({
    ...s,
    from: s.from - removed.filter((r) => r < s.from).length,
    to: s.to - removed.filter((r) => r < s.to).length,
  }));
}

/** Shift line spans to follow a marker insertion: two lines (marker +
 *  spacer) land before original line `lineFrom` and two more after original
 *  line `lineTo`. Keeps this session's read-coverage aligned with the
 *  edited body. */
export function shiftSpansForMark(
  spans: CoverageSpan[],
  lineFrom: number,
  lineTo: number,
): CoverageSpan[] {
  return spans.map((s) => {
    const shiftFrom = s.from >= lineFrom ? (s.from > lineTo ? 4 : 2) : 0;
    const shiftTo = s.to >= lineFrom ? (s.to > lineTo ? 4 : 2) : 0;
    return { ...s, from: s.from + shiftFrom, to: s.to + shiftTo };
  });
}

/** Normalise a block's source to compare against the frontmatter title:
 *  drop a leading markdown heading marker and surrounding emphasis. */
function headingText(source: string): string {
  return source
    .trim()
    .replace(/^#+\s*/, "")
    .replace(/^\*+\s*|\s*\*+$/g, "")
    .trim();
}

/** The leading blocks that just duplicate the frontmatter title - a heading
 *  matching `title` at the very top of the body, plus an immediately-following
 *  `*Published ...*` stamp. Used to suppress them from the reader display so
 *  the title (rendered separately as the document heading) never doubles.
 *  Guards to the LEADING block only: a matching heading deeper in the body is
 *  real content and is never suppressed. Structural blocks (page markers,
 *  annotations) above the title are skipped. */
export function leadingTitleBlocks(blocks: TextBlock[], title: string): Set<number> {
  const hide = new Set<number>();
  const target = title.trim().toLowerCase();
  if (!target) return hide;
  let matchedTitle = false;
  for (const b of blocks) {
    if (b.contentLines.length === 0) continue; // skip structural / annotation-only
    if (!matchedTitle) {
      if (headingText(b.source).toLowerCase() === target) {
        hide.add(b.index);
        matchedTitle = true;
        continue;
      }
      return hide; // first real content isn't the title - nothing to suppress
    }
    if (/^\*?\s*published\b/i.test(b.source.trim())) hide.add(b.index);
    break; // only the stamp immediately after the title
  }
  return hide;
}

/** The body with any leading title-duplicating block(s) removed. For
 *  render-only paths with no line-anchored coverage (the plain-prose
 *  fallback), where dropping lines is safe. */
export function bodyWithoutLeadingTitle(body: string, title: string): string {
  const blocks = parseTextBlocks(body);
  const hide = leadingTitleBlocks(blocks, title);
  if (hide.size === 0) return body;
  const drop = new Set<number>();
  for (const b of blocks) {
    if (!hide.has(b.index)) continue;
    for (let l = b.lineFrom; l <= b.lineTo; l++) drop.add(l);
  }
  return body
    .split("\n")
    .filter((_, i) => !drop.has(i))
    .join("\n")
    .replace(/^\n+/, "");
}

/** Total reviewable units across the whole body. */
export function totalUnits(blocks: TextBlock[]): number {
  return blocks.reduce((n, b) => n + b.contentLines.length, 0);
}

/** Line spans for the given observed block indices, merged. */
export function observedLineSpans(blocks: TextBlock[], observed: Set<number>): CoverageSpan[] {
  return mergeSpans(
    blocks.filter((b) => observed.has(b.index)).map((b) => ({ from: b.lineFrom, to: b.lineTo })),
  );
}

/** True if every line in `[from, to]` is covered by some span. */
function lineCovered(line: number, spans: CoverageSpan[]): boolean {
  return spans.some((s) => line >= s.from && line <= s.to);
}

/** Block indices whose every content line falls inside the given spans. Used to
 *  reflect prior committed coverage (and restore a draft) as covered blocks.
 *  Blocks with no content lines are never reported as covered. */
export function blocksCoveredBySpans(blocks: TextBlock[], spans: CoverageSpan[]): Set<number> {
  const merged = mergeSpans(spans);
  const out = new Set<number>();
  for (const b of blocks) {
    if (b.contentLines.length === 0) continue;
    if (b.contentLines.every((l) => lineCovered(l, merged))) out.add(b.index);
  }
  return out;
}

/** How many reviewable units fall inside the given line spans. */
export function unitsInSpans(blocks: TextBlock[], spans: CoverageSpan[]): number {
  const merged = mergeSpans(spans);
  let n = 0;
  for (const b of blocks) {
    for (const l of b.contentLines) if (lineCovered(l, merged)) n++;
  }
  return n;
}
