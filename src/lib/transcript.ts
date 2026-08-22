export interface Segment {
  speaker: string;
  time: string;
  seconds: number;
  lines: string[];
  /** Index in the original segment list, used for edit operations */
  index: number;
}

export function parseTimeToSeconds(time: string): number {
  const parts = time.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] ?? 0;
}

// Matches timestamped lines: "00:01:24.1 Some text here"
const TIMESTAMPED_LINE = /^(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(.+)$/;

// Matches inline speaker comment: <!-- speaker: Name -->
const INLINE_SPEAKER = /^<!--\s*speaker:\s*(.+?)\s*-->$/;

/**
 * Parse a transcript body into segments. Supports two formats:
 *
 * New format (sentence-level timestamps):
 *   <!-- speaker: Lex Fridman -->
 *   00:00:01.8 First sentence.
 *   00:00:05.2 Second sentence.
 *
 * Old format (block annotations):
 *   <!--
 *   speaker: David Fravor
 *   time: 00:07:17
 *   -->
 *   Text content here.
 */
export function parseTranscript(body: string): Segment[] {
  const segments: Segment[] = [];
  let currentSpeaker = "";

  const lines = body.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Inline speaker comment: <!-- speaker: Name -->
    const inlineSpeaker = line.match(INLINE_SPEAKER);
    if (inlineSpeaker) {
      currentSpeaker = inlineSpeaker[1].trim();
      i++;
      continue;
    }

    // Multi-line annotation block: <!--\n...\n-->
    if (line === "<!--") {
      const blockLines: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== "-->") {
        blockLines.push(lines[i].trim());
        i++;
      }
      i++; // skip -->

      const yaml = blockLines.join("\n");
      const speakerMatch = yaml.match(/^speaker:\s*(.+)$/m);
      const timeMatch = yaml.match(/^time:\s*(.+)$/m);

      if (speakerMatch && timeMatch) {
        // Old-format speaker turn with explicit time
        currentSpeaker = speakerMatch[1].trim();
        const time = timeMatch[1].trim();

        // Collect text until the next annotation
        const textLines: string[] = [];
        while (
          i < lines.length &&
          lines[i].trim() !== "<!--" &&
          !INLINE_SPEAKER.test(lines[i].trim())
        ) {
          const tl = lines[i].trim();
          if (tl) textLines.push(tl);
          i++;
        }

        segments.push({
          speaker: currentSpeaker,
          time,
          seconds: parseTimeToSeconds(time),
          lines: textLines,
          index: segments.length,
        });
      }
      // Other block annotations (redacted, image, etc.) are skipped
      continue;
    }

    // Legacy <!-- irrelevant --> marker - treat as [irrelevant] speaker
    if (line === "<!-- irrelevant -->") {
      i++;
      const nextLine = i < lines.length ? lines[i].trim() : "";
      const nextTs = nextLine.match(TIMESTAMPED_LINE);
      if (nextTs) {
        segments.push({
          speaker: SPEAKER_IRRELEVANT,
          time: nextTs[1],
          seconds: parseTimeToSeconds(nextTs[1]),
          lines: [nextTs[2]],
          index: segments.length,
        });
        i++;
      }
      continue;
    }

    // Single-line annotation: <!-- file_page: 2 --> etc.
    if (line.startsWith("<!--") && line.endsWith("-->")) {
      i++;
      continue;
    }

    // Timestamped text line: 00:01:24.1 Some text
    const tsMatch = line.match(TIMESTAMPED_LINE);
    if (tsMatch && currentSpeaker) {
      const time = tsMatch[1];
      const text = tsMatch[2];
      segments.push({
        speaker: currentSpeaker,
        time,
        seconds: parseTimeToSeconds(time),
        lines: [text],
        index: segments.length,
      });
      i++;
      continue;
    }

    // Plain text line - append to the last segment
    if (line && segments.length > 0) {
      segments[segments.length - 1].lines.push(line);
    }

    i++;
  }

  return segments;
}

export function extractSpeakers(segments: Segment[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const seg of segments) {
    if (seg.speaker) {
      counts.set(seg.speaker, (counts.get(seg.speaker) ?? 0) + 1);
    }
  }
  return counts;
}

