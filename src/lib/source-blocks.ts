/**
 * Reading the pre-digest as STRUCTURE rather than as a wall of text.
 *
 * The pre-digest is what the model reads, and it carries the record's
 * annotations inline: who is speaking, where a page turns, what an image
 * showed. Rendered as markdown those became invisible (an HTML comment is not
 * displayed); rendered as plain text - which is what made the extraction spans
 * clickable - they became litter, `<!-- speaker: Chris Ramsay -->` interrupting
 * every few sentences of dialogue.
 *
 * Neither is right. An annotation is not noise to hide and not prose to read:
 * it is structure, and a transcript without its speaker changes is a
 * misattribution waiting to happen - the same failure the message-boundary work
 * exists to prevent. So the body is parsed into blocks, each rendered as what it
 * is, with the prose kept as a single continuous string so claim coverage can be
 * measured across it without the annotations shifting every offset.
 */

export type SourceBlock =
  | { kind: "speaker"; label: string }
  | { kind: "page"; label: string }
  | { kind: "chapter"; label: string }
  | { kind: "note"; label: string }
  /** `start`/`end` index into the prose string returned alongside the blocks. */
  | { kind: "prose"; text: string; start: number; end: number };

const ANNOTATION = /<!--\s*([\s\S]*?)\s*-->/g;

function classify(inner: string): SourceBlock {
  const [head, ...rest] = inner.split(":");
  const key = head.trim().toLowerCase();
  const value = rest.join(":").trim();
  if (key === "speaker") return { kind: "speaker", label: value || "Unknown speaker" };
  if (key === "printed_page" || key === "file_page")
    return { kind: "page", label: `Page ${value}` };
  if (key === "chapter" || key === "chapter_title")
    return { kind: "chapter", label: value || "Chapter" };
  // image / redacted / message / anything unrecognised: shown, not hidden. A
  // marker the reader cannot see is one they cannot question.
  return { kind: "note", label: inner.replace(/\s+/g, " ").trim() };
}

/** Split the pre-digest into rendered blocks plus the continuous prose the
 *  blocks' text came from. Prose offsets index into that string, so coverage
 *  computed once over the whole record still lines up per block. */
export function parseSourceBlocks(raw: string): { blocks: SourceBlock[]; prose: string } {
  const blocks: SourceBlock[] = [];
  let prose = "";
  let last = 0;

  const pushProse = (chunk: string) => {
    const text = chunk.replace(/\s+/g, " ").trim();
    if (!text) return;
    const start = prose.length ? prose.length + 1 : 0;
    prose = prose ? `${prose} ${text}` : text;
    blocks.push({ kind: "prose", text, start, end: start + text.length });
  };

  ANNOTATION.lastIndex = 0;
  for (let m = ANNOTATION.exec(raw); m; m = ANNOTATION.exec(raw)) {
    pushProse(raw.slice(last, m.index));
    blocks.push(classify(m[1]));
    last = m.index + m[0].length;
  }
  pushProse(raw.slice(last));
  return { blocks, prose };
}
