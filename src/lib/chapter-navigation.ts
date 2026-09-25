import yaml from "js-yaml";

export interface ChapterSection {
  markerLine: number;
  headingLine: number | null;
  number: string | null;
  title: string | null;
  /** The actual printed heading, only when it names this section. */
  printedHeading: string | null;
  label: string;
}

const CHAPTER_MARKER = /^\s*<!--\s*(chapter|chapter_title):\s*(.*?)\s*-->\s*$/;
const INLINE_ANNOTATION = /\{\{[^{}\n]*\}\}/g;

function headingOn(line: string, title: string | null): string | null {
  const visible = line.replace(INLINE_ANNOTATION, "").trim();
  const heading = visible.match(/^#{1,6}\s+(.+)$/)?.[1] ?? visible.match(/^\*\*(.+)\*\*$/)?.[1];
  if (!heading || !title || !heading.toLocaleLowerCase().includes(title.toLocaleLowerCase())) {
    return null;
  }
  return heading.trim();
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
    sections.push({
      markerLine,
      headingLine,
      number,
      title,
      printedHeading: headingLine === null ? null : headingOn(lines[headingLine], title),
      label: number ? `Chapter ${number}${title ? `: ${title}` : ""}` : title ?? "Section",
    });
    pending = null;
  };

  for (let line = 0; line < lines.length; line++) {
    const text = lines[line].trim();
    const marker = text.match(CHAPTER_MARKER);
    if (marker) {
      if (!pending) pending = { markerLine: line, number: null, title: null };
      try {
        const value = yaml.load(marker[2]);
        if (value !== null && value !== undefined) {
          if (marker[1] === "chapter") pending.number = String(value);
          else pending.title = String(value);
        }
      } catch {
        // A broken section label stays reviewable in the raw ingest.
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
