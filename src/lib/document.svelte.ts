/**
 * Document store for editing ingest markdown with full undo/redo.
 *
 * Every edit produces a new version of the markdown text.
 * History is tracked for undo/redo. State auto-saves to localStorage.
 */

const MAX_HISTORY = 200;

export class DocumentStore {
  original = $state("");
  current = $state("");
  past = $state<string[]>([]);
  future = $state<string[]>([]);
  storageKey = $state("");

  get dirty() {
    return this.current !== this.original;
  }

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  load(markdown: string, contentHash: string) {
    this.storageKey = `workbench:doc:${contentHash}`;
    this.original = markdown;

    // Restore from localStorage if available
    const saved = localStorage.getItem(this.storageKey);
    if (saved) {
      try {
        const state = JSON.parse(saved);
        this.current = state.current ?? markdown;
        this.past = state.past ?? [];
        this.future = state.future ?? [];
        return;
      } catch {
        // Corrupted save, start fresh
      }
    }

    this.current = markdown;
    this.past = [];
    this.future = [];
  }

  private pushEdit(newContent: string) {
    if (newContent === this.current) return;
    this.past = [...this.past.slice(-MAX_HISTORY), this.current];
    this.current = newContent;
    this.future = [];
    this.save();
  }

  undo() {
    if (this.past.length === 0) return;
    this.future = [this.current, ...this.future];
    this.current = this.past[this.past.length - 1];
    this.past = this.past.slice(0, -1);
    this.save();
  }

  redo() {
    if (this.future.length === 0) return;
    this.past = [...this.past, this.current];
    this.current = this.future[0];
    this.future = this.future.slice(1);
    this.save();
  }

  reset() {
    this.pushEdit(this.original);
  }

  private save() {
    localStorage.setItem(
      this.storageKey,
      JSON.stringify({
        current: this.current,
        past: this.past,
        future: this.future,
      }),
    );
  }

  discard() {
    localStorage.removeItem(this.storageKey);
    this.current = this.original;
    this.past = [];
    this.future = [];
  }

  // --- High-level edit operations ---

  renameSpeaker(oldId: string, newName: string) {
    // Replace `speaker: oldId` with `speaker: newName` in YAML blocks
    const pattern = new RegExp(`^(speaker:\\s*)${escapeRegex(oldId)}\\s*$`, "gm");
    const result = this.current.replace(pattern, `$1${newName}`);
    this.pushEdit(result);
  }

  mergeSpeakers(sourceIds: string[], targetName: string) {
    let result = this.current;
    for (const id of sourceIds) {
      const pattern = new RegExp(`^(speaker:\\s*)${escapeRegex(id)}\\s*$`, "gm");
      result = result.replace(pattern, `$1${targetName}`);
    }
    this.pushEdit(result);
  }

  /**
   * Set irrelevant flag on segments identified by speaker+time pairs.
   * Each entry is { speaker, time } matching a YAML block.
   */
  setIrrelevant(targets: { speaker: string; time: string }[], irrelevant: boolean) {
    let result = this.current;
    for (const { speaker, time } of targets) {
      // Match the YAML block for this segment
      const blockPattern = new RegExp(
        `(\\n---\\n)(speaker:\\s*${escapeRegex(speaker)}\\ntime:\\s*${escapeRegex(time)})(\\nirrelevant:\\s*\\w+)?(\\n---\\n)`,
        "g",
      );
      if (irrelevant) {
        // Add or update irrelevant: true
        result = result.replace(blockPattern, (_, pre, fields, _irr, post) => {
          return `${pre}${fields}\nirrelevant: true${post}`;
        });
      } else {
        // Remove irrelevant line
        result = result.replace(blockPattern, (_, pre, fields, _irr, post) => {
          return `${pre}${fields}${post}`;
        });
      }
    }
    if (result !== this.current) this.pushEdit(result);
  }

  // --- Structural editing (parse-modify-serialize) ---

  /** Change a single segment's speaker field. */
  changeSegmentSpeaker(oldSpeaker: string, time: string, newSpeaker: string) {
    const pattern = new RegExp(
      `(\\n---\\n)speaker:\\s*${escapeRegex(oldSpeaker)}(\\ntime:\\s*${escapeRegex(time)})`,
      "g",
    );
    const result = this.current.replace(pattern, `$1speaker: ${newSpeaker}$2`);
    if (result !== this.current) this.pushEdit(result);
  }

  /** Change a single segment's timestamp. */
  changeSegmentTime(speaker: string, oldTime: string, newTime: string) {
    const pattern = new RegExp(
      `(\\n---\\nspeaker:\\s*${escapeRegex(speaker)}\\n)time:\\s*${escapeRegex(oldTime)}`,
      "g",
    );
    const result = this.current.replace(pattern, `$1time: ${newTime}`);
    if (result !== this.current) this.pushEdit(result);
  }

