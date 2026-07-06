/** A single timestamped word. `start` is absolute seconds from media start;
 *  `gIndex` is the word's position across the whole body (0-based). */
export interface Word {
  text: string;
  start: number;
  gIndex: number;
  /** Non-verbal event notes that FOLLOW this word - first-class annotation
   *  objects, not spoken words: no timestamp of their own, never tokenised or
   *  word-edited, rendered as distinct chips. Stored as the BARE inner text
   *  ("laughs", not "[laughs]"); the `[...]` brackets are the on-disk notation
   *  that serializeWords adds back. Omitted when the word carries none. */
  notes?: string[];
}

/** A consecutive run of words owned by one speaker. `startWord`/`endWord` are
 *  inclusive global word indices. */
export interface SpeakerRun {
  speaker: string;
  startWord: number;
  endWord: number;
}

export interface ParsedWords {
  words: Word[];
  runs: SpeakerRun[];
  /** gIndex of the last word on each original body line, so the line-break
   *  structure can be reproduced exactly on serialise. */
  lineEndWords: Set<number>;
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
// A bracketed non-verbal event note. Transcripts carry no markdown links, so a
// `[...]` in a word segment is always a note, never prose (record-format.md -
// the bracket meta-notation).
const NOTE_TOKEN = /\[[^\]]*\]/g;

/** Split a `{{t:}}` segment's text into the spoken word and the event notes
 *  that follow it. `{{t:1.5}}had [laughs]` yields word "had" + note "laughs".
 *  The `[...]` brackets are the on-disk NOTATION, not content: the INNER text is
 *  stored (record-format.md - the bracket meta-notation), and serializeWords
 *  wraps it back. A segment that is only `[laughs]` (the legacy note-as-word
 *  form) yields an empty word and the note, so it re-anchors onto the previous
 *  real word and sheds its stray timestamp. */
function splitSegment(raw: string): { word: string; notes: string[] } {
  const notes: string[] = [];
  const word = raw
    .replace(NOTE_TOKEN, (m) => {
      const inner = m.slice(1, -1).trim();
      if (inner) notes.push(inner);
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

  for (const raw of rawLines) {
    const line = raw.trim();

    const speakerMatch = line.match(INLINE_SPEAKER);
    if (speakerMatch) {
      currentSpeaker = speakerMatch[1].trim();
      continue;
    }

    if (!hasWordTimestamps(line)) continue;

    let lastOnLine = -1;
    WORD_TOKEN.lastIndex = 0;
    let m = WORD_TOKEN.exec(line);
    while (m !== null) {
      // The capture runs to the next marker. Split off any bracketed event
      // notes: the remainder is the spoken word (internal spaces kept).
      const { word: text, notes: segNotes } = splitSegment(m[2]);
      if (text) {
        const start = parseFloat(m[1]);
        words.push({ text, start, gIndex, ...(segNotes.length ? { notes: segNotes } : {}) });

        const lastRun = runs[runs.length - 1];
        if (lastRun && lastRun.speaker === currentSpeaker) {
          lastRun.endWord = gIndex;
        } else {
          runs.push({ speaker: currentSpeaker, startWord: gIndex, endWord: gIndex });
        }

        lastOnLine = gIndex;
        gIndex++;
      } else if (segNotes.length && words.length > 0) {
        // Notes with no word of their own (the legacy note-as-word form) attach
        // to the previous real word, dropping the stray timestamp.
        const prev = words[words.length - 1];
        prev.notes = [...(prev.notes ?? []), ...segNotes];
      }
      m = WORD_TOKEN.exec(line);
    }
    if (lastOnLine >= 0) {
      lineEndWords.add(lastOnLine);
    }
  }

  return { words, runs, lineEndWords, preamble };
}

/** The gIndex of the word a bracketed event note anchors ONTO for time `at`:
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
): string {
  const speakerByWord = new Array<string>(words.length);
  for (const run of runs) {
    for (let i = run.startWord; i <= run.endWord; i++) speakerByWord[i] = run.speaker;
  }

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
    // Notes are stored bare; wrap each back in the `[...]` on-disk notation.
    const noteSuffix = words[i].notes?.length
      ? ` ${words[i].notes!.map((n) => `[${n}]`).join(" ")}`
      : "";
    lineTokens.push(`{{t:${words[i].start.toFixed(2)}}}${words[i].text}${noteSuffix}`);

    if (lineEndWords.has(i)) flushLine();
  }
  flushLine();

  const transcript = out.join("\n") + (out.length ? "\n" : "");
  return preamble + transcript;
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
  const { words, runs, lineEndWords, preamble } = parsed;
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

  return {
    words: newWords,
    runs: newRuns,
    lineEndWords: newLineEndWords,
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
  const { words, runs, lineEndWords, preamble } = parsed;
  if (from < 0 || to >= words.length || from > to) return parsed;
  const clean = newWords
    .map((w) => ({ text: w.text.trim(), start: w.start }))
    .filter((w) => w.text);
  const delta = clean.length - (to - from + 1);

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

  return { words: out, runs: mergeAdjacentRuns(newRuns), lineEndWords: newLineEndWords, preamble };
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
