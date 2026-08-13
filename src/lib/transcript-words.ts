/** A single timestamped word. `start` is absolute seconds from media start;
 *  `gIndex` is the word's position across the whole body (0-based). */
export interface Word {
  text: string;
  start: number;
  gIndex: number;
  /** Non-verbal event notes that FOLLOW this word - first-class annotation
   *  objects, not spoken words: no timestamp of their own, never tokenised or
   *  word-edited, rendered as distinct chips. Stored as the BARE inner text
   *  ("laughs", not "{{laughs}}"); the `{{ }}` are the on-disk notation that
   *  serializeWords adds back. Omitted when the word carries none. */
  notes?: string[];
}

/** A consecutive run of words owned by one speaker. `startWord`/`endWord` are
 *  inclusive global word indices. */
export interface SpeakerRun {
  speaker: string;
  startWord: number;
  endWord: number;
}

/** A reviewer highlight over an inclusive word range, keyed by its opaque id.
 *  In a word record a highlight always falls on word boundaries (it is authored
 *  from a word selection), so it is carried as `[fromWord, toWord]` rather than
 *  character offsets - which lets it ride through word edits by index remap, the
 *  way `lineEndWords` does. Serialised as the inline `{{highlight-start: id}}` /
 *  `{{highlight-end: id}}` marker pair. Overlap-capable: ranges may nest or
 *  cross, and the id keeps a close matched to its open. */
export interface WordHighlight {
  id: string;
  fromWord: number;
  toWord: number;
}

/** A reviewer span note over an inclusive word range, keyed by its opaque id and
 *  carrying free reviewer text ("what was on screen here", context over a
 *  period). It rides through parse/serialise/word-edits exactly like a
 *  `WordHighlight` - same paired-marker machinery, same overlap-by-id and orphan
 *  rules - but additionally carries `text`, which the digester preserves into
 *  the pre-digest as context (a highlight stays blind). Serialised as the marker
 *  pair `{{note-start: [id, "text"]}}` / `{{note-end: id}}`. Distinct from a
 *  point event-note (`{{laughs}}` on a single word's `notes`), which anchors to
 *  one word and is not a range. */
export interface WordSpanNote {
  id: string;
  fromWord: number;
  toWord: number;
  text: string;
}

/** A cross-record link: a reviewer-authored reference from an inclusive word
 *  range in THIS record to another record, pinned by the target's content_hash
 *  ("sha256:..."), optionally anchored to a verbatim quote from the target (the
 *  location is re-derived from the quote at render time, like a claim's - never
 *  authored as an offset). Third paired-marker type, same machinery as
 *  highlights and span notes: `{{link-start: [id, "sha256:...", "quote"?]}}` ...
 *  `{{link-end: id}}`. Ids share the record's single overlay id space. */
export interface WordLink {
  id: string;
  fromWord: number;
  toWord: number;
  target: string;
  quote?: string;
}

/** A context edge: `of` needs the earlier highlights in `needs` to be understood
 *  ("he said" -> who). One-directional and backwards by construction. An id in
 *  `needs` with no matching highlight is DANGLING and is kept, not dropped - the
 *  reviewer decides what to do with it (spec: retained + rendered unresolved). */
export interface HighlightContext {
  of: string;
  needs: string[];
}

export interface ParsedWords {
  words: Word[];
  runs: SpeakerRun[];
  /** gIndex of the last word on each original body line, so the line-break
   *  structure can be reproduced exactly on serialise. */
  lineEndWords: Set<number>;
  /** Reviewer highlights as inclusive word ranges, in start order. */
  highlights: WordHighlight[];
  /** Reviewer span notes as inclusive word ranges + text, in start order. */
  spanNotes: WordSpanNote[];
  /** Cross-record links as inclusive word ranges + target, in start order. */
  links: WordLink[];
  /** Context edges between highlights, in document order. */
  highlightContexts: HighlightContext[];
  /** Everything in the body before the first `<!-- speaker -->` comment (the
   *  title heading, published line, blank separators). Re-emitted verbatim so a
   *  reassign doesn't destroy the record's `# PWTS ...` title. */
  preamble: string;
}

import { isSpecialSpeaker } from "$lib/transcript";

