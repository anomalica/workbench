// A READ-ONLY plain rendering of a record's body, for showing the ingest beside
// the digest output.
//
// The Digests view has to show the WHOLE ingest, not the fragments the models
// chose to quote. That is the point: the audit's passages are built from claims,
// so source that produced no claim is invisible there - and "what did the models
// miss?" is unanswerable from the claims alone. The ingest pane is the control.
//
// This is deliberately not ReadableText: that carries coverage marking, image
// captions and a DocumentStore, none of which belong in a view you cannot edit.

/** One readable line of the ingest. `speaker` is set only for transcript turns. */
export interface PlainLine {
  speaker?: string;
  text: string;
  /** Seconds, when the line carried a timestamp - lets a caller line the ingest
   *  up with a claim's location. */
  start?: number;
}

const SPEAKER_RE = /^\[([^\]]+)\]:\s*(.*)$/;
const TIME_RE = /\{\{t:([\d.]+)\}\}/;

/** Strip inline annotation markers so the prose reads as prose: timestamps,
 *  highlight/note spans, and the `[...]` review markers. The MARKERS go; the
 *  words they wrap stay, since the reviewer is here to read the words. */
export function stripAnnotations(text: string): string {
  return text
    .replace(/\{\{(?:t:[\d.]+|highlight-(?:start|end):[^}]*|note-(?:start|end):[^}]*)\}\}/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** The body as readable lines. Transcript turns keep their speaker; prose keeps
 *  its paragraphs. Blank lines collapse. */
export function plainLines(body: string): PlainLine[] {
  const out: PlainLine[] = [];
  for (const raw of (body ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    const t = line.match(TIME_RE);
    const start = t ? Number(t[1]) : undefined;

    const m = line.match(SPEAKER_RE);
    if (m) {
      const text = stripAnnotations(m[2]);
      // A speaker line with no words after stripping is a turn marker, not
      // content - keep it, so a reader sees the turn happened.
      out.push({ speaker: m[1].trim(), text, ...(start !== undefined ? { start } : {}) });
      continue;
    }

    const text = stripAnnotations(line);
    if (!text) continue;
    out.push({ text, ...(start !== undefined ? { start } : {}) });
  }
  return out;
}

/** Rough word count of the readable body - the denominator for "how much of this
 *  did anything get pulled out of?". */
export function bodyWordCount(body: string): number {
  return plainLines(body).reduce(
    (n, l) => n + (l.text ? l.text.split(/\s+/).filter(Boolean).length : 0),
    0,
  );
}
