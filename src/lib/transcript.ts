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
  const blocks = body.split(/\n---\n/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const speakerMatch = trimmed.match(/^speaker:\s*(.+)$/m);
    const timeMatch = trimmed.match(/^time:\s*(.+)$/m);

    if (speakerMatch && timeMatch) {
      const irrelevantMatch = trimmed.match(/^irrelevant:\s*(.+)$/m);
      const textStart = trimmed.lastIndexOf("---");
      const textPart = textStart >= 0 ? trimmed.slice(textStart + 3) : trimmed;
      const contentLines = textPart
        .split("\n")
        .map((l) => l.trim())
        .filter(
          (l) =>
            l &&
            !l.startsWith("speaker:") &&
            !l.startsWith("time:") &&
            !l.startsWith("irrelevant:"),
        );

      segments.push({
        speaker: speakerMatch[1].trim(),
        time: timeMatch[1].trim(),
        seconds: parseTimeToSeconds(timeMatch[1].trim()),
        lines: contentLines,
        irrelevant: irrelevantMatch ? irrelevantMatch[1].trim() === "true" : false,
        index: segments.length,
      });
    } else {
      const contentLines = trimmed
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
      return `\n---\n${yaml}\n---\n${text}\n`;
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

/** Return the next speaker number not yet used: "Speaker N". */
export function nextSpeakerName(segments: Segment[]): string {
  let max = 0;
  for (const seg of segments) {
    const m = seg.speaker.match(/^Speaker (\d+)$/i);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `Speaker ${max + 1}`;
}
