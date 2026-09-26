import yaml from "js-yaml";

export interface ChapterSection {
  markerLine: number;
  headingLine: number | null;
  number: string | null;
  title: string | null;
  /** Source-styled headings which print this section's structure. */
  sourceHeadings: Array<{ line: number; text: string }>;
  label: string;
}

const CHAPTER_MARKER = /^\s*<!--\s*(chapter|chapter_title):\s*(.*?)\s*-->\s*$/;
const INLINE_ANNOTATION = /\{\{[^{}\n]*\}\}/g;

function sourceHeadingOn(line: string): string | null {
  const visible = line.replace(INLINE_ANNOTATION, "").trim();
  const heading =
    visible.match(/^#{1,6}\s+(.+)$/)?.[1] ??
    visible.match(/^\*\*\*(.+)\*\*\*$/)?.[1] ??
    visible.match(/^\*\*(.+)\*\*$/)?.[1];
  return heading?.trim() ?? null;
}

function titleHeadingOn(line: string, title: string | null): string | null {
  const heading = sourceHeadingOn(line);
  if (!heading || !title || !heading.toLocaleLowerCase().includes(title.toLocaleLowerCase())) {
    return null;
  }
  return heading;
}

function markerValue(raw: string): string | null {
  try {
    const value = yaml.load(raw);
    return value === null || value === undefined ? null : String(value);
  } catch {
    return null;
  }
}

function nextNonBlank(lines: string[], after: number): number | null {
  for (let line = after + 1; line < lines.length; line++) {
    if (lines[line].trim()) return line;
  }
  return null;
}

/** Chapter identity comes from the ingest's source-derived section markers,
 *  not from guessing which bold paragraphs look like headings. A section's
 *  first real text line is the navigation anchor; comments and images before
 *  that line remain part of the section, not its heading. */
export function chapterSections(body: string): ChapterSection[] {
  const lines = body.split("\n");
  const sections: ChapterSection[] = [];
  let pending: { markerLine: number; number: string | null; title: string | null } | null = null;
  let inComment = false;

  const finish = (headingLine: number | null) => {
    if (!pending) return;
    const { markerLine, number, title } = pending;
    const printedHeading = headingLine === null ? null : titleHeadingOn(lines[headingLine], title);
    sections.push({
      markerLine,
      headingLine,
      number,
      title,
      sourceHeadings: printedHeading === null || headingLine === null
        ? []
        : [{ line: headingLine, text: printedHeading }],
      label: number ? `Chapter ${number}${title ? `: ${title}` : ""}` : title ?? "Section",
    });
    pending = null;
  };

  for (let line = 0; line < lines.length; line++) {
    const text = lines[line].trim();
    const marker = text.match(CHAPTER_MARKER);
    if (marker) {
      // Some Kindle books put the printed chapter number between the two
      // structural markers. Coalesce only that exact four-part sequence:
      // marker, matching source heading, title marker, matching source heading.
      // Looking only across blank lines prevents ordinary prose from being
      // pulled into the chapter label.
      if (marker[1] === "chapter" && !pending) {
        const number = markerValue(marker[2]);
        const numberLine = nextNonBlank(lines, line);
        const numberHeading = numberLine === null ? null : sourceHeadingOn(lines[numberLine]);
        const titleMarkerLine = numberLine === null ? null : nextNonBlank(lines, numberLine);
        const titleMarker = titleMarkerLine === null ? null : lines[titleMarkerLine].trim().match(CHAPTER_MARKER);
        const title = titleMarker?.[1] === "chapter_title" ? markerValue(titleMarker[2]) : null;
        const titleLine = titleMarkerLine === null ? null : nextNonBlank(lines, titleMarkerLine);
        const titleHeading = titleLine === null ? null : titleHeadingOn(lines[titleLine], title);
        if (
          number && numberLine !== null && numberHeading &&
          numberHeading.toLocaleLowerCase().replace(/\s+/g, " ") === `chapter ${number}`.toLocaleLowerCase() &&
          titleMarkerLine !== null && title && titleLine !== null && titleHeading &&
          titleHeading.toLocaleLowerCase().replace(/\s+/g, " ") ===
            title.toLocaleLowerCase().replace(/\s+/g, " ")
        ) {
          sections.push({
            markerLine: line,
            headingLine: numberLine,
            number,
            title,
            sourceHeadings: [
              { line: numberLine, text: numberHeading },
              { line: titleLine, text: titleHeading },
            ],
            label: `Chapter ${number}: ${title}`,
          });
          line = titleLine;
          continue;
        }
      }
      if (!pending) pending = { markerLine: line, number: null, title: null };
      const value = markerValue(marker[2]);
      if (value !== null) {
        if (marker[1] === "chapter") pending.number = value;
        else pending.title = value;
      }
      continue;
    }
    if (!pending || !text) continue;
    if (inComment) {
      if (text.includes("-->")) inComment = false;
      continue;
    }
    if (text.startsWith("<!--")) {
      inComment = !text.includes("-->");
      continue;
    }
    if (text.replace(INLINE_ANNOTATION, "").trim()) finish(line);
  }
  finish(null);
  return sections;
}
