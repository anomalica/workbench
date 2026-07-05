/**
 * "Mark as caption": move a block of loose prose beneath a figure INTO the
 * `caption` field of the nearest preceding structured image annotation.
 *
 * Why it matters (record-format.md#image, ADR 0042): a source's printed
 * caption often carries a copyright / attribution line, and the pre-digest
 * strips the whole image annotation before extraction - so a caption
 * structured ON the image never reaches the model as a factual claim, but
 * the same text left as loose prose would. This is the manual fallback for
 * when the ingester can't auto-detect the caption.
 *
 * The image annotation grammar is the mapping form:
 *   <!--
 *   image:
 *     file: abc123def456.jpg
 *     alt: "..."
 *     caption: "..."
 *   -->
 * Caption attaches only to that form (an image with a `file`); the
 * description-only scalar form has no fields to hold it.
 */

import yaml from "js-yaml";
import type { CoverageSpan } from "./coverage";

interface CommentBlock {
  /** Line index of the opening `<!--`. */
  from: number;
  /** Line index of the closing `-->`. */
  to: number;
  /** YAML source between the fences (excludes the `<!--`/`-->` lines). */
  inner: string;
}

/** Every HTML-comment annotation block in the body, single- or multi-line. */
function scanCommentBlocks(lines: string[]): CommentBlock[] {
  const blocks: CommentBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.length > 6 && t.startsWith("<!--") && t.endsWith("-->")) {
      blocks.push({ from: i, to: i, inner: t.slice(4, -3).trim() });
    } else if (t === "<!--") {
      const inner: string[] = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== "-->") {
        inner.push(lines[j]);
        j++;
      }
      if (j < lines.length) {
        blocks.push({ from: i, to: j, inner: inner.join("\n") });
        i = j;
      }
    }
  }
  return blocks;
}

export interface ImageAnnotation {
  from: number;
  to: number;
  /** Parsed annotation: `{ image: { file, alt?, caption?, ... } }`. */
  data: { image: Record<string, unknown> };
}

/** The mapping-form image annotations (those with a `file`), by line. */
function imageAnnotations(lines: string[]): ImageAnnotation[] {
  const out: ImageAnnotation[] = [];
  for (const b of scanCommentBlocks(lines)) {
    let data: unknown;
    try {
      data = yaml.load(b.inner);
    } catch {
      continue;
    }
    if (
      data &&
      typeof data === "object" &&
      "image" in data &&
      data.image &&
      typeof data.image === "object" &&
      !Array.isArray(data.image) &&
      typeof (data.image as Record<string, unknown>).file === "string"
    ) {
      out.push({ from: b.from, to: b.to, data: data as ImageAnnotation["data"] });
    }
  }
  return out;
}

/** The image annotation whose closing fence precedes `line`, nearest first. */
function nearestPrecedingImage(lines: string[], line: number): ImageAnnotation | null {
  let best: ImageAnnotation | null = null;
  for (const a of imageAnnotations(lines)) {
    if (a.to < line && (!best || a.to > best.to)) best = a;
  }
  return best;
}

/** Whether a block starting at `line` has an image annotation above it to
 *  attach a caption to. Drives the "Mark as caption" affordance. */
export function hasPrecedingImage(body: string, line: number): boolean {
  return nearestPrecedingImage(body.split("\n"), line) !== null;
}

/** Strip markdown emphasis markers, keeping the inner text. The caption is
 *  stored as plain-text metadata, not markdown, so the body's italic/bold
 *  markup (whole-caption or just around an attribution line) is not part of
 *  the printed caption. Balanced runs only; a stray marker is left intact. */
function stripInlineEmphasis(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1");
}

/** The caption text for the selected line range: non-blank lines joined
 *  (a soft-wrapped paragraph is one caption), whitespace collapsed, markdown
 *  emphasis stripped. */
