/** A single timestamped word. `start` is absolute seconds from media start;
 *  `gIndex` is the word's position across the whole body (0-based). */
export interface Word {
  text: string;
  start: number;
  gIndex: number;
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
  /** The literal `HH:MM:SS.D` prefix of each original word line, keyed by the
   *  gIndex of that line's FIRST word. Preserved verbatim because the 2dp word
   *  token doesn't carry enough precision to recompute it: the ingester derived
   *  the prefix from the full-precision word start, which sits just below the
   *  rounded token, so recomputing can land one tenth too high. */
  linePrefixes: Map<number, string>;
  /** Everything in the body before the first `<!-- speaker -->` comment (the
   *  title heading, published line, blank separators). Re-emitted verbatim so a
   *  reassign doesn't destroy the record's `# PWTS ...` title. */
  preamble: string;
}

import { isSpecialSpeaker } from "$lib/transcript";

// <!-- speaker: Name -->
const INLINE_SPEAKER = /^<!--\s*speaker:\s*(.+?)\s*-->$/;
// {{t:12.34}}word  -> capture the start seconds and the glued word text.
const WORD_TOKEN = /\{\{t:(\d+(?:\.\d+)?)\}\}(\S+)/g;
// Leading HH:MM:SS.D timecode prefix of a word line.
const LINE_PREFIX = /^(\d{2}:\d{2}:\d{2}\.\d)\s+/;

/** True if the body uses per-word timestamps (contains `{{t:` markers). */
export function hasWordTimestamps(body: string): boolean {
  return body.includes("{{t:");
}

/** Parse a per-word-timestamp body into words, speaker runs, the set of
 *  line-ending word indices, the literal per-line timecode prefixes, and the
 *  body preamble. The transcript region begins at the first `<!-- speaker -->`
 *  comment; everything before it is kept verbatim as the preamble. Lines that
 *  are neither a speaker comment nor a word line (blank separators) carry no
 *  words and are reconstructed from the run structure on serialise. */
export function parseWords(body: string): ParsedWords {
  const words: Word[] = [];
  const runs: SpeakerRun[] = [];
  const lineEndWords = new Set<number>();
  const linePrefixes = new Map<number, string>();

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

    const lineStartIndex = gIndex;
    let lastOnLine = -1;
    WORD_TOKEN.lastIndex = 0;
    let m = WORD_TOKEN.exec(line);
    while (m !== null) {
      const start = parseFloat(m[1]);
      words.push({ text: m[2], start, gIndex });

      const lastRun = runs[runs.length - 1];
      if (lastRun && lastRun.speaker === currentSpeaker) {
        lastRun.endWord = gIndex;
      } else {
        runs.push({ speaker: currentSpeaker, startWord: gIndex, endWord: gIndex });
      }

      lastOnLine = gIndex;
      gIndex++;
      m = WORD_TOKEN.exec(line);
    }
    if (lastOnLine >= 0) {
      lineEndWords.add(lastOnLine);
      const prefixMatch = line.match(LINE_PREFIX);
      if (prefixMatch) linePrefixes.set(lineStartIndex, prefixMatch[1]);
    }
  }

  return { words, runs, lineEndWords, linePrefixes, preamble };
}

/** Floor an absolute seconds value to a `HH:MM:SS.D` prefix. Used only for line
 *  starts created by a mid-line speaker split, where there's no original prefix
 *  to preserve. */
function flooredPrefix(seconds: number): string {
  const t = Math.max(0, seconds);
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = Math.floor(t % 60);
  const tenth = Math.floor((t * 10) % 10);
  return `${pad(h)}:${pad(m)}:${pad(sec)}.${tenth}`;
}

/** Serialise words + runs + line breaks back into a transcript body.
 *  Re-emits the body preamble verbatim, then a `<!-- speaker -->` comment only
 *  when the speaker changes (adjacent same-speaker runs merge), a single blank
 *  line between runs, each original line's literal `HH:MM:SS.D` prefix (keyed by
 *  its first word), and a `{{t:N.N}}` marker (two decimals) glued before every
 *  word. Round-trip identical to the parsed body when nothing was edited. */
export function serializeWords(
  words: Word[],
  runs: SpeakerRun[],
  lineEndWords: Set<number>,
  linePrefixes: Map<number, string> = new Map(),
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
    // Prefer the original verbatim prefix for this line's first word; only a
    // mid-line speaker split produces a line start with no captured prefix.
    const prefix = linePrefixes.get(lineStartWord) ?? flooredPrefix(words[lineStartWord].start);
    out.push(`${prefix} ${lineTokens.join(" ")}`);
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
    lineTokens.push(`{{t:${words[i].start.toFixed(2)}}}${words[i].text}`);

    if (lineEndWords.has(i)) flushLine();
  }
  flushLine();

  const transcript = out.join("\n") + (out.length ? "\n" : "");
  return preamble + transcript;
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
