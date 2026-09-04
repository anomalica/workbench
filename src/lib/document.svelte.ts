/**
 * Document store for editing ingest markdown with full undo/redo.
 *
 * Every edit produces a new version of the markdown text.
 * History is tracked for undo/redo. State auto-saves to localStorage.
 */

import yaml from "js-yaml";
import { type DraftPatch, decodePatch, encodePatch, patchSize } from "./draft-patch";

const MAX_HISTORY = 200;

/** The `speakers:` list is a list of PEOPLE, so a trailing qualifier comes off:
 *  the body line says `Scott Gordon [KXAS]`, where the station reads with the
 *  line, and the list says `Scott Gordon`, which is what another record reuses
 *  and what extraction makes a node from. Deduped, because one person filing
 *  under two stations is still one person. */
function speakerIdentities(names: string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    const id = speakerIdentity(name);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

export class DocumentStore {
  original = $state("");
  current = $state("");
  past = $state<string[]>([]);
  future = $state<string[]>([]);
  storageKey = $state("");
  /** True when the last local save attempt failed (e.g. localStorage quota
   *  exceeded) - the in-memory edit is NOT durably saved. Must never fail
   *  silently: the viewer shows a persistent warning banner while this is
   *  true, because a page reload from here loses the edit entirely. Cleared
   *  on the next successful save. */
  saveFailed = $state(false);

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
        const restored = this.readDraft(state, markdown);
        if (restored) {
          this.current = restored.current;
          this.past = restored.past;
          this.future = restored.future;
          // A draft in the old whole-copy format is rewritten as a patch on
          // sight rather than on the reviewer's next edit - it is the drafts
          // for books they are NOT editing right now that fill the quota.
          if (state.v !== 2) this.save();
          return;
        }
        // A patch that will not apply means the record changed underneath the
        // draft. Dropping it is the only safe move - splicing the reviewer's
        // lines into a document they never saw would be worse than losing
        // them - and keeping the dead key would just consume quota.
        localStorage.removeItem(this.storageKey);
      } catch {
        // Corrupted save, start fresh
      }
    }

    this.current = markdown;
    this.past = [];
    this.future = [];
  }

  /** Read either shape: v2 patches, or the pre-patch drafts that hold whole
   *  copies of the document. The old ones are still someone's unsaved work, so
   *  they are honoured on the way in and rewritten as patches on the next
   *  save. */
  private readDraft(
    state: Record<string, unknown>,
    markdown: string,
  ): { current: string; past: string[]; future: string[] } | null {
    if (state.v === 2) {
      const apply = (patch: unknown) => (patch ? decodePatch(markdown, patch as DraftPatch) : null);
      const current = apply(state.patch);
      if (current === null) return null;
      const seq = (list: unknown) =>
        ((list as DraftPatch[] | undefined) ?? [])
          .map(apply)
          .filter((t): t is string => t !== null);
      return { current, past: seq(state.past), future: seq(state.future) };
    }
    if (typeof state.current !== "string") return null;
    return {
      current: state.current,
      past: (state.past as string[]) ?? [],
      future: (state.future as string[]) ?? [],
    };
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
    // Nothing to protect: the browser's copy matches the server's, so a draft
    // would only consume quota another record's real work may need. This is
    // what clears the key after a submit, and after an undo back to where the
    // reviewer started. Undo/redo history is not work - it survives in memory
    // for the session, and a reload from here loses a keystroke, not an edit.
    if (!this.dirty) {
      localStorage.removeItem(this.storageKey);
      this.saveFailed = false;
      return;
    }

    const patch = encodePatch(this.original, this.current);
    // History is a convenience; the current text is the work. So history is
    // kept only while it is affordable, newest first, and dropped entirely
    // before the edit itself is ever at risk.
    const budget = 512 * 1024;
    let spent = patchSize(patch);
    const affordable = (versions: string[]) => {
      const out: DraftPatch[] = [];
      for (const v of versions) {
        const p = encodePatch(this.original, v);
        const size = patchSize(p);
        if (spent + size > budget) break;
        spent += size;
        out.push(p);
      }
      return out;
    };
    // Reversed so the entries nearest the present survive the budget, then
    // restored to chronological order for readDraft.
    const past = affordable([...this.past].reverse()).reverse();
    const future = affordable(this.future);

    for (const payload of [
      JSON.stringify({ v: 2, patch, past, future }),
      JSON.stringify({ v: 2, patch, past: [], future: [] }),
    ]) {
      try {
        localStorage.setItem(this.storageKey, payload);
        this.saveFailed = false;
        return;
      } catch {
        // Quota exceeded - retry with no history at all.
      }
    }

    // Both attempts failed: the edit exists only in this tab's memory. This
    // must NEVER fail silently - a reload from here loses it for good (this
    // is exactly what happened to a 3-hour review once). saveFailed drives a
    // blocking banner in the viewer; nothing else can substitute for it,
    // since there is no other durable place this edit exists yet.
    console.error("[doc.save] localStorage save failed entirely - edit is NOT saved");
    this.saveFailed = true;
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
    // Identities, wherever the list is written from: this is the one door the
    // `speakers:` list is written through, including a reviewer typing a name
    // straight into the panel, and it is a list of PEOPLE. A line may introduce
    // somebody with where they are from - `Scott Gordon [KXAS]` - and that
    // belongs to the line, not to him.
    const result = rewriteFrontmatterSpeakers(rawFm, speakerIdentities(speakers)) + body;
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
    const newBody = serializeWords(
      parsed.words,
      newRuns,
      parsed.lineEndWords,
      parsed.preamble,
      parsed.highlights,
      parsed.spanNotes,
      parsed.highlightContexts,
      parsed.links,
      parsed.externals,
      parsed.citedWorks,
    );
    // Reconcile the frontmatter speakers: KEEP real names the reviewer curated,
    // even when they have no body occurrences (a name added before assigning,
    // or un-named from the body) - only the user removes named speakers; auto-
    // pruning empties was the bug. DROP stray default "Speaker N" entries (those
    // are auto-removable). ADD real names now present in the body. Rewrite only
    // when the list actually changes, so unaffected edits stay byte-for-byte.
    const currentNamed = extractFrontmatterSpeakers(fm);
    // A voice heard only inside a quoted passage is NOT added: they were never
    // in this recording, and adding them made the record claim them as a
    // participant. It also fought the reviewer - deleting the name from the
    // list put it straight back on the next edit, over and over.
    const quotedOnly = new Set(quotedSpeakerCounts(newRuns, parsed.externals).map((r) => r.id));
    const bodyNamed = speakerIdentities(
      namedSpeakersInOrder(newRuns).filter((n) => !quotedOnly.has(n)),
    );
    const kept = speakerIdentities(
      currentNamed.filter((n) => !recordScopedSpeaker(n) && !quotedOnly.has(n)),
    );
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
    const newBody = serializeWords(
      next.words,
      next.runs,
      next.lineEndWords,
      next.preamble,
      next.highlights,
      next.spanNotes,
      next.highlightContexts,
      next.links,
      next.externals,
      next.citedWorks,
    );
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
    const newBody = serializeWords(
      parsed.words,
      parsed.runs,
      parsed.lineEndWords,
      parsed.preamble,
      parsed.highlights,
      parsed.spanNotes,
      parsed.highlightContexts,
      parsed.links,
      parsed.externals,
      parsed.citedWorks,
    );
    const result = fm + newBody;
    if (result !== this.current) this.pushEdit(result);
  }

  /** Replace a selected word range [from, to] (within one speaker run) with an
   *  edited set of words (text + start) - the multi-word selection editor's save.
   *  Handles delete/insert/retext/retime in one undo step, then reconciles the
   *  frontmatter speakers (a delete could remove a speaker's last words). */
  replaceSelection(from: number, to: number, newWords: { text: string; start: number }[]) {
    const [fm, body] = splitFrontmatter(this.current);
    const parsed = parseWords(body);
    if (from < 0 || to >= parsed.words.length || from > to) return;
    const next = replaceWordRange(parsed, from, to, newWords);
    const newBody = serializeWords(
      next.words,
      next.runs,
      next.lineEndWords,
      next.preamble,
      next.highlights,
      next.spanNotes,
      next.highlightContexts,
      next.links,
      next.externals,
      next.citedWorks,
    );
    // Reconcile frontmatter speakers to those still present (mirrors
    // serialiseWithReconcile): keep curated named speakers, drop default
    // "Speaker N" entries, add any new names, rewrite only on change.
    const currentNamed = extractFrontmatterSpeakers(fm);
    const quotedOnly = new Set(quotedSpeakerCounts(next.runs, next.externals).map((r) => r.id));
    const bodyNamed = speakerIdentities(
      namedSpeakersInOrder(next.runs).filter((n) => !quotedOnly.has(n)),
    );
    const kept = speakerIdentities(
      currentNamed.filter((n) => !recordScopedSpeaker(n) && !quotedOnly.has(n)),
    );
    const merged = [...kept, ...bodyNamed.filter((n) => !kept.includes(n))];
    const same =
      merged.length === currentNamed.length && merged.every((n, i) => n === currentNamed[i]);
    const result = (same ? fm : rewriteFrontmatterSpeakers(fm, merged)) + newBody;
    if (result !== this.current) this.pushEdit(result);
  }

  /** Attach a inline event note (`{{laughs}}`) as a first-class annotation
   *  FOLLOWING the word at time `at` (the last word starting at or before it) in
   *  a per-word-timestamp body. The note is not a word: it carries no timestamp,
   *  is never tokenised, and adds no gIndex - so coverage and the observed set
   *  are untouched. The pre-digest keeps the bare `[...]` the digester reads as a
   *  meta event - the word-record twin of the segment editor's quick-insert. */
  insertEventNote(at: number, text: string) {
    const token = noteInner(text);
    if (!token) return;
    const [, body] = splitFrontmatter(this.current);
    const parsed = parseWords(body);
    if (parsed.words.length === 0) return;
    const anchor = Math.max(0, eventNoteAnchorIndex(parsed.words, at));
    const words = parsed.words.map((w, i) =>
      i === anchor ? { ...w, notes: [...(w.notes ?? []), token] } : w,
    );
    this.editBody(
      serializeWords(
        words,
        parsed.runs,
        parsed.lineEndWords,
        parsed.preamble,
        parsed.highlights,
        parsed.spanNotes,
        parsed.highlightContexts,
        parsed.links,
        parsed.externals,
        parsed.citedWorks,
      ),
    );
  }

  /** Edit (or, with empty text, remove) the `ordinal`-th event note on the word
   *  at `gIndex`. The note stays a single atomic annotation - free text, spaces
   *  and all - never re-tokenised into words. */
  editWordNote(gIndex: number, ordinal: number, text: string) {
    const [, body] = splitFrontmatter(this.current);
    const parsed = parseWords(body);
    const word = parsed.words[gIndex];
    if (!word?.notes || ordinal < 0 || ordinal >= word.notes.length) return;
    const token = noteInner(text);
    const notes = [...word.notes];
    if (token) notes[ordinal] = token;
    else notes.splice(ordinal, 1);
    const words = parsed.words.map((w, i) =>
      i === gIndex ? { ...w, notes: notes.length ? notes : undefined } : w,
    );
    this.editBody(
      serializeWords(
        words,
        parsed.runs,
        parsed.lineEndWords,
        parsed.preamble,
        parsed.highlights,
        parsed.spanNotes,
        parsed.highlightContexts,
        parsed.links,
        parsed.externals,
        parsed.citedWorks,
      ),
    );
  }

  removeWordNote(gIndex: number, ordinal: number) {
    this.editWordNote(gIndex, ordinal, "");
  }

  /** Highlight the inclusive word range [from, to] in a PWTS body: mint a fresh
   *  id and write the inline `{{highlight-start/end: id}}` marker pair around the
   *  words. Overlap-capable - a new highlight never disturbs an existing one. */
  /** Add another part to an existing highlight: same id, a second range.
   *
   *  The evidence for one claim is often not contiguous - the part that matters
   *  sits at the top and bottom of a paragraph with unrelated material between.
   *  A highlight is the unit of expected extraction, so covering the whole
   *  paragraph tells the grader "one claim from all of this" and stops saying
   *  which (ingest-format.md, "A highlight may be EXTENDED").
   *
   *  Mints NO id - that is the point of it - so the overlay counter, the
   *  never-reuse guarantee and any cross-record link addressing this highlight
   *  are all untouched. */
  extendWordHighlight(id: string, from: number, to: number) {
    const [fm, body] = splitFrontmatter(this.current);
    const parsed = parseWords(body);
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    if (lo < 0 || hi >= parsed.words.length) return;
    // Refuse an id the record does not already carry: extending something that
    // is not there would mint a highlight by the back door, bypassing the
    // counter that keeps ids unique.
    if (!parsed.highlights.some((h) => h.id === id)) return;
    // Overlapping an existing part of the SAME highlight would serialise as a
    // nested open of one id, which the parser cannot pair up. Parts are
    // disjoint by construction.
    if (parsed.highlights.some((h) => h.id === id && lo <= h.toWord && hi >= h.fromWord)) return;
    const highlights = [...parsed.highlights, { id, fromWord: lo, toWord: hi }];
    const result =
      fm +
      serializeWords(
        parsed.words,
        parsed.runs,
        parsed.lineEndWords,
        parsed.preamble,
        highlights,
        parsed.spanNotes,
        parsed.highlightContexts,
        parsed.links,
        parsed.externals,
        parsed.citedWorks,
      );
    if (result !== this.current) this.pushEdit(result);
  }

  addWordHighlight(from: number, to: number) {
    const [fm, body] = splitFrontmatter(this.current);
    const parsed = parseWords(body);
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    if (lo < 0 || hi >= parsed.words.length) return;
    // Mint from the record's PERSISTED counter so a deleted id is never reissued -
    // an in-memory mark resets on reload, and deriving it from extant ids drops
    // when the highest is deleted. `existing` still covers every id the record
    // MENTIONS, including ones only a retained dangling edge names, because the
    // counter must not collide with ids that never came from it.
    const { id, nextId } = mintOverlayId(overlayIdsOf(parsed), readOverlayNextId(fm));
    const fmOut = rewriteFrontmatterFields(fm, { overlay_next_id: nextId });
    const highlights = [...parsed.highlights, { id, fromWord: lo, toWord: hi }];
    const result =
      fmOut +
      serializeWords(
        parsed.words,
        parsed.runs,
        parsed.lineEndWords,
        parsed.preamble,
        highlights,
        parsed.spanNotes,
        parsed.highlightContexts,
        parsed.links,
        parsed.externals,
        parsed.citedWorks,
      );
    if (result !== this.current) this.pushEdit(result);
  }

  /** Remove a single highlight by id (the markup side-list remove). */
  removeWordHighlight(id: string) {
    const [fm, body] = splitFrontmatter(this.current);
    const parsed = parseWords(body);
    const highlights = parsed.highlights.filter((h) => h.id !== id);
    if (highlights.length === parsed.highlights.length) return;
    const result =
      fm +
      serializeWords(
        parsed.words,
        parsed.runs,
        parsed.lineEndWords,
        parsed.preamble,
        highlights,
        parsed.spanNotes,
        parsed.highlightContexts,
        parsed.links,
        parsed.externals,
        parsed.citedWorks,
      );
    if (result !== this.current) this.pushEdit(result);
  }

  /** Record that highlight `of` needs earlier highlight `needs` to be understood
   *  ("he said" -> who). Merges into the existing edge for `of` rather than
   *  adding a second one, so a highlight has ONE dependency list however many
   *  times the reviewer adds to it.
   *
   *  Self-reference and duplicates are refused rather than stored: an edge to
   *  itself says nothing, and a repeated add is the reviewer clicking twice. */
  addHighlightContext(of: string, needs: string) {
    if (!of || !needs || of === needs) return;
    const [fm, body] = splitFrontmatter(this.current);
    const parsed = parseWords(body);
    const edges = parsed.highlightContexts.map((c) => ({ ...c, needs: [...c.needs] }));
    const existing = edges.find((c) => c.of === of);
    if (existing) {
      if (existing.needs.includes(needs)) return;
      existing.needs.push(needs);
    } else {
      edges.push({ of, needs: [needs] });
    }
    this.writeWords(fm, parsed, edges);
  }

  /** Drop one dependency from a highlight's context, or the whole edge when it
   *  was the last one - an edge with no dependencies means nothing. */
  removeHighlightContext(of: string, needs: string) {
    const [fm, body] = splitFrontmatter(this.current);
    const parsed = parseWords(body);
    const edges = parsed.highlightContexts
      .map((c) => (c.of === of ? { ...c, needs: c.needs.filter((n) => n !== needs) } : c))
      .filter((c) => c.needs.length > 0);
    this.writeWords(fm, parsed, edges);
  }

  /** Re-serialise a parse with replacement context edges, everything else as-is. */
  private writeWords(
    fm: string,
    parsed: ReturnType<typeof parseWords>,
    highlightContexts: ReturnType<typeof parseWords>["highlightContexts"],
  ) {
    const result =
      fm +
      serializeWords(
        parsed.words,
        parsed.runs,
        parsed.lineEndWords,
        parsed.preamble,
        parsed.highlights,
        parsed.spanNotes,
        highlightContexts,
        parsed.links,
        parsed.externals,
        parsed.citedWorks,
      );
    if (result !== this.current) this.pushEdit(result);
  }

  /** Remove every highlight that overlaps the inclusive word range [from, to] -
   *  the "clear highlight" over a selection. */
  clearWordHighlights(from: number, to: number) {
    const [fm, body] = splitFrontmatter(this.current);
    const parsed = parseWords(body);
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const highlights = parsed.highlights.filter((h) => h.toWord < lo || h.fromWord > hi);
    if (highlights.length === parsed.highlights.length) return;
    const result =
      fm +
      serializeWords(
        parsed.words,
        parsed.runs,
        parsed.lineEndWords,
        parsed.preamble,
        highlights,
        parsed.spanNotes,
        parsed.highlightContexts,
        parsed.links,
        parsed.externals,
        parsed.citedWorks,
      );
    if (result !== this.current) this.pushEdit(result);
  }

  /** Attach a span note over the inclusive word range [from, to] in a PWTS body:
   *  mint a fresh id (unique across highlights and notes) and write the
   *  `{{note-start: [id, "text"]}}` / `{{note-end: id}}` marker pair around the
   *  words. Overlap-capable - a new note never disturbs an existing span. Braces
   *  are stripped from the text (they would corrupt the `{{ }}` grammar). */
  addWordSpanNote(from: number, to: number, text: string) {
    const clean = sanitiseNoteText(text);
    if (!clean) return;
    const [fm, body] = splitFrontmatter(this.current);
    const parsed = parseWords(body);
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    if (lo < 0 || hi >= parsed.words.length) return;
    // Mint from the record's PERSISTED counter so a deleted id is never reissued -
    // an in-memory mark resets on reload, and deriving it from extant ids drops
    // when the highest is deleted. `existing` still covers every id the record
    // MENTIONS, including ones only a retained dangling edge names, because the
    // counter must not collide with ids that never came from it.
    const { id, nextId } = mintOverlayId(overlayIdsOf(parsed), readOverlayNextId(fm));
    const fmOut = rewriteFrontmatterFields(fm, { overlay_next_id: nextId });
    const spanNotes = [...parsed.spanNotes, { id, fromWord: lo, toWord: hi, text: clean }];
    const result =
      fmOut +
      serializeWords(
        parsed.words,
        parsed.runs,
        parsed.lineEndWords,
        parsed.preamble,
        parsed.highlights,
        spanNotes,
        parsed.highlightContexts,
        parsed.links,
        parsed.externals,
        parsed.citedWorks,
      );
    if (result !== this.current) this.pushEdit(result);
  }

  /** Edit a span note's text by id. Empty text removes the note (its markers are
   *  dropped from the body). */
  editWordSpanNote(id: string, text: string) {
    const clean = sanitiseNoteText(text);
    const [fm, body] = splitFrontmatter(this.current);
    const parsed = parseWords(body);
    if (!parsed.spanNotes.some((n) => n.id === id)) return;
    const spanNotes = clean
      ? parsed.spanNotes.map((n) => (n.id === id ? { ...n, text: clean } : n))
      : parsed.spanNotes.filter((n) => n.id !== id);
    const result =
      fm +
      serializeWords(
        parsed.words,
        parsed.runs,
        parsed.lineEndWords,
        parsed.preamble,
        parsed.highlights,
        spanNotes,
        parsed.highlightContexts,
        parsed.links,
        parsed.externals,
        parsed.citedWorks,
      );
    if (result !== this.current) this.pushEdit(result);
  }

  removeWordSpanNote(id: string) {
    this.editWordSpanNote(id, "");
  }

  /** Add a cross-record link over the inclusive word range [from, to], pinning
   *  the target record's content_hash, optionally anchored by a verbatim quote
   *  from the target (the location is re-derived from the quote at render time -
   *  the spec's durability rule; never an offset). Same paired-marker machinery
   *  and the same single overlay-id space as highlights and span notes. */
  addWordLink(from: number, to: number, targetHash: string, quote = "") {
    const target = targetHash.trim();
    if (!target) return;
    const cleanQuote = sanitiseNoteText(quote);
    const [fm, body] = splitFrontmatter(this.current);
    const parsed = parseWords(body);
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    if (lo < 0 || hi >= parsed.words.length) return;
    const { id, nextId } = mintOverlayId(overlayIdsOf(parsed), readOverlayNextId(fm));
    const fmOut = rewriteFrontmatterFields(fm, { overlay_next_id: nextId });
    const links = [
      ...parsed.links,
      {
        id,
        fromWord: lo,
        toWord: hi,
        target: `sha256:${target.replace(/^sha256:/, "")}`,
        ...(cleanQuote ? { quote: cleanQuote } : {}),
      },
    ];
    const result =
      fmOut +
      serializeWords(
        parsed.words,
        parsed.runs,
        parsed.lineEndWords,
        parsed.preamble,
        parsed.highlights,
        parsed.spanNotes,
        parsed.highlightContexts,
        links,
        parsed.externals,
        parsed.citedWorks,
      );
    if (result !== this.current) this.pushEdit(result);
  }

  /** Mark the inclusive word range [from, to] as a passage that came from
   *  somewhere else - a clip played inside this recording, a block quote from
   *  another document.
   *
   *  The speaker is untouched: the person in the clip is still the person who
   *  said it, and that is the whole point of marking the passage rather than
   *  renaming them. `description` is what the clip is; `targetHash` is the
   *  record it came from, when that record has itself been ingested - which is
   *  what lets the assimilator recognise two records quoting the same clip as
   *  one utterance rather than two independent ones. Both are optional: often
   *  the original exists only inside this video. */
  addWordExternal(from: number, to: number, description: string, targetHash = "") {
    const [fm, body] = splitFrontmatter(this.current);
    const parsed = parseWords(body);
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    if (lo < 0 || hi >= parsed.words.length) return;
    const target = targetHash.trim().replace(/^sha256:/, "");
    const { id, nextId } = mintOverlayId(overlayIdsOf(parsed), readOverlayNextId(fm));
    const fmOut = rewriteFrontmatterFields(fm, { overlay_next_id: nextId });
    const externals = [
      ...parsed.externals,
      {
        id,
        fromWord: lo,
        toWord: hi,
        description: sanitiseNoteText(description),
        ...(target ? { target: `sha256:${target}` } : {}),
      },
    ];
    // Marking a passage can empty a speaker: if everything they said is now
    // quoted, they are no longer a participant of this recording and their name
    // has to leave `speakers:` with it. Without this the name sat in Named at
    // zero words until some unrelated speaker edit happened to reconcile it.
    const quotedOnly = new Set(quotedSpeakerCounts(parsed.runs, externals).map((r) => r.id));
    const listed = extractFrontmatterSpeakers(fmOut);
    const stillHere = listed.filter((n) => !quotedOnly.has(n));
    const fmFinal =
      stillHere.length === listed.length ? fmOut : rewriteFrontmatterSpeakers(fmOut, stillHere);
    const result =
      fmFinal +
      serializeWords(
        parsed.words,
        parsed.runs,
        parsed.lineEndWords,
        parsed.preamble,
        parsed.highlights,
        parsed.spanNotes,
        parsed.highlightContexts,
        parsed.links,
        externals,
        parsed.citedWorks,
      );
    if (result !== this.current) this.pushEdit(result);
  }

  /** Record that the speaker named a work (ingest-format.md, "Cited works").
   *  It records the CITATION, never whether the corpus holds the work - that
   *  is a query, because held-ness changes and a marker written into a body
   *  cannot. */
  addWordCitedWork(
    from: number,
    to: number,
    title: string,
    creator = "",
    kind = "book",
    locators: string[] = [],
  ) {
    const clean = sanitiseNoteText(title);
    if (!clean) return;
    const [fm, body] = splitFrontmatter(this.current);
    const parsed = parseWords(body);
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    if (lo < 0 || hi >= parsed.words.length) return;
    const { id, nextId } = mintOverlayId(overlayIdsOf(parsed), readOverlayNextId(fm));
    const fmOut = rewriteFrontmatterFields(fm, { overlay_next_id: nextId });
    const who = sanitiseNoteText(creator);
    const citedWorks = [
      ...parsed.citedWorks,
      {
        id,
        fromWord: lo,
        toWord: hi,
        kind,
        title: clean,
        ...(who ? { creator: who } : {}),
        ...(locators.length ? { locators: locators.map((l) => sanitiseNoteText(l)) } : {}),
      },
    ];
    const result =
      fmOut +
      serializeWords(
        parsed.words,
        parsed.runs,
        parsed.lineEndWords,
        parsed.preamble,
        parsed.highlights,
        parsed.spanNotes,
        parsed.highlightContexts,
        parsed.links,
        parsed.externals,
        citedWorks,
      );
    if (result !== this.current) this.pushEdit(result);
  }

  editWordCitedWork(id: string, title: string, creator = "", locators?: string[]) {
    const [fm, body] = splitFrontmatter(this.current);
    const parsed = parseWords(body);
    const clean = sanitiseNoteText(title);
    if (!clean || !parsed.citedWorks.some((c) => c.id === id)) return;
    const who = sanitiseNoteText(creator);
    const citedWorks = parsed.citedWorks.map((c) =>
      c.id === id
        ? { ...c, title: clean, ...(who ? { creator: who } : { creator: undefined }) }
        : c,
    );
    const result =
      fm +
      serializeWords(
        parsed.words,
        parsed.runs,
        parsed.lineEndWords,
        parsed.preamble,
        parsed.highlights,
        parsed.spanNotes,
        parsed.highlightContexts,
        parsed.links,
        parsed.externals,
        citedWorks,
      );
    if (result !== this.current) this.pushEdit(result);
  }

  removeWordCitedWork(id: string) {
    const [fm, body] = splitFrontmatter(this.current);
    const parsed = parseWords(body);
    if (!parsed.citedWorks.some((c) => c.id === id)) return;
    const result =
      fm +
      serializeWords(
        parsed.words,
        parsed.runs,
        parsed.lineEndWords,
        parsed.preamble,
        parsed.highlights,
        parsed.spanNotes,
        parsed.highlightContexts,
        parsed.links,
        parsed.externals,
        parsed.citedWorks.filter((c) => c.id !== id),
      );
    if (result !== this.current) this.pushEdit(result);
  }

  /** Change where an existing external passage came from, in place. Removing
   *  it and re-adding on confirm meant Cancel left it removed - the reviewer
   *  opened the dialog to look, backed out, and the passage had silently
   *  stopped being external. */
  editWordExternal(id: string, description: string, targetHash = "") {
    const [fm, body] = splitFrontmatter(this.current);
    const parsed = parseWords(body);
    if (!parsed.externals.some((e) => e.id === id)) return;
    const target = targetHash.trim().replace(/^sha256:/, "");
    const externals = parsed.externals.map((e) =>
      e.id === id
        ? {
            ...e,
            description: sanitiseNoteText(description),
            ...(target ? { target: `sha256:${target}` } : { target: undefined }),
          }
        : e,
    );
    const result =
      fm +
      serializeWords(
        parsed.words,
        parsed.runs,
        parsed.lineEndWords,
        parsed.preamble,
        parsed.highlights,
        parsed.spanNotes,
        parsed.highlightContexts,
        parsed.links,
        externals,
        parsed.citedWorks,
      );
    if (result !== this.current) this.pushEdit(result);
  }

  removeWordExternal(id: string) {
    const [fm, body] = splitFrontmatter(this.current);
    const parsed = parseWords(body);
    if (!parsed.externals.some((e) => e.id === id)) return;
    const result =
      fm +
      serializeWords(
        parsed.words,
        parsed.runs,
        parsed.lineEndWords,
        parsed.preamble,
        parsed.highlights,
        parsed.spanNotes,
        parsed.highlightContexts,
        parsed.links,
        parsed.externals.filter((e) => e.id !== id),
        parsed.citedWorks,
      );
    if (result !== this.current) this.pushEdit(result);
  }

  removeWordLink(id: string) {
    const [fm, body] = splitFrontmatter(this.current);
    const parsed = parseWords(body);
    if (!parsed.links.some((l) => l.id === id)) return;
    const links = parsed.links.filter((l) => l.id !== id);
    const result =
      fm +
      serializeWords(
        parsed.words,
        parsed.runs,
        parsed.lineEndWords,
        parsed.preamble,
        parsed.highlights,
        parsed.spanNotes,
        parsed.highlightContexts,
        links,
        parsed.externals,
        parsed.citedWorks,
      );
    if (result !== this.current) this.pushEdit(result);
  }

  /** Re-range an existing span note to the inclusive word range [from, to] -
   *  the draggable-ends operation. Keeps the note's id and text. */
  setWordSpanNoteRange(id: string, from: number, to: number) {
    const [fm, body] = splitFrontmatter(this.current);
    const parsed = parseWords(body);
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    if (lo < 0 || hi >= parsed.words.length) return;
    if (!parsed.spanNotes.some((n) => n.id === id)) return;
    const spanNotes = parsed.spanNotes.map((n) =>
      n.id === id ? { ...n, fromWord: lo, toWord: hi } : n,
    );
    const result =
      fm +
      serializeWords(
        parsed.words,
        parsed.runs,
        parsed.lineEndWords,
        parsed.preamble,
        parsed.highlights,
        spanNotes,
        parsed.highlightContexts,
        parsed.links,
        parsed.externals,
        parsed.citedWorks,
      );
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
  speakerIdentity,
  isAnonymousSpeaker,
  isDefaultSpeakerName,
} from "$lib/transcript";
import type { Segment } from "$lib/transcript";
import {
  parseWords,
  serializeWords,
  reassignSpeaker,
  renameSpeakerInRuns,
  namedSpeakersInOrder,
  quotedSpeakerCounts,
  splitWord,
  replaceWordRange,
  eventNoteAnchorIndex,
} from "$lib/transcript-words";
import { mintOverlayId, makeHighlightId } from "$lib/highlight-markers";