/** Serialise segments back to the markdown body format. */
export function serializeTranscript(segments: Segment[]): string {
  let result = "";
  let lastSpeaker = "";
  for (const seg of segments) {
    if (seg.speaker !== lastSpeaker) {
      result += `\n<!-- speaker: ${seg.speaker} -->\n`;
      lastSpeaker = seg.speaker;
    }
    // If the time looks like sentence-level (has decimal), use timestamped line format
    if (seg.time.includes(".")) {
      for (const line of seg.lines) {
        result += `${seg.time} ${line}\n`;
      }
    } else {
      // Old format: multi-line block
      const yaml = `speaker: ${seg.speaker}\ntime: ${seg.time}`;
      result += `\n<!--\n${yaml}\n-->\n${seg.lines.join("\n")}\n`;
      lastSpeaker = ""; // Reset because old format repeats speaker in each block
    }
  }
  return result;
}

export function secondsToTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0)
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** Full sentence-level timecode `HH:MM:SS.D` (one decimal place), matching
 *  the record format. Use this when writing a timestamp back - secondsToTime
 *  floors to whole seconds and so silently discards sub-second precision
 *  (the exact thing the edit dialog's fine-scrub is for). */
export function secondsToTimecode(s: number): string {
  const t = Math.max(0, s);
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = Math.floor(t % 60);
  const tenth = Math.floor((t * 10) % 10);
  return `${pad(h)}:${pad(m)}:${pad(sec)}.${tenth}`;
}

// Ordered so that CONSECUTIVE entries contrast: hue jumps roughly across the
// wheel each step, so the first two speakers in a record - which is most
// records - are never near-neighbours. The old list ran teal, orange, green,
// purple, red... and paired with a hash that could land two speakers on
// `#7B4DAA` and `#6E4A8B`, which is two purples.
const SPEAKER_COLOURS = [
  "#0B6E6E", // teal
  "#B35A28", // burnt orange
  "#3B7FC4", // blue
  "#C44B8B", // magenta
  "#2D7D46", // green
  "#7B4DAA", // purple
  "#8B6914", // ochre
  "#C4543B", // red
  "#4A8B6E", // sea green
  "#6E4A8B", // violet
  "#8B4A6E", // plum
  "#4A6E8B", // steel
  "#6E8B4A", // olive
  "#8B6E4A", // tan
];

export function speakerColour(speaker: string): string {
  let hash = 0;
  for (let i = 0; i < speaker.length; i++) {
    hash = (hash * 31 + speaker.charCodeAt(i)) | 0;
  }
  return SPEAKER_COLOURS[Math.abs(hash) % SPEAKER_COLOURS.length];
}

/** Find which segment should be active for a given playback time.
 *  Returns the segment index, or -1 if none match.
 *  Skips irrelevant segments. */
export function findActiveSegmentForTime(segments: Segment[], currentTime: number): number {
  let best = -1;
  for (const seg of segments) {
    if (isSegmentIrrelevant(seg)) continue;
    if (seg.seconds <= currentTime) best = seg.index;
    else break;
  }
  return best;
}

/** The segment actually playing at time t: the one whose start is the
 *  largest <= t, INCLUDING irrelevant segments. Unlike
 *  findActiveSegmentForTime (which skips irrelevant segments so the
 *  highlight can follow only real content), this can report that the
 *  playhead is sitting inside an irrelevant region - which is what the
 *  skip-irrelevant playback feature needs to know. Robust to minor
 *  timestamp disorder: it takes the largest start <= t, not the last in
 *  array order. Returns null when t precedes every segment. */
export function segmentAtTime(segments: Segment[], t: number): Segment | null {
  let current: Segment | null = null;
  for (const s of segments) {
    if (s.seconds <= t && (!current || s.seconds > current.seconds)) current = s;
  }
  return current;
}

/** The first relevant (non-irrelevant) segment that starts strictly after
 *  t, in document order. The skip-irrelevant feature jumps here. */
export function nextRelevantSegmentAfter(segments: Segment[], t: number): Segment | null {
  return segments.find((s) => !isSegmentIrrelevant(s) && s.seconds > t) ?? null;
}

/** Extract named speakers from frontmatter YAML.
 *  Returns an empty array if no speakers field exists. */
export function extractFrontmatterSpeakers(rawFrontmatter: string): string[] {
  const match = rawFrontmatter.match(/^speakers:\s*\n((?:\s+-\s+.+\n)*)/m);
  if (!match) return [];
  return match[1]
    .split("\n")
    .map((l) =>
      l
        .replace(/^\s+-\s+/, "")
        .replace(/^["']|["']$/g, "")
        .trim(),
    )
    .filter((l) => l);
}

/** Special speaker names. */
export const SPEAKER_IRRELEVANT = "[irrelevant]";

/** The speaker tokens still OFFERED when reassigning a turn.
 *
 *  `[external footage]` is deliberately absent, and still recognised
 *  everywhere else so existing records keep rendering. It is deprecated in
 *  ingest-format.md: a clip is now marked on the PASSAGE, which keeps the
 *  speaker as the person and stops one clip counting as fresh corroboration
 *  every time another record replays it. Offering both asks the reviewer to
 *  choose between two ways of saying one thing, and the losing choice throws
 *  away who was speaking. */
export function assignableSpecialSpeakers(exclude?: string): string[] {
  return [SPEAKER_IRRELEVANT, SPEAKER_NARRATOR, SPEAKER_GROUP].filter((s) => s !== exclude);
}
export const SPEAKER_NARRATOR = "[narrator]";
export const SPEAKER_EXTERNAL_FOOTAGE = "[external footage]";
/** Multiple speakers saying the same thing simultaneously - chants,
 *  unison answers, committee responses. Use when no one individual
 *  owns the line. */
export const SPEAKER_GROUP = "[group]";

export const SPECIAL_SPEAKERS = [
  SPEAKER_IRRELEVANT,
  SPEAKER_NARRATOR,
  SPEAKER_EXTERNAL_FOOTAGE,
  SPEAKER_GROUP,
] as const;

/** Common non-verbal transcript event notes. A reviewer inserts one as an
 *  unkeyed inline note token (`{{laughs}}`) at the point the event occurs; the
 *  digester reads a `[...]` note in a transcript as a meta event, never spoken
 *  words (ingest-format.md - the bracket meta-notation). Distinct from the
 *  keyed `{{actor: action}}` inline annotation, which is unchanged. */
export const EVENT_NOTE_PRESETS = [
  "laughs",
  "laughter",
  "applause",
  "pause",
  "music",
  "crosstalk",
  "inaudible",
] as const;

/** Splice a inline event note `{{label}}` into `text`, replacing the range
 *  [start, end). A single space is padded on either side only where the
 *  neighbour isn't already whitespace, so the token never fuses onto a word.
 *  Returns the new text and the caret position just after the inserted token. */
export function insertEventNote(
  text: string,
  label: string,
  start: number,
  end: number,
): { text: string; cursor: number } {
  const token = `{{${label}}}`;
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const trail = after.length > 0 && !/^\s/.test(after) ? " " : "";
  const insert = `${lead}${token}${trail}`;
  return { text: before + insert + after, cursor: start + insert.length };
}

/** Check if a speaker name looks like a default (Speaker N).
 *
 *  Brackets are accepted because a diarisation id IS an anonymous speaker -
 *  `Speaker 3` is a cluster number, not a person - so the ingester writes
 *  `[speaker 3]`. Older records say `Speaker 3`; both are the same thing and
 *  both must count as unnamed, or a bracketed default would be filed as a
 *  person and written into the record's speaker list. */
export function isDefaultSpeakerName(name: string): boolean {
  return /^\[?\s*Speaker \d+\s*\]?$/i.test(name.trim());
}

/** Check if a speaker is a special name (not a real person). */
export function isSpecialSpeaker(name: string): boolean {
  return (SPECIAL_SPEAKERS as readonly string[]).includes(name);
}

/** Check if a segment is irrelevant (speaker is [irrelevant]). */
export function isSegmentIrrelevant(seg: Segment): boolean {
  return seg.speaker === SPEAKER_IRRELEVANT;
}

/** Return the next speaker number not yet used.
 *
 *  Written in whatever style the record already uses: a record whose defaults
 *  are `[speaker 1]` gets `[speaker 4]`, an older one whose defaults are
 *  `Speaker 1` gets `Speaker 4`. Mixing the two inside one record would show
 *  the reviewer two spellings of the same idea and read as a bug. */
export function nextSpeakerName(segments: Segment[]): string {
  let max = 0;
  let bracketed = false;
  for (const seg of segments) {
    const m = seg.speaker.trim().match(/^(\[?)\s*Speaker (\d+)\s*\]?$/i);
    if (!m) continue;
    if (m[1]) bracketed = true;
    max = Math.max(max, parseInt(m[2], 10));
  }
  return bracketed ? `[speaker ${max + 1}]` : `Speaker ${max + 1}`;
}

/** Return named speakers in display order: those with segments sorted by first
 *  appearance in the transcript, followed by any named speakers not yet
 *  appearing in segments in their frontmatter order. Used by both the sidebar
 *  and the segment speaker picker to keep ordering consistent. */
export function orderedNamedSpeakers(segments: Segment[], namedSpeakers: string[]): string[] {
  const firstSeen = new Map<string, number>();
  for (let i = 0; i < segments.length; i++) {
    const name = segments[i].speaker;
    if (name && !firstSeen.has(name)) firstSeen.set(name, i);
  }
  const namedSet = new Set(namedSpeakers);
  const withSegments = [...firstSeen.entries()]
    .filter(([name]) => namedSet.has(name))
    .sort((a, b) => a[1] - b[1])
    .map(([name]) => name);
  const withSegmentsSet = new Set(withSegments);
  const withoutSegments = namedSpeakers.filter((n) => !withSegmentsSet.has(n));
  return [...withSegments, ...withoutSegments];
}

export interface SegmentGroup {
  speaker: string;
  segments: Segment[];
}

/** Group consecutive segments by speaker so the speaker header only needs to
 *  be shown once per run. Timestamps stay on individual segments.
 *
 *  An irrelevant segment does NOT end a run. Marking a sentence irrelevant
 *  used to split the speaker's block in three - the same person, mid-thought,
 *  rendered as three separate turns with two headers they never earned - which
 *  reads as a change of speaker when nothing of the sort happened. The
 *  segment stays inside the surrounding block and the viewer draws it as a
 *  marker rather than as text, so the cut is visible where it happened without
 *  breaking the turn around it.
 *
 *  A run of irrelevant segments with no relevant block before it keeps its own
 *  group: there is no turn to sit inside. */
export function groupSegmentsBySpeaker(segments: Segment[]): SegmentGroup[] {
  const groups: SegmentGroup[] = [];
  for (const seg of segments) {
    const last = groups[groups.length - 1];
    const insideATurn = !!last && last.speaker !== SPEAKER_IRRELEVANT;
    if (last && (last.speaker === seg.speaker || (isSegmentIrrelevant(seg) && insideATurn))) {
      last.segments.push(seg);
    } else {
      groups.push({ speaker: seg.speaker, segments: [seg] });
    }
  }
  return groups;
}

/**
 * A speaker whose real name is unknown, described instead of named.
 *
 * `[interviewer 2]`, `[audience member]`, `[recovery team member]`. The
 * brackets are not decoration: they say the value is a DESCRIPTION and must
 * not be read as an identity. `[interviewer 2]` in one recording is not the
 * same person as `[interviewer 2]` in another, so nothing downstream should
 * merge them, build a person from them, or offer them for autocomplete across
 * records - which is what a bare `Interviewer` invites.
 *
 * This generalises what the reserved tokens already do: `[narrator]` has
 * always been a role rather than a name, and the four reserved values are
 * simply the descriptions common enough to be worth naming in the spec.
 */
export function isAnonymousSpeaker(name: string): boolean {
  return /^\[.+\]$/.test(name.trim());
}

/** The description inside the brackets, for display. */
export function anonymousLabel(name: string): string {
  return name.trim().replace(/^\[|\]$/g, "");
}

/** Wrap a description as an anonymous speaker, idempotently. */
export function asAnonymousSpeaker(description: string): string {
  const inner = anonymousLabel(description).trim();
  return inner ? `[${inner}]` : "";
}