// <!-- speaker: Name -->
const INLINE_SPEAKER = /^<!--\s*speaker:\s*(.+?)\s*-->$/;
// {{t:12.34}}text  -> capture the start seconds, then all text up to the next
// marker or end of line. The text may contain spaces: a reviewer can split a
// mis-recognised word into several words that share one timestamp, so a unit
// is not restricted to a single token.
const WORD_TOKEN = /\{\{t:(\d+(?:\.\d+)?)\}\}([\s\S]*?)(?=\{\{t:|$)/g;
// An inline reviewer note: `{{...}}` (keyless `{{laughs}}` or keyed
// `{{Fravor: holds up photo}}`). Reviewer-authored notes moved to the `{{...}}`
// family so they stop colliding with the `[...]` that real source text is full
// of - footnote refs `[^1]`, `[sic]`, editorial `[bracketed]` clarifications -
// which are now left as ordinary word content (record-format.md, ratified). The
// reserved `{{t:}}`, `{{highlight-*}}` and `{{note-start/end:}}` markers are
// consumed upstream, so any `{{...}}` reaching splitSegment is a keyed/keyless
// event note.
const NOTE_TOKEN = /\{\{([^{}]*)\}\}/g;
// Inline paired markers (reserved keys, machine-read, never authored notes). A
// start opens at the word whose `{{t:}}` follows it; an end closes at the word
// whose text precedes it. serializeWords glues them in exactly those positions.
// Highlights carry only an id; span notes additionally carry reviewer text on
// their START marker, as a YAML flow list `[id, "text"]` (flat - no nested
// braces to confuse the `}}` scan; text always double-quoted, so colons and
// other YAML-significant chars in it are safe). note-end carries the id only.
const HL_MARKER = /\{\{highlight-(start|end):\s*([A-Za-z0-9_-]+)\s*\}\}/g;
const NOTE_START_MARKER =
  /\{\{note-start:\s*\[\s*([A-Za-z0-9_-]+)\s*,\s*"((?:[^"\\]|\\.)*)"\s*\]\s*\}\}/g;
const NOTE_END_MARKER = /\{\{note-end:\s*([A-Za-z0-9_-]+)\s*\}\}/g;
// Cross-record links: start carries [id, "target"] or [id, "target", "quote"],
// both strings double-quoted with the same escaping as note text (flat list, no
// nested braces). link-end carries the id only.
const LINK_START_MARKER =
  /\{\{link-start:\s*\[\s*([A-Za-z0-9_-]+)\s*,\s*"((?:[^"\\]|\\.)*)"\s*(?:,\s*"((?:[^"\\]|\\.)*)"\s*)?\]\s*\}\}/g;
const LINK_END_MARKER = /\{\{link-end:\s*([A-Za-z0-9_-]+)\s*\}\}/g;
// {{highlight-context: [later, earlier, ...]}} - a STANDALONE annotation, not a
// payload on highlight-start (which stays a bare scalar id). First id is the
// highlight that NEEDS context; the rest are the earlier highlights it depends
// on. Position-independent: it references ids, so it survives body edits that
// move every word - the drift that broke word-index coverage spans cannot touch
// it. Strips with the highlights.
const HL_CONTEXT_MARKER =
  /\{\{highlight-context:\s*\[\s*([A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)*)\s*\]\s*\}\}/g;

/** A pulled paired-marker. `family` selects which resolver (highlight vs span
 *  note) it feeds; `text` is present only on a span-note start. */
interface SpanMarker {
  family: "hl" | "note" | "link";
  dir: "start" | "end";
  id: string;
  text?: string;
  target?: string;
  quote?: string;
}

/** Reverse the escaping escapeNoteText applies (\" -> ", \\ -> \). */
function unescapeNoteText(s: string): string {
  return s.replace(/\\(["\\])/g, "$1");
}

/** Escape reviewer note text for the double-quoted YAML scalar in a note-start
 *  marker. Braces are NOT handled here - they are stripped at author time
 *  (document state) because they would corrupt the `{{ }}` grammar itself. */
export function escapeNoteText(s: string): string {
  return s.replace(/([\\"])/g, "\\$1");
}

/** Pull highlight AND span-note markers out of a segment, returning the
 *  marker-free text and every pulled marker. Both families are stripped before
 *  the text reaches splitSegment, so a `{{note-start: ...}}` is never mistaken
 *  for a keyed event note. */
function extractSpanMarkers(s: string): { rest: string; markers: SpanMarker[] } {
  const markers: SpanMarker[] = [];
  let rest = s.replace(HL_MARKER, (_m, dir, id) => {
    markers.push({ family: "hl", dir, id });
    return "";
  });
  rest = rest.replace(NOTE_START_MARKER, (_m, id, text) => {
    markers.push({ family: "note", dir: "start", id, text: unescapeNoteText(text) });
    return "";
  });
  rest = rest.replace(NOTE_END_MARKER, (_m, id) => {
    markers.push({ family: "note", dir: "end", id });
    return "";
  });
  rest = rest.replace(LINK_START_MARKER, (_m, id, target, quote) => {
    markers.push({
      family: "link",
      dir: "start",
      id,
      target: unescapeNoteText(target),
      ...(quote !== undefined ? { quote: unescapeNoteText(quote) } : {}),
    });
    return "";
  });
  rest = rest.replace(LINK_END_MARKER, (_m, id) => {
    markers.push({ family: "link", dir: "end", id });
    return "";
  });
  return { rest, markers };
}

/** Split a `{{t:}}` segment's text into the spoken word and the `{{...}}` notes
 *  that follow it. `{{t:1.5}}had {{laughs}}` yields word "had" + note "laughs".
 *  The `{{ }}` are the on-disk NOTATION, not content: the INNER text is stored
 *  ("laughs", not "{{laughs}}"), and serializeWords wraps it back. A segment
 *  that is only `{{laughs}}` yields an empty word and the note, so it re-anchors
 *  onto the previous real word and sheds its stray timestamp. A `[...]` in the
 *  text is NOT a note - it stays as content (footnote refs, `[sic]`, etc.). */
function splitSegment(raw: string): { word: string; notes: string[] } {
  const notes: string[] = [];
  const word = raw
    .replace(NOTE_TOKEN, (_m, inner: string) => {
      const t = inner.trim();
      if (t) notes.push(t);
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();
  return { word, notes };
}

/** True if the body uses per-word timestamps (contains `{{t:` markers). */
export function hasWordTimestamps(body: string): boolean {
  return body.includes("{{t:");
}

/** Parse a per-word-timestamp body into words, speaker runs, the set of
 *  line-ending word indices, and the body preamble. The transcript region begins
 *  at the first `<!-- speaker -->` comment; everything before it is kept verbatim
 *  as the preamble. Lines that are neither a speaker comment nor a word line
 *  (blank separators) carry no words and are reconstructed from the run structure
 *  on serialise. A legacy `HH:MM:SS.D` line-start prefix, if present, is ignored
 *  (it sits before the first `{{t:}}`, so WORD_TOKEN never sees it) and dropped on
 *  the next serialise. */
export function parseWords(body: string): ParsedWords {
  const words: Word[] = [];
  const runs: SpeakerRun[] = [];
  const lineEndWords = new Set<number>();

  // Context edges reference IDS, not positions, so they are collected from the
  // whole body and stripped before the line scan - wherever the UI wrote them,
  // they mean the same thing, and the word tokeniser must never see them.
  const highlightContexts: HighlightContext[] = [];
  body = body.replace(HL_CONTEXT_MARKER, (_m, ids: string) => {
    const parts = ids
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    // A lone id names a dependent with no dependencies - meaningless, so drop it
    // rather than store an edge that says nothing.
    if (parts.length >= 2) highlightContexts.push({ of: parts[0], needs: parts.slice(1) });
    return "";
  });

  const rawLines = body.split("\n");
  const firstSpeakerLine = rawLines.findIndex((raw) => INLINE_SPEAKER.test(raw.trim()));
  // Preamble is everything before the first speaker comment, with the trailing
  // newline that separates it from that comment. A speaker comment on line 0
  // means there's nothing before it (empty preamble). No speaker comment at all
  // means no transcript region, so the whole body is preamble.
  let preamble = "";
  if (firstSpeakerLine < 0) preamble = body;
  else if (firstSpeakerLine > 0) preamble = `${rawLines.slice(0, firstSpeakerLine).join("\n")}\n`;

  let currentSpeaker = "";
  let gIndex = 0;

  // Paired-marker resolution state, threaded across lines within a speaker run.
  // Highlights and span notes share identical open/close/orphan logic, so one
  // resolver type serves both (one instance per family). `open` holds live spans
  // (id -> the word they opened on, plus any note text); a start waits in
  // `pending` until the next word is emitted (it opens THERE); an end closes the
  // current/last word. Anything still open at a speaker change or end of body
  // auto-closes on the run's last word.
  interface SpanPayload {
    text?: string;
    target?: string;
    quote?: string;
  }
  interface ResolvedSpan extends SpanPayload {
    id: string;
    fromWord: number;
    toWord: number;
  }
  interface SpanResolver {
    out: ResolvedSpan[];
    open: Map<string, { from: number } & SpanPayload>;
    pending: ({ id: string } & SpanPayload)[];
  }
  const mkResolver = (): SpanResolver => ({ out: [], open: new Map(), pending: [] });
  const hlR = mkResolver();
  const noteR = mkResolver();
  const linkR = mkResolver();
  let lastEmitted = -1;

  const payloadOf = ({ text, target, quote }: SpanPayload): SpanPayload => ({
    ...(text !== undefined ? { text } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(quote !== undefined ? { quote } : {}),
  });
  const openAt = (r: SpanResolver, id: string, g: number, payload: SpanPayload) => {
    const prev = r.open.get(id);
    if (prev && g - 1 >= prev.from)
      r.out.push({ id, fromWord: prev.from, toWord: g - 1, ...payloadOf(prev) });
    r.open.set(id, { from: g, ...payloadOf(payload) });
  };
  const closeAt = (r: SpanResolver, id: string, g: number) => {
    const o = r.open.get(id);
    if (!o) return; // orphan end - dropped
    if (g >= o.from) r.out.push({ id, fromWord: o.from, toWord: g, ...payloadOf(o) });
    r.open.delete(id);
  };
  const flushPending = (r: SpanResolver, g: number) => {
    for (const p of r.pending) openAt(r, p.id, g, p);
    r.pending = [];
  };
  const applyMarkers = (r: SpanResolver, markers: SpanMarker[], closeTarget: number) => {
    for (const mk of markers) {
      if (mk.dir === "start") r.pending.push({ id: mk.id, ...payloadOf(mk) });
      else if (closeTarget >= 0) closeAt(r, mk.id, closeTarget);
    }
  };
  const resolvers: [SpanResolver, SpanMarker["family"]][] = [
    [hlR, "hl"],
    [noteR, "note"],
    [linkR, "link"],
  ];
  const applyBoth = (markers: SpanMarker[], closeTarget: number) => {
    for (const [r, family] of resolvers) {
      applyMarkers(
        r,
        markers.filter((mk) => mk.family === family),
        closeTarget,
      );
    }
  };
  const endRun = () => {
    for (const r of [hlR, noteR, linkR]) {
      for (const [id, o] of r.open)
        if (lastEmitted >= o.from)
          r.out.push({ id, fromWord: o.from, toWord: lastEmitted, ...payloadOf(o) });
      r.open.clear();
      r.pending = [];
    }
  };

  for (const raw of rawLines) {
    const line = raw.trim();

    const speakerMatch = line.match(INLINE_SPEAKER);
    if (speakerMatch) {
      // Spans (highlights + notes) may cross speaker turns - a reviewer marks up
      // a whole back-and-forth. Only a genuinely-unclosed span auto-closes, and
      // it does so at end of body (endRun below), not per turn. This lifts the
      // earlier "a highlight never crosses a speaker turn" rule now that markup
      // is a cross-speaker surface.
      currentSpeaker = speakerMatch[1].trim();
      continue;
    }

    if (!hasWordTimestamps(line)) continue;

    // Markers in the leading region (before the first `{{t:}}`) lead the first
    // word of the line: a start opens it, an end closes the previous word.
    const firstToken = line.indexOf("{{t:");
    if (firstToken > 0)
      applyBoth(extractSpanMarkers(line.slice(0, firstToken)).markers, lastEmitted);

    let lastOnLine = -1;
    WORD_TOKEN.lastIndex = 0;
    let m = WORD_TOKEN.exec(line);
    while (m !== null) {
      // Split paired markers off the segment first: a start trails this word
      // (opens the next), an end closes this word. Then split event notes; the
      // remainder is the spoken word.
      const { rest, markers } = extractSpanMarkers(m[2]);
      const { word: text, notes: segNotes } = splitSegment(rest);
      if (text) {
        const start = parseFloat(m[1]);
        words.push({ text, start, gIndex, ...(segNotes.length ? { notes: segNotes } : {}) });

        const lastRun = runs[runs.length - 1];
        if (lastRun && lastRun.speaker === currentSpeaker) {
          lastRun.endWord = gIndex;
        } else {
          runs.push({ speaker: currentSpeaker, startWord: gIndex, endWord: gIndex });
        }

        // Spans waiting from an earlier marker open on this word; this segment's
        // own markers open the next word / close this one.
        flushPending(hlR, gIndex);
        flushPending(noteR, gIndex);
        flushPending(linkR, gIndex);
        applyBoth(markers, gIndex);

        lastEmitted = gIndex;
        lastOnLine = gIndex;
        gIndex++;
      } else {
        // No word of its own: markers still count (end closes the last real
        // word, start pends), and any notes re-anchor to the previous word.
        applyBoth(markers, lastEmitted);
        if (segNotes.length && words.length > 0) {
          const prev = words[words.length - 1];
          prev.notes = [...(prev.notes ?? []), ...segNotes];
        }
      }
      m = WORD_TOKEN.exec(line);
    }
    if (lastOnLine >= 0) {
      lineEndWords.add(lastOnLine);
    }
  }
  endRun(); // close anything still open at end of body

  const bySpan = (a: ResolvedSpan, b: ResolvedSpan) =>
    a.fromWord - b.fromWord || a.toWord - b.toWord || a.id.localeCompare(b.id);
  const highlights: WordHighlight[] = hlR.out
    .sort(bySpan)
    .map(({ id, fromWord, toWord }) => ({ id, fromWord, toWord }));
  const spanNotes: WordSpanNote[] = noteR.out
    .sort(bySpan)
    .map(({ id, fromWord, toWord, text }) => ({ id, fromWord, toWord, text: text ?? "" }));
  const links: WordLink[] = linkR.out
    .sort(bySpan)
    .map(({ id, fromWord, toWord, target, quote }) => ({
      id,
      fromWord,
      toWord,
      target: target ?? "",
      ...(quote !== undefined ? { quote } : {}),
    }));
  return { words, runs, lineEndWords, highlights, spanNotes, links, highlightContexts, preamble };
}

/** The gIndex of the word a inline event note anchors ONTO for time `at`:
 *  the last word starting at or before `at`, or -1 when `at` precedes the first
 *  word (callers clamp to word 0). The note becomes an entry in that word's
 *  `notes`, not a word of its own. Words are time-ordered, so the scan stops at
 *  the first later word. */
export function eventNoteAnchorIndex(words: Word[], at: number): number {
  let k = -1;
  for (let i = 0; i < words.length; i++) {
    if (words[i].start <= at) k = i;
    else break;
  }
  return k;
}

/** Serialise words + runs + line breaks back into a transcript body.
 *  Re-emits the body preamble verbatim, then a `<!-- speaker -->` comment only
 *  when the speaker changes (adjacent same-speaker runs merge), a single blank
 *  line between runs, and a `{{t:N.N}}` marker (two decimals) glued before every
 *  word. No line-start `HH:MM:SS.D` prefix is emitted - each line's first
 *  `{{t:}}` already carries the line's start time (record/2). Round-trip
 *  identical to the parsed body when nothing was edited. */
export function serializeWords(
  words: Word[],
  runs: SpeakerRun[],
  lineEndWords: Set<number>,
  preamble = "",
  highlights: WordHighlight[] = [],
  spanNotes: WordSpanNote[] = [],
  highlightContexts: HighlightContext[] = [],
  links: WordLink[] = [],
): string {
  const speakerByWord = new Array<string>(words.length);
  for (const run of runs) {
    for (let i = run.startWord; i <= run.endWord; i++) speakerByWord[i] = run.speaker;
  }

  // Paired markers glue onto a word's token: starts before its `{{t:}}`, ends
  // after its text. A word can open/close several (overlap), so collect per word.
  // Highlight and note markers share the same slots; a note-start additionally
  // carries the note text.
  const hlStartsAt = new Map<number, string[]>();
  const hlEndsAt = new Map<number, string[]>();
  for (const h of highlights) {
    (hlStartsAt.get(h.fromWord) ?? hlStartsAt.set(h.fromWord, []).get(h.fromWord)!).push(h.id);
    (hlEndsAt.get(h.toWord) ?? hlEndsAt.set(h.toWord, []).get(h.toWord)!).push(h.id);
  }
  const noteStartsAt = new Map<number, WordSpanNote[]>();
  const noteEndsAt = new Map<number, string[]>();
  for (const n of spanNotes) {
    (noteStartsAt.get(n.fromWord) ?? noteStartsAt.set(n.fromWord, []).get(n.fromWord)!).push(n);
    (noteEndsAt.get(n.toWord) ?? noteEndsAt.set(n.toWord, []).get(n.toWord)!).push(n.id);
  }
  const linkStartsAt = new Map<number, WordLink[]>();
  const linkEndsAt = new Map<number, string[]>();
  for (const l of links) {
    (linkStartsAt.get(l.fromWord) ?? linkStartsAt.set(l.fromWord, []).get(l.fromWord)!).push(l);
    (linkEndsAt.get(l.toWord) ?? linkEndsAt.set(l.toWord, []).get(l.toWord)!).push(l.id);
  }
  // Highlight starts before note starts; note ends before highlight ends. Order
  // within a slot is cosmetic (parse is order-agnostic there); this keeps a
  // highlight-only body byte-identical to before span notes existed.
  const startMarkers = (i: number) =>
    (hlStartsAt.get(i) ?? []).map((id) => `{{highlight-start: ${id}}}`).join("") +
    (noteStartsAt.get(i) ?? [])
      .map((n) => `{{note-start: [${n.id}, "${escapeNoteText(n.text)}"]}}`)
      .join("") +
    (linkStartsAt.get(i) ?? [])
      .map(
        (l) =>
          `{{link-start: [${l.id}, "${escapeNoteText(l.target)}"${
            l.quote !== undefined ? `, "${escapeNoteText(l.quote)}"` : ""
          }]}}`,
      )
      .join("");
  const endMarkers = (i: number) =>
    (linkEndsAt.get(i) ?? []).map((id) => `{{link-end: ${id}}}`).join("") +
    (noteEndsAt.get(i) ?? []).map((id) => `{{note-end: ${id}}}`).join("") +
    (hlEndsAt.get(i) ?? []).map((id) => `{{highlight-end: ${id}}}`).join("");

  const out: string[] = [];
  let lastSpeaker: string | null = null;
  let lineStartWord = -1;
  let lineTokens: string[] = [];

  const flushLine = () => {
    if (lineStartWord < 0) return;
    out.push(lineTokens.join(" "));
    lineStartWord = -1;
    lineTokens = [];
  };

  for (let i = 0; i < words.length; i++) {
    const speaker = speakerByWord[i];
    if (speaker !== lastSpeaker) {
      flushLine();
      if (lastSpeaker !== null) out.push("");
      out.push(`<!-- speaker: ${speaker} -->`);
      lastSpeaker = speaker;
    }

    if (lineStartWord < 0) lineStartWord = i;
    // Notes are stored bare; wrap each back in the `{{...}}` on-disk notation.
    const noteSuffix = words[i].notes?.length
      ? ` ${words[i].notes!.map((n) => `{{${n}}}`).join(" ")}`
      : "";
    lineTokens.push(
      `${startMarkers(i)}{{t:${words[i].start.toFixed(2)}}}${words[i].text}${noteSuffix}${endMarkers(i)}`,
    );

    if (lineEndWords.has(i)) flushLine();
  }
  flushLine();

  const transcript = out.join("\n") + (out.length ? "\n" : "");
  // Context edges are position-independent (they name ids), so they are written
  // as one block after the transcript rather than chased to a word. Parse strips
  // them from anywhere, so this round-trips whatever the UI wrote.
  const contexts = highlightContexts
    .filter((c) => c.of && c.needs.length > 0)
    .map((c) => `{{highlight-context: [${[c.of, ...c.needs].join(", ")}]}}`)
    .join("\n");
  return preamble + transcript + (contexts ? contexts + "\n" : "");
}

/** Remap paired-span word ranges (highlights or span notes) under an index
 *  transform, dropping any that collapse to nothing. `mapFrom`/`mapTo` move a
 *  span's start/end word to its new index; a boundary landing inside a
 *  removed/expanded span clamps to that span's surviving edge. Any extra fields
 *  (a note's `text`) ride through untouched. Keeps spans riding with the words
 *  through the same edits that shift `lineEndWords`. */
function remapSpans<T extends { id: string; fromWord: number; toWord: number }>(
  spans: T[],
  mapFrom: (i: number) => number,
  mapTo: (i: number) => number,
): T[] {
  const out: T[] = [];
  for (const s of spans) {
    const fromWord = mapFrom(s.fromWord);
    const toWord = mapTo(s.toWord);
    if (toWord >= fromWord) out.push({ ...s, fromWord, toWord });
  }
  return out;
}

/** Split the word at `gIndex` into one word per `pieces` entry, inside the same
 *  speaker run and line. Each new piece gets a start evenly spaced in the gap
 *  before the next word; the first piece keeps the original start. With a
 *  single piece it just replaces the word's text. Turns missed/merged speech a
 *  reviewer types into a word (e.g. "right? yes") into separate, separately-
 *  timestamped, reassignable words. */
export function splitWord(
  parsed: ParsedWords,
  gIndex: number,
  pieces: string[],
  mediaDuration?: number,
): ParsedWords {
  const { words, runs, lineEndWords, highlights, spanNotes, links, highlightContexts, preamble } =
    parsed;
  if (gIndex < 0 || gIndex >= words.length) return parsed;
  if (pieces.length <= 1) {
    if (pieces.length === 1 && words[gIndex].text !== pieces[0]) {
      const w = [...words];
      w[gIndex] = { ...w[gIndex], text: pieces[0] };
      return { ...parsed, words: w };
    }
    return parsed;
  }

  const k = pieces.length;
  const start = words[gIndex].start;
  const nextStart =
    gIndex + 1 < words.length ? words[gIndex + 1].start : (mediaDuration ?? start + 1);
  const span = Math.max(0, nextStart - start);

  const splitNotes = words[gIndex].notes;
  const newWords: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    if (i === gIndex) {
      for (let p = 0; p < k; p++) {
        // The split word's event notes follow the LAST piece (they trailed the
        // whole word).
        newWords.push({
          text: pieces[p],
          start: start + (span * p) / k,
          gIndex: newWords.length,
          ...(p === k - 1 && splitNotes?.length ? { notes: splitNotes } : {}),
        });
      }
    } else {
      newWords.push({ ...words[i], gIndex: newWords.length });
    }
  }

  // Everything after the split shifts right by k-1; the split word's own line
  // and run absorb the extra pieces.
  const shift = (idx: number) => (idx > gIndex ? idx + (k - 1) : idx);
  const newRuns: SpeakerRun[] = runs.map((r) => ({
    speaker: r.speaker,
    startWord: shift(r.startWord),
    endWord: gIndex >= r.startWord && gIndex <= r.endWord ? r.endWord + (k - 1) : shift(r.endWord),
  }));
  const newLineEndWords = new Set<number>();
  for (const e of lineEndWords) newLineEndWords.add(e === gIndex ? gIndex + (k - 1) : shift(e));

  // The split word expands: a span starting on it keeps its first piece; one
  // ending on (or spanning) it grows to cover all pieces.
  const mapFrom = (i: number) => (i > gIndex ? i + (k - 1) : i);
  const mapTo = (i: number) => (i >= gIndex ? i + (k - 1) : i);
  const newHighlights = remapSpans(highlights, mapFrom, mapTo);
  const newSpanNotes = remapSpans(spanNotes, mapFrom, mapTo);
  const newLinks = remapSpans(links, mapFrom, mapTo);

  return {
    words: newWords,
    runs: newRuns,
    lineEndWords: newLineEndWords,
    highlights: newHighlights,
    spanNotes: newSpanNotes,
    links: newLinks,
    // Unchanged by design: a context edge names ids, so moving words cannot
    // invalidate it - the property that makes ids the right anchor.
    highlightContexts,
    preamble,
  };
}

/** Replace the inclusive word range [from, to] - which the selection editor
 *  guarantees lies within ONE speaker run - with `newWords` (text + start),
 *  keeping that run's speaker. The general splice behind the multi-word selection
 *  editor: edit text, delete words, insert words, retime, in one operation.
 *  Re-gIndexes; grows/shrinks the containing run by the size change (dropping it
 *  if it empties); shifts later runs; and remaps line ends (breaks inside the
 *  range drop as the text re-flows, a break at the range's end moves to the new
 *  last word). Empty-text replacements are dropped, so passing [] deletes the
 *  range. */
export function replaceWordRange(
  parsed: ParsedWords,
  from: number,
  to: number,
  newWords: { text: string; start: number }[],
): ParsedWords {
  const { words, runs, lineEndWords, highlights, spanNotes, links, highlightContexts, preamble } =
    parsed;
  if (from < 0 || to >= words.length || from > to) return parsed;
  const clean = newWords
    .map((w) => ({ text: w.text.trim(), start: w.start }))
    .filter((w) => w.text);
  const delta = clean.length - (to - from + 1);
  const replLen = clean.length;

  // Event notes on the replaced words are not word content and the editor never
  // surfaces them, so carry them onto the last replacement word rather than
  // dropping them - editing (or splitting on space in) the word a note is
  // anchored to must never lose or tokenise the note.
  const rangeNotes = words.slice(from, to + 1).flatMap((w) => w.notes ?? []);
  const out: Word[] = [];
  for (let i = 0; i < from; i++) out.push({ ...words[i], gIndex: out.length });
  clean.forEach((w, ci) => {
    const carryNotes = ci === clean.length - 1 && rangeNotes.length > 0;
    out.push({
      text: w.text,
      start: w.start,
      gIndex: out.length,
      ...(carryNotes ? { notes: rangeNotes } : {}),
    });
  });
  for (let i = to + 1; i < words.length; i++) out.push({ ...words[i], gIndex: out.length });

  const newRuns: SpeakerRun[] = [];
  for (const r of runs) {
    if (from >= r.startWord && to <= r.endWord) {
      const endWord = r.endWord + delta;
      if (endWord >= r.startWord)
        newRuns.push({ speaker: r.speaker, startWord: r.startWord, endWord });
      // else: the run lost all its words - drop it (and its speaker comment)
    } else if (r.startWord > to) {
      newRuns.push({
        speaker: r.speaker,
        startWord: r.startWord + delta,
        endWord: r.endWord + delta,
      });
    } else {
      newRuns.push({ ...r }); // entirely before the range - unchanged
    }
  }

  const newLineEndWords = new Set<number>();
  const rangeEndedLine = lineEndWords.has(to);
  for (const e of lineEndWords) {
    if (e < from) newLineEndWords.add(e);
    else if (e > to) newLineEndWords.add(e + delta);
  }
  if (rangeEndedLine && clean.length > 0) newLineEndWords.add(from + clean.length - 1);

  // A span boundary inside the replaced range clamps to the new words' edge;
  // entirely-inside spans of a deleted range collapse and drop.
  const mapFrom = (i: number) => (i < from ? i : i <= to ? from : i + delta);
  const mapTo = (i: number) => (i < from ? i : i <= to ? from + replLen - 1 : i + delta);
  const newHighlights = remapSpans(highlights, mapFrom, mapTo);
  const newSpanNotes = remapSpans(spanNotes, mapFrom, mapTo);
  const newLinks = remapSpans(links, mapFrom, mapTo);

  return {
    words: out,
    runs: mergeAdjacentRuns(newRuns),
    lineEndWords: newLineEndWords,
    highlights: newHighlights,
    spanNotes: newSpanNotes,
    links: newLinks,
    // Unchanged by design: a context edge names ids, so moving words cannot
    // invalidate it - the property that makes ids the right anchor.
    highlightContexts,
    preamble,
  };
}

/** Reassign the inclusive word range [fromGIndex, toGIndex] to `newSpeaker`,
 *  splitting the single containing run into up to three (before / reassigned /
 *  after) and merging any resulting adjacent same-speaker runs. The caller
 *  guarantees the range lies within one run. */
export function reassignSpeaker(
  runs: SpeakerRun[],
  fromGIndex: number,
  toGIndex: number,
  newSpeaker: string,
): SpeakerRun[] {
  const lo = Math.min(fromGIndex, toGIndex);
  const hi = Math.max(fromGIndex, toGIndex);

  const result: SpeakerRun[] = [];
  for (const run of runs) {
    if (lo >= run.startWord && hi <= run.endWord) {
      if (lo > run.startWord) {
        result.push({ speaker: run.speaker, startWord: run.startWord, endWord: lo - 1 });
      }
      result.push({ speaker: newSpeaker, startWord: lo, endWord: hi });
      if (hi < run.endWord) {
        result.push({ speaker: run.speaker, startWord: hi + 1, endWord: run.endWord });
      }
    } else {
      result.push({ ...run });
    }
  }

  return mergeAdjacentRuns(result);
}

/** Merge consecutive runs that share a speaker and are word-contiguous. */
function mergeAdjacentRuns(runs: SpeakerRun[]): SpeakerRun[] {
  const merged: SpeakerRun[] = [];
  for (const run of runs) {
    const prev = merged[merged.length - 1];
    if (prev && prev.speaker === run.speaker && prev.endWord + 1 === run.startWord) {
      prev.endWord = run.endWord;
    } else {
      merged.push({ ...run });
    }
  }
  return merged;
}

/** Rename every run owned by `oldName` to `newName`, then merge any adjacent
 *  same-speaker runs that the rename produced (so renaming to a neighbouring
 *  speaker - or to an existing speaker elsewhere - coalesces the turns). No-op
 *  when the names match. */
export function renameSpeakerInRuns(
  runs: SpeakerRun[],
  oldName: string,
  newName: string,
): SpeakerRun[] {
  if (oldName === newName) return runs.map((r) => ({ ...r }));
  const renamed = runs.map((r) => ({
    speaker: r.speaker === oldName ? newName : r.speaker,
    startWord: r.startWord,
    endWord: r.endWord,
  }));
  return mergeAdjacentRuns(renamed);
}

/** Distinct run speakers that are real named people - i.e. not a default
 *  `Speaker N` cluster id and not a special token ([irrelevant], [narrator],
 *  ...) - in first-appearance order. This is the set the frontmatter
 *  `speakers:` list must mirror. */
export function namedSpeakersInOrder(runs: SpeakerRun[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const run of runs) {
    const name = run.speaker;
    if (seen.has(name)) continue;
    if (/^Speaker \d+$/i.test(name)) continue;
    if (isSpecialSpeaker(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** Per-speaker WORD counts for the speaker panel, in first-appearance order:
 *  `{ id, total }` where total is the number of words that speaker owns across
 *  all their runs (adjacent same-speaker runs already merge in the run model).
 *  The word-format analogue of counting segments per speaker - segments don't
 *  exist for a record/2 body, so the panel counts words instead. Includes
 *  special speakers ([irrelevant], [narrator], ...) so they stay filterable. */
export function speakerWordCounts(runs: SpeakerRun[]): { id: string; total: number }[] {
  const firstSeen = new Map<string, number>();
  const totals = new Map<string, number>();
  for (const r of runs) {
    if (!r.speaker) continue;
    if (!firstSeen.has(r.speaker)) firstSeen.set(r.speaker, r.startWord);
    totals.set(r.speaker, (totals.get(r.speaker) ?? 0) + (r.endWord - r.startWord + 1));
  }
  return [...firstSeen.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => ({ id, total: totals.get(id) ?? 0 }));
}

/** gIndices of words whose start falls in the half-open interval
 *  (fromTime, toTime]. Used to mark words observed as playback advances past
 *  them - the caller only calls this for a continuous forward step (it ignores
 *  seeks/jumps), so skipped words are never marked. */
export function wordsInTimeRange(words: Word[], fromTime: number, toTime: number): number[] {
  const out: number[] = [];
  for (const w of words) {
    if (w.start > fromTime && w.start <= toTime) out.push(w.gIndex);
  }
  return out;
}

/** gIndex of the word under the playhead at `time` - the last word whose start
 *  is <= time, or -1 before the first word. `words` must be start-ordered.
 *  Used for the karaoke cursor and to auto-observe the word being played through
 *  at an interval start (the word at exactly the seek-landing time, which
 *  wordsInTimeRange's open lower bound would otherwise miss). */
export function wordActiveAt(words: Word[], time: number): number {
  if (words.length === 0 || time < words[0].start) return -1;
  let lo = 0;
  let hi = words.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= time) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Playback skip-irrelevant for the per-word format. When the playhead at `t`
 *  sits on a word whose run is irrelevant, returns the start time of the next
 *  word whose run is NOT irrelevant (seek there to skip the irrelevant stretch);
 *  otherwise null. The segment-based nextRelevantSegmentAfter can't be used for
 *  a record/2 body because parseTranscript finds no prefixed segments in it - so
 *  the skip works off the word runs instead. `isIrrelevant` is the run-speaker
 *  predicate (typically `s === "[irrelevant]"`). */
export function nextRelevantWordStartAfter(
  words: Word[],
  runs: SpeakerRun[],
  t: number,
  isIrrelevant: (speaker: string) => boolean,
): number | null {
  if (words.length === 0) return null;
  const speakerOf = new Array<string>(words.length);
  for (const r of runs) {
    for (let i = r.startWord; i <= r.endWord && i < words.length; i++) speakerOf[i] = r.speaker;
  }
  // The active word is the last whose start is <= t (words are time-ordered).
  let active = -1;
  for (let i = 0; i < words.length; i++) {
    if (words[i].start <= t) active = i;
    else break;
  }
  if (active < 0 || !isIrrelevant(speakerOf[active] ?? "")) return null;
  for (let i = active + 1; i < words.length; i++) {
    if (!isIrrelevant(speakerOf[i] ?? "")) return words[i].start;
  }
  return null; // everything after the playhead is irrelevant - nothing to seek to
}

/** How a turn should be drawn once cuts are folded into it.
 *
 *  Marking a sentence irrelevant splits the speaker's turn in three - the same
 *  person, mid-thought, drawn as three blocks with two headers they never
 *  earned, which reads as a change of speaker when nothing of the sort
 *  happened. The runs stay as they are in the record (a cut IS a speaker
 *  change to `[irrelevant]`, and that is what the pipeline reads); only the
 *  drawing changes: a cut between two runs of the same speaker becomes a
 *  marker inside one continuous block. */
export interface RunDisplay {
  /** Draw this run's speaker header. False for the continuation after a cut. */
  header: boolean;
  /** Draw the rule that separates one turn from the next. */
  divider: boolean;
  /** This run is a cut sitting inside a turn that carries on around it. */
  cutInsideTurn: boolean;
}

export function runDisplays(runs: SpeakerRun[], irrelevant: string): RunDisplay[] {
  return runs.map((run, i) => {
    if (run.speaker === irrelevant) {
      // Look past any adjoining cuts: two sentences cut one after the other
      // still sit inside the same turn.
      let b = i - 1;
      while (b >= 0 && runs[b].speaker === irrelevant) b--;
      let a = i + 1;
      while (a < runs.length && runs[a].speaker === irrelevant) a++;
      const inside = b >= 0 && a < runs.length && runs[b].speaker === runs[a].speaker;
      return { header: !inside, divider: !inside, cutInsideTurn: inside };
    }
    // A run continues the turn when the only thing between it and the previous
    // run by the same speaker is cuts.
    let j = i - 1;
    while (j >= 0 && runs[j].speaker === irrelevant) j--;
    const continues = j >= 0 && j < i - 1 && runs[j].speaker === run.speaker;
    return { header: !continues, divider: !continues, cutInsideTurn: false };
  });
}