/** The bare inner text of an event note: brackets are the on-disk notation, not
 *  content, so any the caller passed are stripped (and stray brackets can never
 *  break the `[...]` round-trip). "" when empty. */
function noteInner(text: string): string {
  // Braces are the on-disk `{{...}}` notation, never part of a note's content;
  // strip any the reviewer typed so they can't break the grammar.
  return text.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}

/** Sanitise reviewer span-note text: strip braces (they would corrupt the
 *  `{{ }}` marker grammar) and collapse whitespace. Colons, quotes and other
 *  punctuation are kept - the serialiser double-quotes and escapes the text. */
function sanitiseNoteText(text: string): string {
  return text.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}

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
/** Read the record's persisted overlay id counter, or null when absent (a record
 *  that predates the field - the mint then derives the mark from extant ids, which
 *  is correct for anything that never deleted its highest). */
/** Every overlay id the record MENTIONS, across all three paired-marker
 *  constructs and the id-referencing edges. This feeds mintOverlayId's collision
 *  guard, and the spec's non-reuse rule quantifies over "any overlay construct
 *  (a marker, a context edge, or a link payload)" - so a new construct's ids
 *  get added HERE, once, not at each mint site. */
function overlayIdsOf(parsed: ReturnType<typeof parseWords>): string[] {
  return [
    ...parsed.highlights.map((h) => h.id),
    ...parsed.spanNotes.map((n) => n.id),
    ...parsed.links.map((l) => l.id),
    ...parsed.externals.map((e) => e.id),
    ...parsed.citedWorks.map((c) => c.id),
    ...parsed.highlightContexts.flatMap((c) => [c.of, ...c.needs]),
  ];
}

