/**
 * Document store for editing ingest markdown with full undo/redo.
 *
 * Every edit produces a new version of the markdown text.
 * History is tracked for undo/redo. State auto-saves to localStorage.
 */

import yaml from "js-yaml";

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

  /** Update the speakers list in the frontmatter.
   *  Uses js-yaml to parse/serialise the frontmatter properly so we
   *  don't corrupt other fields. */
  updateFrontmatterSpeakers(speakers: string[]) {
    const [rawFm, body] = splitFrontmatter(this.current);
    // Strip the --- delimiters to get just the YAML content
    const fmContent = rawFm.replace(/^---\n/, "").replace(/---\n$/, "");
    const doc = (yaml.load(fmContent) as Record<string, unknown>) ?? {};
    doc.speakers = speakers.length > 0 ? speakers : undefined;
    const newFmContent = yaml.dump(doc, {
      lineWidth: -1,
      quotingType: '"',
      forceQuotes: false,
      sortKeys: false,
    });
    const newFm = `---\n${newFmContent}---\n`;
    const result = newFm + body;
    if (result !== this.current) this.pushEdit(result);
  }

  /** Replace the entire document content (frontmatter + body). */
  editRaw(newContent: string) {
    if (newContent !== this.current) this.pushEdit(newContent);
  }

  /** Replace the body (everything after the frontmatter) while preserving
   *  the frontmatter exactly as-is. */
  editBody(newBody: string) {
    const [fm] = splitFrontmatter(this.current);
    const result = fm + newBody;
    if (result !== this.current) this.pushEdit(result);
  }

  renameSpeaker(oldId: string, newName: string) {
    this.editSegments((segs) => {
      let changed = false;
      for (const seg of segs) {
        if (seg.speaker === oldId) {
          seg.speaker = newName;
          changed = true;
        }
      }
      return changed;
    });
  }

  mergeSpeakers(sourceIds: string[], targetName: string) {
    this.editSegments((segs) => {
      let changed = false;
      for (const seg of segs) {
        if (sourceIds.includes(seg.speaker) && seg.speaker !== targetName) {
          seg.speaker = targetName;
          changed = true;
        }
      }
      return changed;
    });
  }

  // --- All structural operations use parse-modify-serialize ---

  private editSegments(fn: (segs: Segment[]) => boolean) {
    const [fm, body] = splitFrontmatter(this.current);
    const segs = parseTranscriptForEdit(body);
    if (fn(segs)) {
      this.pushEdit(fm + serializeSegs(segs));
    }
  }

  private findSegment(segs: Segment[], speaker: string, time: string): number {
    return segs.findIndex((s) => s.speaker === speaker && s.time === time);
  }

  setIrrelevant(targets: { speaker: string; time: string }[], irrelevant: boolean) {
    this.editSegments((segs) => {
      let changed = false;
      for (const { speaker, time } of targets) {
        const idx = this.findSegment(segs, speaker, time);
        if (idx >= 0 && segs[idx].irrelevant !== irrelevant) {
          segs[idx].irrelevant = irrelevant;
          changed = true;
        }
      }
      return changed;
    });
  }

  mergeAdjacentSpeakers() {
    this.editSegments((segs) => {
      const original = segs.length;
      for (let i = segs.length - 1; i > 0; i--) {
        if (segs[i].speaker === segs[i - 1].speaker) {
          segs[i - 1].lines.push(...segs[i].lines);
          segs.splice(i, 1);
        }
      }
      return segs.length < original;
    });
  }

  changeSegmentSpeaker(oldSpeaker: string, time: string, newSpeaker: string) {
    this.editSegments((segs) => {
      const idx = this.findSegment(segs, oldSpeaker, time);
      if (idx < 0) return false;
      segs[idx].speaker = newSpeaker;
      return true;
    });
  }

  changeSegmentTime(speaker: string, oldTime: string, newTime: string) {
    this.editSegments((segs) => {
      const idx = this.findSegment(segs, speaker, oldTime);
      if (idx < 0) return false;
      segs[idx].time = newTime;
      return true;
    });
  }

  mergeSegmentUp(speaker: string, time: string) {
    this.editSegments((segs) => {
      const idx = this.findSegment(segs, speaker, time);
      if (idx <= 0) return false;
      segs[idx - 1].lines.push(...segs[idx].lines);
      segs.splice(idx, 1);
      return true;
    });
  }

  mergeSegmentDown(speaker: string, time: string) {
    this.editSegments((segs) => {
      const idx = this.findSegment(segs, speaker, time);
      if (idx < 0 || idx >= segs.length - 1) return false;
      segs[idx + 1].lines = [...segs[idx].lines, ...segs[idx + 1].lines];
      segs.splice(idx, 1);
      return true;
    });
  }

  splitSegment(
    speaker: string,
    time: string,
    charPos: number,
    aboveSpeaker: string,
    belowSpeaker: string,
    belowTime: string,
  ) {
    this.editSegments((segs) => {
      const idx = this.findSegment(segs, speaker, time);
      if (idx < 0) return false;
      const seg = segs[idx];
      const fullText = seg.lines.join("\n");
      if (charPos <= 0 || charPos >= fullText.length) return false;

      const beforeText = fullText.slice(0, charPos).trim();
      const afterText = fullText.slice(charPos).trim();
      if (!beforeText || !afterText) return false;

      segs.splice(
        idx,
        1,
        { ...seg, speaker: aboveSpeaker, lines: beforeText.split("\n").filter((l) => l.trim()) },
        {
          speaker: belowSpeaker,
          time: belowTime,
          seconds: 0,
          lines: afterText.split("\n").filter((l) => l.trim()),
          irrelevant: seg.irrelevant,
          index: 0,
        },
      );
      return true;
    });
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
