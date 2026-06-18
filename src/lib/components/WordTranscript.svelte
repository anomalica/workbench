<script lang="ts">
  import { untrack } from "svelte";
  import { parseWords, wordsInTimeRange } from "$lib/transcript-words";
  import type { SpeakerRun } from "$lib/transcript-words";
  import {
    orderedNamedSpeakers,
    isSpecialSpeaker,
    nextSpeakerName,
    SPEAKER_IRRELEVANT,
    SPEAKER_NARRATOR,
    SPEAKER_EXTERNAL_FOOTAGE,
    SPEAKER_GROUP,
  } from "$lib/transcript";
  import SpeakerDot from "./SpeakerDot.svelte";
  import { safeLocalSet } from "$lib/storage";

  // The observed set is persisted as run-length spans [[from,to],...] rather
  // than a flat index array: on a long record (tens of thousands of words) the
  // flat array is hundreds of KB and is rewritten on every playback tick, which
  // is both slow and a fast route to filling localStorage. `decodeObserved`
  // also reads the old flat-array drafts so existing saves still restore.
  function decodeObserved(raw: string | null): number[] {
    if (!raw) return [];
    try {
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return [];
      if (data.length === 0) return [];
      if (typeof data[0] === "number") return data as number[]; // legacy flat array
      const out: number[] = [];
      for (const span of data as [number, number][]) {
        if (!Array.isArray(span)) continue;
        for (let i = span[0]; i <= span[1]; i++) out.push(i);
      }
      return out;
    } catch {
      return [];
    }
  }

  function encodeObserved(set: Set<number>): string {
    const sorted = [...set].sort((a, b) => a - b);
    const spans: [number, number][] = [];
    for (const g of sorted) {
      const last = spans[spans.length - 1];
      if (last && g === last[1] + 1) last[1] = g;
      else spans.push([g, g]);
    }
    return JSON.stringify(spans);
  }

  let {
    body,
    namedSpeakers = [],
    currentTime = 0,
    filteredSpeakers = new Set<string>(),
    hideIrrelevant = true,
    storageKey = "",
    notesStorageKey = "",
    serverObserved = [],
    claimHighlight = null,
    onreassign,
    onedit,
    onsettime,
    onseek,
    onmarkresume,
    onverdict,
  }: {
    /** Transcript body (everything after the frontmatter) using `{{t:N.N}}`
     *  per-word markers. */
    body: string;
    /** Named speakers from the frontmatter, for picker ordering. */
    namedSpeakers?: string[];
    /** Current media playback position in seconds, for karaoke highlighting. */
    currentTime?: number;
    /** When non-empty, only these speakers' turns are shown. */
    filteredSpeakers?: Set<string>;
    /** Hide turns assigned to the `[irrelevant]` speaker (mirrors the segment
     *  view's eye toggle). Irrelevant words are also excluded from coverage. */
    hideIrrelevant?: boolean;
    /** localStorage key for persisting which words have been observed. */
    storageKey?: string;
    /** localStorage key for persisting time-anchored visual notes. */
    notesStorageKey?: string;
    /** Word indices this reviewer already submitted as observed (from the
     *  server coverage sidecar). Merged into the local observation set so a
     *  reopened record restores previously-submitted coverage, not just the
     *  localStorage draft (which submit clears). */
    serverObserved?: number[];
    /** A claim's source time range (seconds) to highlight and scroll to, set
     *  when arriving via a `#claim-<id>` deep link. Words whose start falls in
     *  [start, end] get a distinct claim highlight; the view scrolls to the
     *  first of them. `seq` is bumped per navigation so re-linking the same
     *  claim re-triggers the scroll. */
    claimHighlight?: { start: number; end: number; seq: number } | null;
    /** Reassign the inclusive word range [from, to] to `speaker`. */
    onreassign: (from: number, to: number, speaker: string) => void;
    /** Replace the text of a single word (keeps its timestamp). */
    onedit: (gIndex: number, text: string) => void;
    /** Set a single word's start time (clamped between its neighbours). */
    onsettime: (gIndex: number, start: number) => void;
    /** Seek the media to `seconds` (optional). */
    onseek?: (seconds: number) => void;
    /** Position the media at `seconds` WITHOUT starting playback - used by the
     *  resume marker so pressing play continues from there. */
    onmarkresume?: (seconds: number) => void;
    /** Report the observation verdict (observed word-index spans + the
     *  coverage fraction + digestible + total words) whenever it changes, so
     *  the submit can persist it to the sidecar. */
    onverdict?: (v: {
      spans: { from: number; to: number }[];
      observed_coverage: number;
      digestible: boolean;
      total_units: number;
    }) => void;
  } = $props();

  let parsed = $derived(parseWords(body));
  let words = $derived(parsed.words);
  let runs = $derived(parsed.runs);

  // Speaker filter + irrelevant-hiding: when a filter is active only matching
  // turns render, and `[irrelevant]` turns hide unless the eye toggle is off.
  // Selection and karaoke still index the full word array, so they stay correct.
  let visibleRuns = $derived(
    runs.filter((r) => {
      if (hideIrrelevant && r.speaker === SPEAKER_IRRELEVANT) return false;
      if (filteredSpeakers.size > 0 && !filteredSpeakers.has(r.speaker)) return false;
      return true;
    }),
  );

  // Words inside a deep-linked claim's source time range, for the claim
  // highlight. A word belongs to the claim when its start time falls in the
  // [start, end] window the claim reports.
  let claimWords = $derived.by(() => {
    const ch = claimHighlight;
    const s = new Set<number>();
    if (!ch) return s;
    for (let i = 0; i < words.length; i++) {
      if (words[i].start >= ch.start && words[i].start <= ch.end) s.add(i);
    }
    return s;
  });

  // Word indices inside `[irrelevant]` turns. Excluded from coverage entirely:
  // not observed, not counted in the denominator. Marking a block irrelevant is
  // a deliberate "this doesn't need reviewing" signal.
  let irrelevantWords = $derived.by(() => {
    const s = new Set<number>();
    for (const run of runs) {
      if (run.speaker === SPEAKER_IRRELEVANT) {
        for (let g = run.startWord; g <= run.endWord; g++) s.add(g);
      }
    }
    return s;
  });

  // The word currently being spoken: the last word whose start time is at or
  // before the playback clock (each word runs until the next word's start).
  // Word starts are monotonic, so binary-search. -1 before the first word.
  let activeWord = $derived.by(() => {
    if (words.length === 0 || currentTime < words[0].start) return -1;
    let lo = 0;
    let hi = words.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (words[mid].start <= currentTime) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  });

  // Map each word gIndex to the run that owns it, so a click can clamp the
  // selection to a single speaker turn.
  let runOfWord = $derived.by(() => {
    const m = new Map<number, SpeakerRun>();
    for (const run of runs) {
      for (let i = run.startWord; i <= run.endWord; i++) m.set(i, run);
    }
    return m;
  });

  // Distinct speaker names in first-appearance order, for the picker's
  // "other" section (default/unnamed clusters not in the named list).
  let allSpeakerNames = $derived.by(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const run of runs) {
      if (run.speaker && !seen.has(run.speaker)) {
        seen.add(run.speaker);
        out.push(run.speaker);
      }
    }
    return out;
  });

  // Pseudo-segments so orderedNamedSpeakers can sort by first appearance.
  let pseudoSegments = $derived(
    runs.map((r) => ({
      speaker: r.speaker,
      time: "",
      seconds: words[r.startWord]?.start ?? 0,
      lines: [],
      index: r.startWord,
    })),
  );
  let namedSpeakersOrdered = $derived(orderedNamedSpeakers(pseudoSegments, namedSpeakers));

  // Selection state: an inclusive {from, to} range of word gIndices, always
  // within one speaker run. `anchor` is where a click/drag started.
  let anchor = $state<number | null>(null);
  let range = $state<{ from: number; to: number } | null>(null);
  let dragging = $state(false);
  let pickerOpen = $state(false);
  // startWord of the run whose header picker is open (header click reassigns
  // the whole turn), or null.
  let headerPicker = $state<number | null>(null);
  // Single-word text edit state.
  let editingWord = $state(false);
  let editValue = $state("");
  let editWordEl = $state<HTMLInputElement>();
  // Single-word time-adjust mode.
  let adjustingTime = $state(false);

  // Floating selection bar: positioned just above (or below) the first
  // selected word, in the offsetParent's coordinate space.
  let scrollEl = $state<HTMLElement>();
  let barEl = $state<HTMLElement>();
  let barStyle = $state("");

  // Observation tracking: word gIndices that have been "seen" - auto-filled as
  // playback passes each word, or marked manually. Unobserved words render
  // faded; the set persists per record in localStorage. Always reassigned (not
  // mutated) so reactivity fires regardless of Set-proxy behaviour.
  let observed = $state(new Set<number>());
  let lastPlayTime = -1;
  // "Resume here" marker: the last observed word before the first unobserved
  // gap, dropped by Jump to unobserved. A persistent position indicator (and
  // play-resume point), distinct from the amber cursor and from a selection.
  let resumeWord = $state<number | null>(null);

  // Restore the local observation draft when the record (storageKey) changes.
  // The current server coverage is read UNTRACKED and unioned in, so this effect
  // fires only on a record change - never when the async fetch lands - so it
  // never rebuilds the set or resets the playback cursor mid-playback.
  $effect(() => {
    const key = storageKey;
    const restored = key ? decodeObserved(localStorage.getItem(key)) : [];
    untrack(() => {
      lastPlayTime = -1;
      resumeWord = null;
      observed = new Set([...restored, ...serverObserved]);
    });
  });

  // When the server coverage arrives (fetched async after mount), ADD it to the
  // observed set rather than rebuilding - so it never clobbers session
  // auto-observe marks and never touches lastPlayTime (which would interrupt the
  // playback follow-along). Only reassigns when something is genuinely new.
  $effect(() => {
    const server = serverObserved;
    untrack(() => {
      if (server.length === 0) return;
      const next = new Set(observed);
      let changed = false;
      for (const g of server) {
        if (!next.has(g)) {
          next.add(g);
          changed = true;
        }
      }
      if (changed) observed = next;
    });
  });

  // Persist on change. Best-effort: a full localStorage must never throw here,
  // or the abort would tear down this component's render and kill all
  // per-word highlighting.
  $effect(() => {
    const serialised = encodeObserved(observed);
    if (storageKey) safeLocalSet(storageKey, serialised);
  });

  // Auto-observe: mark words the playhead passes during continuous forward
  // playback. Seeks and backward jumps (gap > 2s or negative) are ignored, so
  // skipped content is never silently marked seen.
  $effect(() => {
    const t = currentTime;
    void words.length;
    untrack(() => {
      const prev = lastPlayTime;
      lastPlayTime = t;
      if (prev < 0 || t - prev <= 0 || t - prev > 2) return;
      const fresh = wordsInTimeRange(words, prev, t).filter((g) => !observed.has(g));
      if (fresh.length) {
        const next = new Set(observed);
        for (const g of fresh) next.add(g);
        observed = next;
      }
    });
  });

  // Keep the actively-playing word in view: when the karaoke cursor reaches the
  // bottom 10% of the transcript (or scrolls off the top) it re-centres the
  // word, so it never rides the very bottom edge and has runway both ways. Only
  // fires as activeWord changes (i.e. during playback), so it doesn't fight
  // manual scrolling while paused.
  $effect(() => {
    const g = activeWord;
    untrack(() => {
      if (g < 0 || !scrollEl) return;
      requestAnimationFrame(() => {
        const el = scrollEl?.querySelector<HTMLElement>(`[data-word-index="${g}"]`);
        if (!el || !scrollEl) return;
        const view = scrollEl.getBoundingClientRect();
        const word = el.getBoundingClientRect();
        const topMargin = 24;
        const bottomZone = view.height * 0.1;
        if (word.top < view.top + topMargin || word.bottom > view.bottom - bottomZone) {
          const target = scrollEl.scrollTop + (word.top - view.top) - view.height * 0.5;
          scrollEl.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
        }
      });
    });
  });

  function isObserved(g: number): boolean {
    return observed.has(g);
  }

  // The observation verdict for this record: observed word-index spans, the
  // coverage fraction, the digestible flag (observed-only 100%), and the total
  // word count. Reported to the parent so a review submit persists it to the
  // sidecar (where the digester's gate reads observed_coverage + digestible).
  let coverageVerdict = $derived.by(() => {
    // The denominator is the relevant words only - turns marked `[irrelevant]`
    // never need observing, so they count neither as observed nor as a target.
    const total = words.length - irrelevantWords.size;
    const obs = [...observed]
      .filter((g) => g >= 0 && g < words.length && !irrelevantWords.has(g))
      .sort((a, b) => a - b);
    const spans: { from: number; to: number }[] = [];
    for (const g of obs) {
      const last = spans[spans.length - 1];
      if (last && g === last.to + 1) last.to = g;
      else spans.push({ from: g, to: g });
    }
    return {
      spans,
      observed_coverage: total > 0 ? obs.length / total : 0,
      digestible: total > 0 && obs.length === total,
      total_units: total,
    };
  });

  $effect(() => {
    const v = coverageVerdict;
    untrack(() => onverdict?.(v));
  });

  function rangeAllObserved(): boolean {
    if (!range) return false;
    for (let g = range.from; g <= range.to; g++) if (!observed.has(g)) return false;
    return true;
  }

  function toggleSeen() {
    if (!range) return;
    const all = rangeAllObserved();
    const next = new Set(observed);
    for (let g = range.from; g <= range.to; g++) {
      if (all) next.delete(g);
      else next.add(g);
    }
    observed = next;
  }

  function observedInRun(run: SpeakerRun): number {
    let n = 0;
    for (let g = run.startWord; g <= run.endWord; g++) if (observed.has(g)) n++;
    return n;
  }

  function selectBlock(run: SpeakerRun) {
    headerPicker = null;
    pickerOpen = false;
    editingWord = false;
    anchor = run.startWord;
    range = { from: run.startWord, to: run.endWord };
  }

  // --- Time-anchored visual notes (reviewer observations of the video's visual
  // channel, anchored to a moment, not a word). Persisted locally for now; the
  // committed {hash}.visual-notes.json sidecar is the follow-up. ---
  interface VisualNote {
    id: string;
    at: number;
    text: string;
  }

  let notes = $state<VisualNote[]>([]);
  let editingNoteId = $state<string | null>(null);
  let noteInputEl = $state<HTMLTextAreaElement>();

  $effect(() => {
    const key = notesStorageKey;
    let restored: VisualNote[] = [];
    if (key) {
      try {
        const raw = JSON.parse(localStorage.getItem(key) ?? "[]");
        if (Array.isArray(raw)) restored = raw;
      } catch {
        restored = [];
      }
    }
    untrack(() => {
      notes = restored;
    });
  });

  $effect(() => {
    const serialised = JSON.stringify(notes);
    if (notesStorageKey) safeLocalSet(notesStorageKey, serialised);
  });

  let sortedNotes = $derived([...notes].sort((a, b) => a.at - b.at));

  // Each note renders inline after the last word whose start is at or before
  // its time (so it sits "between words" at that moment). Notes before the
  // first word anchor to word 0.
  let notesByAnchorWord = $derived.by(() => {
    const m = new Map<number, VisualNote[]>();
    if (words.length === 0) return m;
    for (const note of sortedNotes) {
      let lo = 0;
      let hi = words.length - 1;
      let g = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (words[mid].start <= note.at) {
          g = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      const list = m.get(g) ?? [];
      list.push(note);
      m.set(g, list);
    }
    return m;
  });

  function addNoteAt(at: number) {
    const note: VisualNote = { id: crypto.randomUUID(), at, text: "" };
    notes = [...notes, note];
    editingNoteId = note.id;
    setTimeout(() => noteInputEl?.focus(), 0);
  }

  /** Add a note at the current playback position. Called from the toolbar
   *  button and the `v` keyboard shortcut. */
  function addNoteAtCurrentTime() {
    addNoteAt(currentTime);
  }

  function onWindowKeydown(e: KeyboardEvent) {
    // Esc backs out of the time-adjust mode (the slider can hold focus).
    if (e.key === "Escape" && adjustingTime) {
      e.preventDefault();
      clearSelection();
      return;
    }
    if (e.key !== "v" || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (
      t instanceof HTMLInputElement ||
      t instanceof HTMLTextAreaElement ||
      (t instanceof HTMLElement && t.isContentEditable)
    )
      return;
    e.preventDefault();
    addNoteAtCurrentTime();
  }

  function commitNote(id: string) {
    // Drop a note left empty (e.g. opened then dismissed without typing).
    notes = notes.filter((n) => n.id !== id || n.text.trim() !== "");
    editingNoteId = null;
  }

  function deleteNote(id: string) {
    notes = notes.filter((n) => n.id !== id);
    if (editingNoteId === id) editingNoteId = null;
  }

  function secondsToClock(s: number): string {
    const t = Math.max(0, Math.floor(s));
    const pad = (n: number) => String(n).padStart(2, "0");
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    return h > 0 ? `${h}:${pad(m)}:${pad(t % 60)}` : `${m}:${pad(t % 60)}`;
  }

  // Clock with two decimals, for the millisecond-level time-adjust readout.
  function secondsToClockMs(s: number): string {
    const cs = Math.round(Math.max(0, s) * 100);
    const frac = String(cs % 100).padStart(2, "0");
    return `${secondsToClock(Math.floor(cs / 100))}.${frac}`;
  }

  function positionBar() {
    if (!range || !scrollEl || !barEl) return;
    const wordEl = scrollEl.querySelector<HTMLElement>(`[data-word-index="${range.from}"]`);
    const parent = barEl.offsetParent as HTMLElement | null;
    if (!wordEl || !parent) return;

    const word = wordEl.getBoundingClientRect();
    const base = parent.getBoundingClientRect();
    const view = scrollEl.getBoundingClientRect();
    const barW = barEl.offsetWidth;
    const barH = barEl.offsetHeight;
    const gap = 8;
    const margin = 4;

    // Left-align to the word, clamped within the visible scroll area.
    let left = word.left - base.left;
    const minLeft = view.left - base.left + margin;
    const maxLeft = view.right - base.left - barW - margin;
    if (maxLeft >= minLeft) left = Math.max(minLeft, Math.min(left, maxLeft));
    else left = minLeft;

    // Vertical clamp: keep the anchoring word's top within the visible area
    // so the bar never floats off-screen when the word is scrolled away.
    const wordTop = Math.max(view.top, Math.min(word.top, view.bottom));

    // Always sit ABOVE the word (playback runs left-to-right under the line, so
    // a bar below would cover what's being read). The transcript has top
    // headroom so the first line has room; if a scrolled word still has none,
    // pin to the top of the visible area rather than flipping below.
    const minTop = view.top - base.top + margin;
    const top = Math.max(minTop, wordTop - base.top - gap - barH);

    barStyle = `top:${Math.round(top)}px;left:${Math.round(left)}px`;
  }

  function schedulePositionBar() {
    requestAnimationFrame(positionBar);
  }

  $effect(() => {
    // Track selection and edit mode (bar width changes when editing).
    void range;
    void editingWord;
    if (range) schedulePositionBar();
  });

  function clampToRun(a: number, b: number): { from: number; to: number } | null {
    const run = runOfWord.get(a);
    if (!run) return null;
    // Clamp b into the anchor's run so a drag/shift can't cross a speaker turn.
    const lo = Math.max(run.startWord, Math.min(a, b));
    const hi = Math.min(run.endWord, Math.max(a, b));
    return { from: lo, to: hi };
  }

  function selectWord(g: number, extend: boolean) {
    headerPicker = null;
    if (extend && anchor !== null) {
      range = clampToRun(anchor, g);
    } else {
      anchor = g;
      range = { from: g, to: g };
    }
    pickerOpen = false;
  }

  function onWordPointerDown(e: PointerEvent, g: number) {
    if (e.button !== 0) return;
    if (e.shiftKey) {
      selectWord(g, true);
    } else {
      selectWord(g, false);
      dragging = true;
      if (onseek && words[g]) onseek(words[g].start);
    }
  }

  function onWordPointerEnter(g: number) {
    if (dragging && anchor !== null) {
      range = clampToRun(anchor, g);
    }
  }

  function stopDrag() {
    dragging = false;
  }

  function isSelected(g: number): boolean {
    return range !== null && g >= range.from && g <= range.to;
  }

  function clearSelection() {
    anchor = null;
    range = null;
    pickerOpen = false;
    editingWord = false;
    adjustingTime = false;
  }

  // Time-adjust bounds for the single selected word: its current start and the
  // neighbours' starts it can't pass (so it stays in order).
  let timeBounds = $derived.by(() => {
    if (!range || range.from !== range.to || !words[range.from]) return null;
    const g = range.from;
    const cur = words[g].start;
    const prev = g > 0 ? words[g - 1].start : 0;
    const next = g + 1 < words.length ? words[g + 1].start : cur + 2;
    return { g, cur, prev, next };
  });

  function nudgeTime(deltaSec: number) {
    if (!timeBounds) return;
    const target = Math.max(timeBounds.prev, Math.min(timeBounds.next, timeBounds.cur + deltaSec));
    onsettime(timeBounds.g, target);
    onseek?.(target);
  }

  function sliderTime(fraction: number) {
    if (timeBounds) onsettime(timeBounds.g, timeBounds.prev + fraction * (timeBounds.next - timeBounds.prev));
  }

  function chooseSpeaker(name: string) {
    if (range) onreassign(range.from, range.to, name);
    clearSelection();
  }

  function startEditWord() {
    if (!range || range.from !== range.to) return;
    editValue = words[range.from].text;
    pickerOpen = false;
    editingWord = true;
    setTimeout(() => {
      editWordEl?.focus();
      editWordEl?.select();
    }, 0);
  }

  function commitEditWord() {
    if (range && editingWord) onedit(range.from, editValue);
    clearSelection();
  }

  let observedPct = $derived(Math.floor(coverageVerdict.observed_coverage * 100));

  // Scroll to the first word the reviewer hasn't observed yet (skipping
  // irrelevant words, which never need observing, and words hidden by a filter).
  function jumpToFirstUnobserved() {
    // First unobserved (non-irrelevant, visible) word - the review target.
    let g = -1;
    for (let i = 0; i < words.length; i++) {
      if (observed.has(i) || irrelevantWords.has(i)) continue;
      if (!scrollEl?.querySelector(`[data-word-index="${i}"]`)) continue;
      g = i;
      break;
    }
    if (g < 0) return;
    // Drop the marker on the last observed, non-irrelevant word BEFORE the gap -
    // never on the unobserved word itself, so the review target stays untouched
    // (a selection there could flip it to observed). Walk back past irrelevant.
    let m = g - 1;
    while (m >= 0 && irrelevantWords.has(m)) m--;
    const markerWord = m >= 0 ? m : g;
    resumeWord = markerWord;
    // Position playback at the marker so pressing play resumes from there.
    if (words[markerWord]) onmarkresume?.(words[markerWord].start);
    // Scroll to the boundary (centre the marker). Instant, not smooth (smooth
    // scrollTo is a no-op in some Chromium profiles); scroll scrollEl directly
    // since scrollIntoView targets the wrong nested ancestor in this layout.
    requestAnimationFrame(() => {
      const el = scrollEl?.querySelector<HTMLElement>(`[data-word-index="${markerWord}"]`);
      if (!el || !scrollEl) return;
      const view = scrollEl.getBoundingClientRect();
      const word = el.getBoundingClientRect();
      const target = scrollEl.scrollTop + (word.top - view.top) - view.height * 0.5;
      scrollEl.scrollTo({ top: Math.max(0, target) });
    });
  }

  // Scroll to a deep-linked claim's first word. Retries across frames because
  // on a cold load the digest (which supplies the range) arrives before the
  // word DOM has painted. Instant scroll, centred - same reasoning as the
  // resume-marker jump above.
  function scrollToClaim() {
    const first = [...claimWords].sort((a, b) => a - b)[0];
    if (first === undefined) return;
    let attempts = 0;
    const tryScroll = () => {
      const el = scrollEl?.querySelector<HTMLElement>(`[data-word-index="${first}"]`);
      if (!el || !scrollEl) {
        if (attempts++ < 20) requestAnimationFrame(tryScroll);
        return;
      }
      const view = scrollEl.getBoundingClientRect();
      const word = el.getBoundingClientRect();
      const target = scrollEl.scrollTop + (word.top - view.top) - view.height * 0.5;
      scrollEl.scrollTo({ top: Math.max(0, target) });
    };
    requestAnimationFrame(tryScroll);
  }

  $effect(() => {
    void claimHighlight?.seq;
    untrack(() => {
      if (claimHighlight) scrollToClaim();
    });
  });

  function toggleHeaderPicker(run: SpeakerRun) {
    // Opening a header picker deselects any word range to avoid two live menus.
    anchor = null;
    range = null;
    pickerOpen = false;
    headerPicker = headerPicker === run.startWord ? null : run.startWord;
  }

  function chooseRunSpeaker(run: SpeakerRun, name: string) {
    onreassign(run.startWord, run.endWord, name);
    headerPicker = null;
  }
</script>

<svelte:window
  onpointerup={stopDrag}
  onresize={() => range && schedulePositionBar()}
  onkeydown={onWindowKeydown}
/>

{#snippet speakerMenu(currentSpeaker: string | null, onChoose: (name: string) => void)}
  {@const named = namedSpeakersOrdered.filter((s) => s !== currentSpeaker)}
  {@const special = [
    SPEAKER_IRRELEVANT,
    SPEAKER_NARRATOR,
    SPEAKER_EXTERNAL_FOOTAGE,
    SPEAKER_GROUP,
  ].filter((s) => s !== currentSpeaker)}
  {@const other = allSpeakerNames.filter(
    (s) => s !== currentSpeaker && !namedSpeakers.includes(s) && !isSpecialSpeaker(s),
  )}
  <div
    role="menu"
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
    onkeydown={() => {}}
    class="absolute top-full left-0 mt-1 z-40 bg-surface-raised border border-border
      rounded shadow-lg py-1 min-w-40 max-h-60 overflow-auto"
  >
    {#each named as name}
      <button
        onclick={() => onChoose(name)}
        class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface"
      >
        <SpeakerDot speaker={name} inline />
        {name}
      </button>
    {/each}
    {#if named.length > 0 && special.length > 0}
      <div class="border-t border-border my-1"></div>
    {/if}
    {#each special as name}
      <button
        onclick={() => onChoose(name)}
        class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface-muted italic"
      >
        <SpeakerDot speaker={name} inline />
        {name}
      </button>
    {/each}
    {#if other.length > 0}
      <div class="border-t border-border my-1"></div>
      {#each other as name}
        <button
          onclick={() => onChoose(name)}
          class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface-muted"
        >
          <SpeakerDot speaker={name} inline />
          {name}
        </button>
      {/each}
    {/if}
    <div class="border-t border-border mt-1 pt-1">
      <button
        onclick={() => onChoose(nextSpeakerName(pseudoSegments))}
        class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-primary"
      >
        + New speaker
      </button>
    </div>
  </div>
{/snippet}

<!-- Selection action bar, floating just above the first selected word, shown
     when a word range is selected. -->
{#if range}
  {@const count = range.to - range.from + 1}
  {@const single = range.from === range.to}
  {@const selectedSpeaker = runOfWord.get(range.from)?.speaker ?? null}
  <div
    bind:this={barEl}
    style={barStyle}
    class="absolute z-30 flex items-center gap-2
      bg-surface-raised border border-primary/60 ring-2 ring-primary/25 rounded-full shadow-xl px-3 py-1.5"
  >
    {#if editingWord}
      <input
        bind:this={editWordEl}
        type="text"
        bind:value={editValue}
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitEditWord();
          } else if (e.key === "Escape") {
            e.preventDefault();
            clearSelection();
          }
        }}
        title="Type a space to split into separate, separately-timestamped words"
        class="text-sm font-ui bg-surface border border-primary rounded px-2 py-0.5 text-on-surface outline-none min-w-32"
      />
      <button
        onclick={commitEditWord}
        class="text-xs font-ui font-medium text-primary cursor-pointer hover:underline"
        title="Save (Enter)"
      >
        Save
      </button>
      <button
        onclick={clearSelection}
        class="p-0.5 rounded cursor-pointer text-on-surface-muted/60 hover:text-on-surface hover:bg-surface-alt transition-colors"
        title="Cancel (Esc)"
        aria-label="Cancel"
      >
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    {:else if adjustingTime && timeBounds}
      <span
        class="text-xs font-ui font-medium text-on-surface tabular-nums whitespace-nowrap"
        title="Start time of this word"
      >
        {secondsToClockMs(timeBounds.cur)}
      </span>
      <input
        type="range"
        min="0"
        max="1"
        step="0.001"
        value={(timeBounds.cur - timeBounds.prev) / (timeBounds.next - timeBounds.prev || 1)}
        oninput={(e) => sliderTime(Number(e.currentTarget.value))}
        class="w-28 accent-primary cursor-pointer"
        title="Drag between the previous and next word's start"
        aria-label="Word start time"
      />
      <div class="flex items-center gap-0.5 font-ui tabular-nums">
        <button
          onclick={() => nudgeTime(-1)}
          class="text-xs font-medium text-primary cursor-pointer hover:bg-surface-alt rounded px-1 py-0.5"
          title="Earlier by 1 second"
        >
          -1s
        </button>
        <button
          onclick={() => nudgeTime(-0.1)}
          class="text-xs font-medium text-primary cursor-pointer hover:bg-surface-alt rounded px-1 py-0.5"
          title="Earlier by 100 ms"
        >
          -100
        </button>
        <button
          onclick={() => nudgeTime(-0.01)}
          class="text-xs font-medium text-primary cursor-pointer hover:bg-surface-alt rounded px-1 py-0.5"
          title="Earlier by 10 ms"
        >
          -10
        </button>
        <button
          onclick={() => nudgeTime(0.01)}
          class="text-xs font-medium text-primary cursor-pointer hover:bg-surface-alt rounded px-1 py-0.5"
          title="Later by 10 ms"
        >
          +10
        </button>
        <button
          onclick={() => nudgeTime(0.1)}
          class="text-xs font-medium text-primary cursor-pointer hover:bg-surface-alt rounded px-1 py-0.5"
          title="Later by 100 ms"
        >
          +100
        </button>
        <button
          onclick={() => nudgeTime(1)}
          class="text-xs font-medium text-primary cursor-pointer hover:bg-surface-alt rounded px-1 py-0.5"
          title="Later by 1 second"
        >
          +1s
        </button>
      </div>
      <button
        onclick={() => onseek?.(timeBounds.cur)}
        class="text-xs font-ui font-medium text-primary cursor-pointer hover:underline"
        title="Play from this word's start"
      >
        Play
      </button>
      <button
        onclick={clearSelection}
        class="text-xs font-ui font-medium text-primary cursor-pointer hover:underline"
        title="Done (Esc)"
      >
        Done
      </button>
    {:else}
      <span class="text-xs font-ui text-on-surface-secondary tabular-nums">
        {count} word{count === 1 ? "" : "s"}
      </span>
      <div class="w-px h-4 bg-border" aria-hidden="true"></div>
      <div class="relative">
        <button
          onclick={(e) => {
            e.stopPropagation();
            pickerOpen = !pickerOpen;
          }}
          class="text-xs font-ui font-medium text-primary cursor-pointer hover:underline flex items-center gap-1"
          title="Assign these words to a speaker"
        >
          Assign speaker
          <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {#if pickerOpen}
          {@render speakerMenu(selectedSpeaker, chooseSpeaker)}
        {/if}
      </div>
      <div class="w-px h-4 bg-border" aria-hidden="true"></div>
      <button
        onclick={toggleSeen}
        class="text-xs font-ui font-medium cursor-pointer hover:underline
          {rangeAllObserved() ? 'text-on-surface-muted' : 'text-primary'}"
        title={rangeAllObserved()
          ? "Mark these words as not yet observed"
          : "Mark these words as observed"}
      >
        {rangeAllObserved() ? "Mark unseen" : "Mark seen"}
      </button>
      {#if single}
        <div class="w-px h-4 bg-border" aria-hidden="true"></div>
        <button
          onclick={startEditWord}
          class="text-xs font-ui font-medium text-primary cursor-pointer hover:underline"
          title="Edit this word's text (type a space to split it into separate words)"
        >
          Edit word
        </button>
        <div class="w-px h-4 bg-border" aria-hidden="true"></div>
        <button
          onclick={() => {
            pickerOpen = false;
            adjustingTime = true;
          }}
          class="text-xs font-ui font-medium text-primary cursor-pointer hover:underline"
          title="Adjust when this word starts"
        >
          Adjust time
        </button>
      {/if}
      <div class="w-px h-4 bg-border" aria-hidden="true"></div>
      <button
        onclick={() => {
          if (range && words[range.from]) addNoteAt(words[range.from].start);
        }}
        class="text-xs font-ui font-medium text-primary cursor-pointer hover:underline"
        title="Add a visual note at this word's moment"
      >
        Add note
      </button>
      <button
        onclick={clearSelection}
        class="p-0.5 rounded cursor-pointer text-on-surface-muted/60 hover:text-on-surface hover:bg-surface-alt transition-colors"
        title="Clear selection"
        aria-label="Clear selection"
      >
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    {/if}
  </div>
{/if}

<!-- Top toolbar: drop a time-anchored visual note at the current playback
     moment (also bound to the `v` key, handled in IngestViewer). -->
<div class="flex-none flex items-center gap-2 px-4 py-1.5 border-b border-border bg-surface-alt">
  <button
    onclick={() => addNoteAtCurrentTime()}
    class="flex items-center gap-1.5 text-xs font-ui font-medium text-primary cursor-pointer hover:underline"
    title="Add a visual note at the current playback time (v)"
  >
    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" d="M3 7h2l2-3h10l2 3h2v12H3z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
    Add visual note
  </button>
  <span class="text-xs font-ui text-on-surface-muted tabular-nums">at {secondsToClock(currentTime)}</span>
  <span
    class="ml-auto text-xs font-ui font-medium tabular-nums {observedPct >= 100 ? 'text-success' : 'text-on-surface-secondary'}"
    title="Share of this record's words you've observed"
  >
    {observedPct}% observed
  </span>
  {#if observedPct < 100}
    <button
      onclick={jumpToFirstUnobserved}
      class="text-xs font-ui font-medium text-primary cursor-pointer hover:underline"
      title="Scroll to the first word you haven't observed yet"
    >
      Jump to unobserved
    </button>
  {/if}
  <span class="text-xs font-ui text-on-surface-muted/60">{notes.length} note{notes.length === 1 ? "" : "s"}</span>
</div>

<div
  bind:this={scrollEl}
  onscroll={() => range && schedulePositionBar()}
  class="flex-1 overflow-auto"
  data-scroll-sync
>
  <!-- Top headroom so the selection bar always has room to sit above even the
       first line, and never has to flip below it. -->
  <div class="select-none pt-12">
    {#each visibleRuns as run (run.startWord)}
      {@const obs = observedInRun(run)}
      {@const total = run.endWord - run.startWord + 1}
      <div class="border-b border-border/50 px-4 pt-3 pb-2">
        <div class="flex items-center justify-between gap-2 pb-1">
          <!-- Clickable speaker chip: reassigns the whole turn. -->
          <div class="relative inline-block">
            <button
              onclick={(e) => {
                e.stopPropagation();
                toggleHeaderPicker(run);
              }}
              class="group flex items-center gap-2 cursor-pointer rounded px-1 -mx-1 hover:bg-primary-container/30 transition-colors"
              title="Change this speaker"
            >
              <div class="w-4 flex-none flex items-center justify-center">
                <SpeakerDot speaker={run.speaker} />
              </div>
              <span class="text-xs font-ui font-medium text-primary group-hover:underline">
                {run.speaker}
              </span>
              <svg
                class="w-3 h-3 text-on-surface-muted/60"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                viewBox="0 0 24 24"
              >
                <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {#if headerPicker === run.startWord}
              {@render speakerMenu(run.speaker, (name) => chooseRunSpeaker(run, name))}
            {/if}
          </div>
          <!-- Observation progress for this turn. Clicking selects the turn so
               it can be marked seen deliberately (no one-click mark-all). -->
          <button
            onclick={() => selectBlock(run)}
            class="flex-none text-[10px] font-mono tabular-nums px-1.5 py-0.5 rounded cursor-pointer transition-colors
              {obs >= total
              ? 'text-primary hover:bg-primary-container/30'
              : 'text-on-surface-muted/60 hover:bg-surface-alt hover:text-on-surface'}"
            title={obs >= total
              ? "This turn is fully observed - click to select it"
              : `${obs} of ${total} words observed - click to select this turn, then Mark seen`}
          >
            {obs}/{total}
          </button>
        </div>
        <p class="pl-6 text-sm text-on-surface leading-relaxed">
          {#each Array.from({ length: run.endWord - run.startWord + 1 }, (_, k) => run.startWord + k) as g (g)}
            {#if g === resumeWord}<span
                class="text-sky-600 font-bold not-italic select-none"
                title="Resume point - press play to continue from here"
                aria-label="Resume point"
              >&#9656;</span>{/if}<span
              data-word-index={g}
              role="button"
              tabindex="-1"
              onpointerdown={(e) => onWordPointerDown(e, g)}
              onpointerenter={() => onWordPointerEnter(g)}
              class="cursor-text rounded-sm px-px transition-colors
                {isSelected(g)
                ? 'bg-primary/30 text-on-surface'
                : claimWords.has(g)
                  ? 'bg-yellow-300/60 ring-1 ring-yellow-500 text-on-surface'
                  : g === resumeWord
                    ? 'bg-sky-500/20 ring-1 ring-sky-500 text-on-surface'
                    : g === activeWord
                      ? 'bg-amber-400/40 text-on-surface'
                      : isObserved(g)
                        ? 'hover:bg-primary-container/30'
                        : 'text-on-surface-muted/40 hover:bg-primary-container/30'}"
            >{words[g].text}</span>{" "}
            {#each notesByAnchorWord.get(g) ?? [] as note (note.id)}
              <!-- Reviewer visual note: rendered inline at its moment but
                   clearly markup, not speech (playback ignores it - it isn't a
                   word). display:block breaks it onto its own line. -->
              <span
                style="display:flex"
                class="my-1.5 items-start gap-1.5 rounded border border-warning/50 bg-warning-container/20 px-2 py-1 text-xs not-italic text-on-surface select-text"
              >
                <svg
                  class="w-3.5 h-3.5 flex-none mt-0.5 text-warning"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  viewBox="0 0 24 24"
                >
                  <path stroke-linecap="round" stroke-linejoin="round" d="M3 7h2l2-3h10l2 3h2v12H3z" />
                  <circle cx="12" cy="13" r="3.5" />
                </svg>
                {#if editingNoteId === note.id}
                  <textarea
                    bind:this={noteInputEl}
                    bind:value={note.text}
                    onblur={() => commitNote(note.id)}
                    onkeydown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        commitNote(note.id);
                      }
                    }}
                    rows="2"
                    placeholder="What's on screen at this moment..."
                    class="flex-1 min-w-0 bg-surface border border-primary rounded px-1.5 py-1 text-xs text-on-surface outline-none resize-y"
                  ></textarea>
                  <button
                    onclick={() => commitNote(note.id)}
                    class="flex-none text-xs font-ui font-medium text-primary cursor-pointer hover:underline"
                  >Save</button>
                {:else}
                  <button
                    onclick={() => onseek?.(note.at)}
                    class="flex-none font-mono tabular-nums text-warning/90 hover:underline cursor-pointer"
                    title="Jump to this moment"
                  >{secondsToClock(note.at)}</button>
                  <span class="flex-1 min-w-0 whitespace-pre-wrap">{note.text}</span>
                  <button
                    onclick={() => (editingNoteId = note.id)}
                    class="flex-none text-on-surface-muted/70 hover:text-primary cursor-pointer"
                    title="Edit note"
                    aria-label="Edit note"
                  >
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path stroke-linecap="round" stroke-linejoin="round" d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                  <button
                    onclick={() => deleteNote(note.id)}
                    class="flex-none text-on-surface-muted/70 hover:text-error cursor-pointer"
                    title="Delete note"
                    aria-label="Delete note"
                  >
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                      <path stroke-linecap="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                {/if}
              </span>
            {/each}
          {/each}
        </p>
      </div>
    {/each}
  </div>
</div>