function readOverlayNextId(rawFm: string): number | null {
  if (!rawFm) return null;
  try {
    const doc = yaml.load(rawFm.replace(/^---\n/, "").replace(/---\n$/, "")) as Record<
      string,
      unknown
    > | null;
    const v = doc?.overlay_next_id;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null; // unparseable frontmatter: fall back to deriving from ids
  }
}

/** Set `a.b` inside its block rather than as a key literally called "a.b".
 *
 *  The reader flattens nested frontmatter with dots (`copyright.status`), so
 *  the writer takes the same notation - otherwise a caller has to know which
 *  fields happen to be nested, and getting it wrong writes a key that every
 *  consumer ignores while the real one keeps its old value. */
function setPath(doc: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let node = doc;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (typeof next !== "object" || next === null || Array.isArray(next)) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;
}

export function rewriteFrontmatterFields(
  rawFm: string,
  fields: Record<string, string | string[] | number>,
): string {
  const fmContent = rawFm.replace(/^---\n/, "").replace(/---\n$/, "");
  // CORE_SCHEMA: dates stay STRINGS. The default schema resolves `2015-03-05`
  // to a JS Date and dumps it back as `2015-03-05T00:00:00.000Z`, so renaming a
  // record silently rewrote every date in its frontmatter - and a date carrying
  // an offset was normalised to UTC, which can move it to a different day. The
  // record says when it was published; an edit to the title is not an occasion
  // to reinterpret that.
  const doc = (yaml.load(fmContent, { schema: yaml.CORE_SCHEMA }) as Record<string, unknown>) ?? {};
  for (const [key, value] of Object.entries(fields)) {
    let resolved: unknown;
    if (typeof value === "number") {
      resolved = value;
    } else if (Array.isArray(value)) {
      const items = value.map((v) => v.trim()).filter((v) => v !== "");
      resolved = items.length > 0 ? items : undefined;
    } else {
      const trimmed = value.trim();
      resolved = trimmed !== "" ? trimmed : undefined;
    }
    setPath(doc, key, resolved);
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

/** Whether a speaker name only means anything inside its own record.
 *
 *  A real name is curated: a reviewer may write it before assigning a single
 *  turn, and only they take it away again. A DESCRIPTION is not. `[speaker 3]`
 *  and `[interviewer 2]` exist to label turns, so once no turn is theirs the
 *  name means nothing, and leaving it in the record's speaker list makes the
 *  record claim a participant it does not have - renaming `[interviewer 2]` to
 *  a person would otherwise leave the description behind as a ghost. */
function recordScopedSpeaker(name: string): boolean {
  return isDefaultSpeakerName(name) || isAnonymousSpeaker(name);
}