function extractCaption(lines: string[], from: number, to: number): string {
  const text = lines
    .slice(from, to + 1)
    .filter((l) => l.trim() !== "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return stripInlineEmphasis(text).trim();
}

/** The indentation of the annotation's sub-fields (`  file:` etc.). */
function fieldIndent(lines: string[], img: ImageAnnotation): string {
  for (let i = img.from + 1; i < img.to; i++) {
    const m = lines[i].match(/^(\s+)\S/);
    if (m && lines[i].trim() !== "image:") return m[1];
  }
  return "  ";
}

export interface CaptionEdit {
  ok: boolean;
  body: string;
  /** old-line-index -> new-line-index, or -1 for a removed line. Length is
   *  the OLD line count; inserted lines have no entry. Feed to remapSpans. */
  oldToNew: number[];
  /** The `file` of the image the caption now sits on (the re-target key). */
  imageFile?: string;
}

/** The line index of `field:` within an annotation, or -1. */
function findFieldLine(lines: string[], img: ImageAnnotation, field: string): number {
  const re = new RegExp(`^\\s*${field}\\s*:`);
  for (let i = img.from + 1; i < img.to; i++) {
    if (re.test(lines[i])) return i;
  }
  return -1;
}

/** The `caption:` field line index within an annotation, or -1. */
function findCaptionLine(lines: string[], img: ImageAnnotation): number {
  return findFieldLine(lines, img, "caption");
}

function captionLineFor(lines: string[], img: ImageAnnotation, caption: string): string {
  return (
    fieldIndent(lines, img) +
    yaml.dump({ caption }, { forceQuotes: true, quotingType: '"', lineWidth: -1 }).trimEnd()
  );
}

/** Move the selected block(s) into the nearest preceding image annotation's
 *  `caption` field (replacing an existing caption if present). The prose is
 *  removed from the body - it now lives on the image, where the pre-digest
 *  strips it. Returns ok:false (body unchanged) when no image precedes the
 *  selection or the selection is empty. */
export function markAsCaption(body: string, lineFrom: number, lineTo: number): CaptionEdit {
  const lines = body.split("\n");
  // Never caption an annotation block: its lines start an HTML comment, and
  // moving that markup into another image's caption produces garbage.
  if (lines[lineFrom]?.trimStart().startsWith("<!--")) return { ok: false, body, oldToNew: [] };
  const img = nearestPrecedingImage(lines, lineFrom);
  if (!img) return { ok: false, body, oldToNew: [] };

  const caption = extractCaption(lines, lineFrom, lineTo);
  if (!caption) return { ok: false, body, oldToNew: [] };

  const captionLine = captionLineFor(lines, img, caption);
  // Re-caption in place if the annotation already carries one.
  const existingCaption = findCaptionLine(lines, img);

  // Remove the caption block, swallowing one adjacent blank so the edit
  // doesn't leave a double blank where the prose used to be.
  let removeFrom = lineFrom;
  let removeTo = lineTo;
  if (removeTo + 1 < lines.length && lines[removeTo + 1].trim() === "") removeTo += 1;
  else if (removeFrom - 1 >= 0 && lines[removeFrom - 1].trim() === "") removeFrom -= 1;

  const newLines: string[] = [];
  const oldToNew: number[] = new Array(lines.length).fill(-1);
  for (let i = 0; i < lines.length; i++) {
    if (i >= removeFrom && i <= removeTo) continue; // caption prose: removed
    if (existingCaption >= 0 && i === existingCaption) {
      oldToNew[i] = newLines.length;
      newLines.push(captionLine);
    } else if (existingCaption < 0 && i === img.to) {
      newLines.push(captionLine); // inserted before the closing fence
      oldToNew[i] = newLines.length;
      newLines.push(lines[i]);
    } else {
      oldToNew[i] = newLines.length;
      newLines.push(lines[i]);
    }
  }

  return {
    ok: true,
    body: newLines.join("\n"),
    oldToNew,
    imageFile: img.data.image.file as string,
  };
}

/** The `file` of every structured image annotation in the body, in order.
 *  For the re-target picker and for tests. */
export function imageFilesInBody(body: string): string[] {
  return imageAnnotations(body.split("\n")).map((a) => a.data.image.file as string);
}

/** Move an already-structured caption from the image with `fromFile` to the
 *  image with `toFile` (the reviewer's override when nearest-preceding
 *  guessed wrong). Clears the source image's caption and sets it on the
 *  target, replacing any caption the target already had. No-op (ok:false)
 *  when either image is missing, they are the same, or the source has no
 *  caption to move. */
export function moveCaptionByFile(body: string, fromFile: string, toFile: string): CaptionEdit {
  if (!fromFile || !toFile || fromFile === toFile) return { ok: false, body, oldToNew: [] };
  const lines = body.split("\n");
  const imgs = imageAnnotations(lines);
  const from = imgs.find((a) => a.data.image.file === fromFile);
  const to = imgs.find((a) => a.data.image.file === toFile);
  if (!from || !to) return { ok: false, body, oldToNew: [] };
  const caption = from.data.image.caption;
  if (typeof caption !== "string") return { ok: false, body, oldToNew: [] };

  const fromCap = findCaptionLine(lines, from);
  const toCap = findCaptionLine(lines, to);
  const captionLine = captionLineFor(lines, to, caption);

  const newLines: string[] = [];
  const oldToNew: number[] = new Array(lines.length).fill(-1);
  for (let i = 0; i < lines.length; i++) {
    if (i === fromCap) continue; // drop the source caption line
    if (toCap >= 0 && i === toCap) {
      oldToNew[i] = newLines.length;
      newLines.push(captionLine); // replace the target's existing caption
    } else if (toCap < 0 && i === to.to) {
      newLines.push(captionLine); // insert before the target's closing fence
      oldToNew[i] = newLines.length;
      newLines.push(lines[i]);
    } else {
      oldToNew[i] = newLines.length;
      newLines.push(lines[i]);
    }
  }
  return { ok: true, body: newLines.join("\n"), oldToNew, imageFile: toFile };
}

/** True if the image annotation with `file` carries `irrelevant: true` (the
 *  display-only drop flag). Absent = keep/relevant. */
export function imageIsIrrelevant(body: string, file: string): boolean {
  const img = imageAnnotations(body.split("\n")).find((a) => a.data.image.file === file);
  return img?.data.image.irrelevant === true;
}

/** Set or clear `irrelevant: true` on the image annotation with `file`. This is
 *  DISPLAY-only metadata the assembler/site reads to drop the image from the
 *  rendered page (record-format.md#image); it never touches read-coverage
 *  (image annotations are structural, zero units) or extraction (the pre-digest
 *  strips every image annotation). Clearing removes the line, so absent = keep.
 *  No-op (ok:false) when the image is missing or already in the target state. */
export function setImageRelevanceByFile(
  body: string,
  file: string,
  irrelevant: boolean,
): CaptionEdit {
  const lines = body.split("\n");
  const img = imageAnnotations(lines).find((a) => a.data.image.file === file);
  if (!img) return { ok: false, body, oldToNew: [] };
  const existing = findFieldLine(lines, img, "irrelevant");
  const already = img.data.image.irrelevant === true;
  if (irrelevant === already) return { ok: false, body, oldToNew: [] };

  const flagLine = fieldIndent(lines, img) + "irrelevant: true";
  const newLines: string[] = [];
  const oldToNew: number[] = new Array(lines.length).fill(-1);
  for (let i = 0; i < lines.length; i++) {
    if (!irrelevant && i === existing) continue; // clearing: drop the flag line
    if (irrelevant && existing < 0 && i === img.to) {
      newLines.push(flagLine); // set: insert before the closing fence
      oldToNew[i] = newLines.length;
      newLines.push(lines[i]);
    } else if (irrelevant && i === existing) {
      oldToNew[i] = newLines.length;
      newLines.push(flagLine); // set: normalise an existing (e.g. false) line
    } else {
      oldToNew[i] = newLines.length;
      newLines.push(lines[i]);
    }
  }
  return { ok: true, body: newLines.join("\n"), oldToNew, imageFile: file };
}

/** Shift line-anchored coverage spans through an oldToNew line map: a span's
 *  start moves to the first surviving line at or after it, its end to the
 *  last surviving line at or before it; a span whose lines all vanished is
 *  dropped. */
export function remapSpans(spans: CoverageSpan[], oldToNew: number[]): CoverageSpan[] {
  const out: CoverageSpan[] = [];
  for (const s of spans) {
    let from = -1;
    for (let l = Math.max(0, s.from); l < oldToNew.length; l++) {
      if (oldToNew[l] >= 0) {
        from = oldToNew[l];
        break;
      }
    }
    let to = -1;
    for (let l = Math.min(s.to, oldToNew.length - 1); l >= 0; l--) {
      if (oldToNew[l] >= 0) {
        to = oldToNew[l];
        break;
      }
    }
    if (from >= 0 && to >= 0 && from <= to) out.push({ ...s, from, to });
  }
  return out;
}
