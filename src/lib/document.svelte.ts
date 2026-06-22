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
    const newKey = `workbench:doc:${contentHash}`;
    // Idempotent: if we've already loaded this exact ingest, keep in-memory
    // state untouched. Without this, a redundant load() call could overwrite
    // unsaved edits with older localStorage contents.
    if (this.storageKey === newKey && this.original === markdown) {
      return;
    }
    this.storageKey = newKey;
    this.original = markdown;

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
    // Only persist the last few undo entries to avoid blowing localStorage's
    // ~5MB quota. Each entry is the full markdown text, so 200 entries for a
    // 50KB file would be 10MB - well over the limit.
    const maxStoredHistory = 20;
    const trimmedPast = this.past.slice(-maxStoredHistory);
    const payload = JSON.stringify({
      current: this.current,
      past: trimmedPast,
      future: this.future.slice(0, maxStoredHistory),
    });
    try {
      localStorage.setItem(this.storageKey, payload);
    } catch (e) {
      // Quota exceeded - try again with no history at all
      console.warn("[doc.save] localStorage quota exceeded, saving without history");
      try {
        localStorage.setItem(
          this.storageKey,
          JSON.stringify({ current: this.current, past: [], future: [] }),
        );
      } catch {
        console.error("[doc.save] localStorage save failed entirely");
      }
    }
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
    const result = rewriteFrontmatterSpeakers(rawFm, speakers) + body;
    if (result !== this.current) this.pushEdit(result);
  }

  /** Set one or more top-level frontmatter fields in a single undo step. A
   *  value of "" or [] drops the key. Used for editable metadata (creators,
   *  publisher); commits back to ingests through the normal submit path. */
  updateFrontmatter(fields: Record<string, string | string[]>) {
    const [rawFm, body] = splitFrontmatter(this.current);
    const result = rewriteFrontmatterFields(rawFm, fields) + body;
    if (result !== this.current) this.pushEdit(result);
  }

  /** Serialise edited word runs back into a body AND reconcile the frontmatter
   *  `speakers:` list to the named speakers now present in those runs, returning
   *  the combined frontmatter + body. A single pushEdit of this result keeps the
   *  body change and the frontmatter reconcile in one undo step. */
  private serialiseWithReconcile(
    fm: string,
    parsed: ReturnType<typeof parseWords>,
    newRuns: ReturnType<typeof reassignSpeaker>,
  ): string {
    const newBody = serializeWords(parsed.words, newRuns, parsed.lineEndWords, parsed.preamble);
    // Reconcile the frontmatter speakers: KEEP real names the reviewer curated,
    // even when they have no body occurrences (a name added before assigning,
    // or un-named from the body) - only the user removes named speakers; auto-
    // pruning empties was the bug. DROP stray default "Speaker N" entries (those
    // are auto-removable). ADD real names now present in the body. Rewrite only
    // when the list actually changes, so unaffected edits stay byte-for-byte.
    const currentNamed = extractFrontmatterSpeakers(fm);
    const bodyNamed = namedSpeakersInOrder(newRuns);
    const kept = currentNamed.filter((n) => !isDefaultSpeakerName(n));
    const merged = [...kept, ...bodyNamed.filter((n) => !kept.includes(n))];
    const same =
      merged.length === currentNamed.length && merged.every((n, i) => n === currentNamed[i]);
    const newFm = same ? fm : rewriteFrontmatterSpeakers(fm, merged);
    return newFm + newBody;
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

  /** Reassign a contiguous run of timestamped words [fromGIndex, toGIndex]
   *  to `newSpeaker` in a per-word-timestamp (PWTS) body, then write the
   *  result back through the same undo/history/draft funnel as segment edits.
   *  The whole point of PWTS is to keep every word's `{{t:N.N}}` marker, so
   *  serializeWords retains them; the original line-break structure is
   *  reproduced from `lineEndWords`. The caller guarantees the range lies
   *  within a single speaker run. */
  reassignWords(fromGIndex: number, toGIndex: number, newSpeaker: string) {
    const [fm, body] = splitFrontmatter(this.current);
    const parsed = parseWords(body);
    const newRuns = reassignSpeaker(parsed.runs, fromGIndex, toGIndex, newSpeaker);
    const result = this.serialiseWithReconcile(fm, parsed, newRuns);
    if (result !== this.current) this.pushEdit(result);
  }

  /** Rename a speaker everywhere in a PWTS body to `newName` (all their turns),
   *  merging with any existing speaker of that name, then reconcile the
   *  frontmatter - all in one undo step. No-op when empty or unchanged. */
  renameWordSpeaker(oldName: string, newName: string) {
    if (!newName || oldName === newName) return;
    const [fm, body] = splitFrontmatter(this.current);
    const parsed = parseWords(body);
    const newRuns = renameSpeakerInRuns(parsed.runs, oldName, newName);
    const result = this.serialiseWithReconcile(fm, parsed, newRuns);
    if (result !== this.current) this.pushEdit(result);
  }

  /** Edit a single word's text in a PWTS body. A SPACE splits it into several
   *  words - each new piece gets a start evenly spaced in the gap before the
   *  next word (the first keeps the original start), so missed/merged speech
   *  the reviewer types in (e.g. "right? yes") becomes separate, separately-
   *  timestamped, reassignable words. With no space it just replaces the text.
   *  Braces are stripped (they'd corrupt the {{t:}} grammar). */
  editWord(gIndex: number, text: string) {
    const clean = text.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
    if (!clean) return;
    const [fm, body] = splitFrontmatter(this.current);
    const parsed = parseWords(body);
    const next = splitWord(parsed, gIndex, clean.split(" "));
    const newBody = serializeWords(next.words, next.runs, next.lineEndWords, next.preamble);
    const result = fm + newBody;
    if (result !== this.current) this.pushEdit(result);
  }

  /** Set a single word's start time, clamped between its neighbours' starts so
   *  word order stays monotonic (the time can't pass the word before or after
   *  it). Used by the time-nudge / slider controls. */
  setWordTime(gIndex: number, start: number) {
    const [fm, body] = splitFrontmatter(this.current);
    const parsed = parseWords(body);
    if (gIndex < 0 || gIndex >= parsed.words.length) return;
    const prev = gIndex > 0 ? parsed.words[gIndex - 1].start : 0;
    const next = gIndex + 1 < parsed.words.length ? parsed.words[gIndex + 1].start : start + 1;
    const clamped = Math.max(prev, Math.min(next, start));
    if (Math.abs(clamped - parsed.words[gIndex].start) < 0.005) return;
    parsed.words[gIndex] = { ...parsed.words[gIndex], start: clamped };
    const newBody = serializeWords(parsed.words, parsed.runs, parsed.lineEndWords, parsed.preamble);
    const result = fm + newBody;
    if (result !== this.current) this.pushEdit(result);
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

  /** Mark segments as irrelevant by changing their speaker to [irrelevant].
   *  Pass the original speaker name so we can restore it if toggling back. */
  setSegmentsSpeaker(targets: { speaker: string; time: string }[], newSpeaker: string) {
    this.editSegments((segs) => {
      let changed = false;
      for (const { speaker, time } of targets) {
        const idx = this.findSegment(segs, speaker, time);
        if (idx >= 0 && segs[idx].speaker !== newSpeaker) {
          segs[idx].speaker = newSpeaker;
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

  editSegment(
    oldSpeaker: string,
    oldTime: string,
    newSpeaker: string,
    newTime: string,
    newText: string,
  ) {
    this.editSegments((segs) => {
      const idx = this.findSegment(segs, oldSpeaker, oldTime);
      if (idx < 0) return false;
      segs[idx].speaker = newSpeaker;
      segs[idx].time = newTime;
      segs[idx].lines = newText.split("\n").filter((l) => l.trim());
      return true;
    });
  }

  /** Edit a segment identified by its parse-order index rather than by
   *  (speaker, time). Index is unique; (speaker, time) is not - two
   *  segments can share both (e.g. the two halves immediately after a
   *  split), in which case a (speaker, time) lookup hits the first match,
   *  not necessarily the one the reviewer clicked. The edit dialog knows
   *  the exact index, so it uses this. */
  editSegmentByIndex(index: number, newSpeaker: string, newTime: string, newText: string) {
    this.editSegments((segs) => {
      const target = segs.find((s) => s.index === index);
      if (!target) return false;
      target.speaker = newSpeaker;
      target.time = newTime;
      target.lines = newText.split("\n").filter((l) => l.trim());
      return true;
    });
  }

  /** Append a segment's text onto a target segment as one continuous run
   *  (single space between), then remove the source segment. The merged
   *  text collapses into the target's last line so it reads as one
   *  sentence rather than two stacked timestamped lines. The target keeps
   *  its own timestamp and speaker. The target must sit before the source
   *  in document order - the caller resolves "the segment above" (which,
   *  with irrelevant segments hidden, is the previous *visible* segment,
   *  not necessarily the previous document segment). */
  mergeSegmentInto(fromSpeaker: string, fromTime: string, intoSpeaker: string, intoTime: string) {
    this.editSegments((segs) => {
      const fromIdx = this.findSegment(segs, fromSpeaker, fromTime);
      const intoIdx = this.findSegment(segs, intoSpeaker, intoTime);
      if (fromIdx < 0 || intoIdx < 0 || intoIdx >= fromIdx) return false;
      const intoText = segs[intoIdx].lines.join(" ").trim();
      const fromText = segs[fromIdx].lines.join(" ").trim();
      const merged = [intoText, fromText].filter(Boolean).join(" ");
      segs[intoIdx].lines = merged ? [merged] : [];
      segs.splice(fromIdx, 1);
      return true;
    });
  }

  /** Merge a segment into the one immediately above it in document order. */
  mergeSegmentUp(speaker: string, time: string) {
    this.editSegments((segs) => {
      const idx = this.findSegment(segs, speaker, time);
      if (idx <= 0) return false;
      const prev = segs[idx - 1];
      const prevText = prev.lines.join(" ").trim();
      const thisText = segs[idx].lines.join(" ").trim();
      const merged = [prevText, thisText].filter(Boolean).join(" ");
      prev.lines = merged ? [merged] : [];
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

  /** Replace one segment with N consecutive pieces in a single edit. Each
   *  piece carries its own speaker, timestamp, and text - the SplitEditor
   *  works out the boundaries and the interpolated timestamps. seconds/index
   *  are placeholders; editSegments serialises and reparses, which recomputes
   *  both from the written time and document order. Needs at least two
   *  non-empty pieces, otherwise it's a no-op. */
  splitSegmentMulti(
    speaker: string,
    time: string,
    pieces: { speaker: string; time: string; text: string }[],
  ) {
    this.editSegments((segs) => {
      const idx = this.findSegment(segs, speaker, time);
      if (idx < 0) return false;

      const newSegs = pieces
        .map((p) => ({
          speaker: p.speaker,
          time: p.time,
          seconds: 0,
          lines: p.text.split("\n").filter((l) => l.trim()),
          index: 0,
        }))
        .filter((s) => s.lines.length > 0);
      if (newSegs.length < 2) return false;

      segs.splice(idx, 1, ...newSegs);
      return true;
    });
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Helpers for structural editing ---

import {
  parseTranscript,
  serializeTranscript,
  extractFrontmatterSpeakers,
  isDefaultSpeakerName,
} from "$lib/transcript";
import type { Segment } from "$lib/transcript";
import {
  parseWords,
  serializeWords,
  reassignSpeaker,
  renameSpeakerInRuns,
  namedSpeakersInOrder,
  splitWord,
} from "$lib/transcript-words";

function splitFrontmatter(doc: string): [string, string] {
  const match = doc.match(/^(---\n[\s\S]*?\n---\n)([\s\S]*)$/);
  if (!match) return ["", doc];
  return [match[1], match[2]];
}

/** Rewrite (or remove) the `speakers:` key in a `---`-delimited frontmatter
 *  block via js-yaml, leaving every other key untouched. An empty list drops
 *  the key entirely. */
function rewriteFrontmatterSpeakers(rawFm: string, speakers: string[]): string {
  return rewriteFrontmatterFields(rawFm, { speakers });
}

/** Set top-level frontmatter keys via js-yaml, leaving every other key (and
 *  nested blocks like `copyright:`) untouched. A value of "" or [] drops the
 *  key entirely. Trims string values and list items, dropping empty items. */
function rewriteFrontmatterFields(
  rawFm: string,
  fields: Record<string, string | string[]>,
): string {
  const fmContent = rawFm.replace(/^---\n/, "").replace(/---\n$/, "");
  const doc = (yaml.load(fmContent) as Record<string, unknown>) ?? {};
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      const items = value.map((v) => v.trim()).filter((v) => v !== "");
      doc[key] = items.length > 0 ? items : undefined;
    } else {
      const trimmed = value.trim();
      doc[key] = trimmed !== "" ? trimmed : undefined;
    }
  }
  const newFmContent = yaml.dump(doc, {
    lineWidth: -1,
    quotingType: '"',
    forceQuotes: false,
    sortKeys: false,
  });
  return `---\n${newFmContent}---\n`;
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