  /** Merge a segment into the one above it. The segment's text is appended
   *  to the previous segment and this block is removed. */
  mergeSegmentUp(speaker: string, time: string) {
    const [fm, body] = splitFrontmatter(this.current);
    const segs = parseTranscriptForEdit(body);
    const idx = segs.findIndex((s) => s.speaker === speaker && s.time === time);
    if (idx <= 0) return;
    segs[idx - 1].lines.push(...segs[idx].lines);
    segs.splice(idx, 1);
    this.pushEdit(fm + serializeSegs(segs));
  }

  /** Merge a segment into the one below it. The segment's text is prepended
   *  to the next segment and this block is removed. */
  mergeSegmentDown(speaker: string, time: string) {
    const [fm, body] = splitFrontmatter(this.current);
    const segs = parseTranscriptForEdit(body);
    const idx = segs.findIndex((s) => s.speaker === speaker && s.time === time);
    if (idx < 0 || idx >= segs.length - 1) return;
    segs[idx + 1].lines = [...segs[idx].lines, ...segs[idx + 1].lines];
    segs.splice(idx, 1);
    this.pushEdit(fm + serializeSegs(segs));
  }

  /** Split a segment at a character position within the joined text.
   *  Text before charPos stays with aboveSpeaker; text from charPos
   *  onward goes to belowSpeaker. */
  splitSegment(
    speaker: string,
    time: string,
    charPos: number,
    aboveSpeaker: string,
    belowSpeaker: string,
    belowTime: string,
  ) {
    const [fm, body] = splitFrontmatter(this.current);
    const segs = parseTranscriptForEdit(body);
    const idx = segs.findIndex((s) => s.speaker === speaker && s.time === time);
    if (idx < 0) return;
    const seg = segs[idx];
    const fullText = seg.lines.join("\n");
    if (charPos <= 0 || charPos >= fullText.length) return;

    const beforeText = fullText.slice(0, charPos).trim();
    const afterText = fullText.slice(charPos).trim();
    if (!beforeText || !afterText) return;

    const firstLines = beforeText.split("\n").filter((l) => l.trim());
    const secondLines = afterText.split("\n").filter((l) => l.trim());

    segs.splice(
      idx,
      1,
      { ...seg, speaker: aboveSpeaker, lines: firstLines },
      {
        speaker: belowSpeaker,
        time: belowTime,
        seconds: 0,
        lines: secondLines,
        irrelevant: seg.irrelevant,
        index: 0,
      },
    );
    this.pushEdit(fm + serializeSegs(segs));
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Helpers for structural editing ---

import { parseTranscript, serializeTranscript } from "$lib/transcript";
import type { Segment } from "$lib/transcript";

function splitFrontmatter(doc: string): [string, string] {
  const match = doc.match(/^(---\n[\s\S]*?\n---\n)([\s\S]*)$/);
  if (!match) return ["", doc];
  return [match[1], match[2]];
}

function parseTranscriptForEdit(body: string): Segment[] {
  return parseTranscript(body);
}

function serializeSegs(segs: Segment[]): string {
  return serializeTranscript(segs);
}

// --- Diff utilities ---

export interface DiffLine {
  type: "same" | "add" | "remove";
  text: string;
  lineNum?: number;
}

export function computeDiff(original: string, modified: string): DiffLine[] {
  const oldLines = original.split("\n");
  const newLines = modified.split("\n");
  const result: DiffLine[] = [];

  // Simple LCS-based diff
  const lcs = lcsTable(oldLines, newLines);
  let i = oldLines.length;
  let j = newLines.length;
  const stack: DiffLine[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      stack.push({ type: "same", text: oldLines[i - 1], lineNum: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || lcs[i][j - 1] >= lcs[i - 1][j])) {
      stack.push({ type: "add", text: newLines[j - 1], lineNum: j });
      j--;
    } else {
      stack.push({ type: "remove", text: oldLines[i - 1], lineNum: i });
      i--;
    }
  }

  stack.reverse();

  // Only return chunks around changes (context of 3 lines)
  const changed = new Set<number>();
  stack.forEach((line, idx) => {
    if (line.type !== "same") {
      for (let k = Math.max(0, idx - 3); k <= Math.min(stack.length - 1, idx + 3); k++) {
        changed.add(k);
      }
    }
  });

  let lastIncluded = -1;
  for (let idx = 0; idx < stack.length; idx++) {
    if (changed.has(idx)) {
      if (lastIncluded >= 0 && idx - lastIncluded > 1) {
        result.push({ type: "same", text: "..." });
      }
      result.push(stack[idx]);
      lastIncluded = idx;
    }
  }

  return result;
}

function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const table: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      table[i][j] =
        a[i - 1] === b[j - 1]
          ? table[i - 1][j - 1] + 1
          : Math.max(table[i - 1][j], table[i][j - 1]);
    }
  }
  return table;
}
