export interface Segment {
  speaker: string;
  time: string;
  seconds: number;
  lines: string[];
  irrelevant: boolean;
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
      const irrelevantMatch = yaml.match(/^irrelevant:\s*(.+)$/m);

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
          irrelevant: irrelevantMatch ? irrelevantMatch[1].trim() === "true" : false,
          index: segments.length,
        });
      }
      // Other block annotations (redacted, image, etc.) are skipped
      continue;
    }

    // Irrelevant marker: <!-- irrelevant --> before a timestamped line
    if (line === "<!-- irrelevant -->") {
      i++;
      // Look ahead for the timestamped line
      const nextLine = i < lines.length ? lines[i].trim() : "";
      const nextTs = nextLine.match(TIMESTAMPED_LINE);
      if (nextTs && currentSpeaker) {
        segments.push({
          speaker: currentSpeaker,
          time: nextTs[1],
          seconds: parseTimeToSeconds(nextTs[1]),
          lines: [nextTs[2]],
          irrelevant: true,
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
        irrelevant: false,
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
      if (seg.irrelevant) result += "<!-- irrelevant -->\n";
      for (const line of seg.lines) {
        result += `${seg.time} ${line}\n`;
      }
    } else {
      // Old format: multi-line block
      let yaml = `speaker: ${seg.speaker}\ntime: ${seg.time}`;
      if (seg.irrelevant) yaml += "\nirrelevant: true";
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

const SPEAKER_COLOURS = [
  "#0B6E6E",
  "#B35A28",
  "#2D7D46",
  "#7B4DAA",
  "#C4543B",
  "#3B7FC4",
  "#8B6914",
  "#C44B8B",
  "#4A8B6E",
  "#6E4A8B",
  "#8B4A6E",
  "#4A6E8B",
  "#6E8B4A",
  "#8B6E4A",
  "#4A8B8B",
  "#8B4A4A",
];

/** Deterministic colour for a speaker name. Uses a simple string hash
 *  so that renamed speakers get a consistent but distinct colour. */
export function speakerColour(speaker: string): string {
  let hash = 0;
  for (let i = 0; i < speaker.length; i++) {
    hash = (hash * 31 + speaker.charCodeAt(i)) | 0;
  }
  return SPEAKER_COLOURS[Math.abs(hash) % SPEAKER_COLOURS.length];
}

/** Return the next speaker number not yet used: "Speaker N". */
export function nextSpeakerName(segments: Segment[]): string {
  let max = 0;
  for (const seg of segments) {
    const m = seg.speaker.match(/^Speaker (\d+)$/i);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `Speaker ${max + 1}`;
}
