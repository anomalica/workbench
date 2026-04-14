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

export function parseTranscript(body: string): Segment[] {
  const segments: Segment[] = [];
  // Split on multi-line annotation blocks: <!--\n...\n-->
  // Single-line annotations (<!-- file_page: 2 -->) are left in the
  // content and ignored by the speaker parser.
  const parts = body.split(/<!--\n/);

  for (const part of parts) {
    const closingIndex = part.indexOf("-->");
    if (closingIndex < 0) {
      // No closing --> means this is plain content (before first annotation)
      const contentLines = part
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l);
      if (contentLines.length > 0 && segments.length === 0) {
        segments.push({
          speaker: "",
          time: "",
          seconds: 0,
          lines: contentLines,
          irrelevant: false,
          index: 0,
        });
      } else if (contentLines.length > 0 && segments.length > 0) {
        segments[segments.length - 1].lines.push(...contentLines);
      }
      continue;
    }

    const yaml = part.slice(0, closingIndex);
    const textAfter = part.slice(closingIndex + 3);

    const speakerMatch = yaml.match(/^speaker:\s*(.+)$/m);
    const timeMatch = yaml.match(/^time:\s*(.+)$/m);

    if (speakerMatch && timeMatch) {
      const irrelevantMatch = yaml.match(/^irrelevant:\s*(.+)$/m);
      const contentLines = textAfter
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l);

      segments.push({
        speaker: speakerMatch[1].trim(),
        time: timeMatch[1].trim(),
        seconds: parseTimeToSeconds(timeMatch[1].trim()),
        lines: contentLines,
        irrelevant: irrelevantMatch ? irrelevantMatch[1].trim() === "true" : false,
        index: segments.length,
      });
    } else {
      // Annotation without speaker/time (e.g. page marker) - append content to previous segment
      const contentLines = textAfter
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l);
      if (contentLines.length > 0 && segments.length > 0) {
        segments[segments.length - 1].lines.push(...contentLines);
      }
    }
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
  return segments
    .map((seg) => {
      let yaml = `speaker: ${seg.speaker}\ntime: ${seg.time}`;
      if (seg.irrelevant) yaml += "\nirrelevant: true";
      const text = seg.lines.join("\n");
      return `\n<!--\n${yaml}\n-->\n${text}\n`;
    })
    .join("");
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
