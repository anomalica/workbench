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
  /** Source line indices within the block that count as reviewable units. */
  contentLines: number[];
}

/** A body line is a reviewable unit iff it is non-blank and is not an HTML
 *  comment line. Mirrors review_gate._content_line_numbers (review_gate.py:58). */
export function isContentLine(line: string): boolean {
  const s = line.trim();
  return s !== "" && !s.startsWith("<!--");
}

/** Split a record body (frontmatter already stripped) into blocks of
 *  consecutive non-blank lines. */
export function parseTextBlocks(body: string): TextBlock[] {
  const lines = body.split("\n");
  const blocks: TextBlock[] = [];
  let i = 0;
  let index = 0;
  while (i < lines.length) {
    if (lines[i].trim() === "") {
      i++;
      continue;
    }
    const from = i;
    while (i < lines.length && lines[i].trim() !== "") i++;
    const to = i - 1;
    const contentLines: number[] = [];
    for (let j = from; j <= to; j++) if (isContentLine(lines[j])) contentLines.push(j);
    blocks.push({
      index: index++,
      lineFrom: from,
      lineTo: to,
      source: lines.slice(from, to + 1).join("\n"),
      contentLines,
    });
  }
  return blocks;
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
