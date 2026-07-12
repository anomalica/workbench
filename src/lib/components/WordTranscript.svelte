<script lang="ts">
  import { untrack } from "svelte";
  import { parseWords, wordsInTimeRange, wordActiveAt } from "$lib/transcript-words";
  import type { SpeakerRun } from "$lib/transcript-words";
  import { EVENT_NOTE_PRESETS } from "$lib/transcript";
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
  import EditSelectionDialog from "./EditSelectionDialog.svelte";
  import { safeLocalSet } from "$lib/storage";
  import { observedPercent } from "$lib/coverage";

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
    mode = "edit",
    focusWords = null,
    sourceHash = "",
    mediaDuration = null,
    namedSpeakers = [],
    currentTime = 0,
    filteredSpeakers = new Set<string>(),
    hideIrrelevant = true,
    storageKey = "",
    serverObserved = [],
    claimHighlight = null,
    onreassign,
    onreplaceselection,
    oneventnote,
    oneventnoteedit,
    oneventnoteremove,
    onhighlight,
    onclearhighlight,
    onspannote,
    onspannoteedit,
    onspannoteremove,
    onselectiontext,
    onseek,
    onplayceiling,
    onmarkresume,
    onverdict,
  }: {
    /** Transcript body (everything after the frontmatter) using `{{t:N.N}}`
     *  per-word markers. */
    body: string;
    /** "edit" (default): word editing + speaker reassign, selection clamped to
     *  one speaker turn. "markup": read-only annotation - editing affordances
     *  hidden, selection spans speakers freely, and the floating bar offers
     *  Highlight/Note/Clear instead of the edit actions. */
    mode?: "edit" | "markup";
    /** Scroll to + flash an inclusive word range (the markup side list clicking a
     *  mark). `seq` is bumped per navigation so re-clicking the same mark
     *  re-triggers. */
    focusWords?: { from: number; to: number; seq: number } | null;
    /** Source SHA-256 (== content hash for a/v records), so the word editor can
     *  fetch a waveform window for the audio around a timestamp. */
    sourceHash?: string;
    /** Media length in seconds, to clamp the waveform window. */
    mediaDuration?: number | null;
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
    /** Replace the selected word range [from, to] with edited words (text +
     *  start) - the multi-word selection editor's save. */
    onreplaceselection?: (
      from: number,
      to: number,
      newWords: { text: string; start: number }[],
    ) => void;
    /** Insert a inline event note (`{{laughs}}`) into the body at time
     *  `at` - the word-record twin of the segment editor's quick-insert. */
    oneventnote?: (at: number, text: string) => void;
    /** Edit (empty text = remove) the ordinal-th event note on a word. */
    oneventnoteedit?: (gIndex: number, ordinal: number, text: string) => void;
    /** Remove the ordinal-th event note on a word. */
    oneventnoteremove?: (gIndex: number, ordinal: number) => void;
    /** Highlight the selected word range [from, to] (mint a new highlight). */
    onhighlight?: (from: number, to: number) => void;
    /** Clear every highlight overlapping the selected word range [from, to]. */
    onclearhighlight?: (from: number, to: number) => void;
    /** Attach a span note (free text) over the selected word range [from, to]. */
    onspannote?: (from: number, to: number, text: string) => void;
    /** Edit an existing span note's text by id (empty text removes it). */
    onspannoteedit?: (id: string, text: string) => void;
    /** Remove a span note by id. */
    onspannoteremove?: (id: string) => void;
    /** Report the selected words as plain text whenever the selection changes.
     *  The transcript is `select-none` with a custom word range, so the host
     *  cannot read this selection from `window.getSelection()` - Ctrl+F seeds
     *  its search from here. */
    onselectiontext?: (text: string) => void;
    /** Seek the media to `seconds` (optional). */
    onseek?: (seconds: number) => void;
    /** While the selection editor is open, playback must not run past the
     *  selection. Reports the ceiling in seconds - the start of the word AFTER
     *  the selection, the one timestamp the editor refuses to move - or null
     *  when the editor is closed or the selection ends the record. */
    onplayceiling?: (until: number | null) => void;
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

  // Reviewer highlights, rendered as stacked underline bands so overlapping
  // highlights read as distinct lines rather than a merged blob. Each highlight
  // gets a palette colour by its order in the record; a word covered by several
  // shows one band per highlight. Depth reads from the NUMBER of bands, not
  // their thickness - every band is the same thin weight, so three or four
  // overlaps stay legible without crowding (anomalica/master's call). Colours
  // are cosmetic only - a highlight is emphasis, not a category.
  const HL_PALETTE = ["#f59e0b", "#14b8a6", "#8b5cf6", "#ec4899", "#3b82f6", "#84cc16"];
  const BAND_H = 2; // px, band thickness
  const BAND_PITCH = 3; // px, band + 1px transparent gap
  // gIndex -> the highlight colours covering that word, innermost (nearest the
  // text) first.
  let highlightColorsByWord = $derived.by(() => {
    const cols = new Map<number, string[]>();
    parsed.highlights.forEach((h, i) => {
      const colour = HL_PALETTE[i % HL_PALETTE.length];
      for (let g = h.fromWord; g <= h.toWord; g++) {
        const list = cols.get(g) ?? [];
        list.push(colour);
        cols.set(g, list);
      }
    });
    return cols;
  });

  // Paint (or clear) a word's highlight bands as layered gradient underlines in
  // its padding strip: each a `BAND_H`px line, `BAND_PITCH`px apart, stacking
  // downward from just below the glyphs so overlaps are separate lines. Uses
  // backgrounds (not box-shadow) so the gaps are genuinely transparent.
  function applyWordHighlight(el: HTMLElement, cols: string[] | undefined) {
    const s = el.style;
    if (!cols || cols.length === 0) {
      s.backgroundImage = "";
      s.backgroundPosition = "";
      s.backgroundSize = "";
      s.backgroundRepeat = "";
      s.paddingBottom = "";
      return;
    }
    const n = cols.length;
    s.backgroundImage = cols.map((c) => `linear-gradient(${c}, ${c})`).join(",");
    s.backgroundRepeat = "no-repeat";
    s.backgroundSize = cols.map(() => `100% ${BAND_H}px`).join(",");
    // Band i (i=0 innermost) sits `(n-1-i)*PITCH`px up from the padding bottom,
    // so band 0 hugs the text and the rest step downward.
    s.backgroundPosition = cols
      .map((_, i) => `left 0 bottom ${(n - 1 - i) * BAND_PITCH}px`)
      .join(",");
    s.paddingBottom = `${(n - 1) * BAND_PITCH + BAND_H}px`;
  }

  // Reviewer span notes: free text attached to a word RANGE ("what was on screen
  // here"), distinct from the point event-notes on a single word. Words inside
  // any span note get a subtle background tint (a distinct treatment from the
  // highlight underline bands); the note text is shown in an inline card at the
  // range's first word.
  let spanNoteWordSet = $derived.by(() => {
    const s = new Set<number>();
    for (const n of parsed.spanNotes) for (let g = n.fromWord; g <= n.toWord; g++) s.add(g);
    return s;
  });
  let spanNotesByStartWord = $derived.by(() => {
    const m = new Map<number, typeof parsed.spanNotes>();
    for (const n of parsed.spanNotes) {
      const list = m.get(n.fromWord) ?? [];
      list.push(n);
      m.set(n.fromWord, list);
    }
    return m;
  });

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

  // Words in the currently-focused markup range (side-list click), for the
  // flash emphasis. Cleared when focusWords is null.
  let focusWordSet = $derived.by(() => {
    const s = new Set<number>();
    const f = focusWords;
    if (!f) return s;
    for (let g = f.from; g <= f.to; g++) s.add(g);
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
  let activeWord = $derived(wordActiveAt(words, currentTime));

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
  // True when a highlight overlaps the current selection, so the bar offers
  // "Clear highlight" instead of "Highlight".
  let selectionHasHighlight = $derived.by(() => {
    if (!range) return false;
    return parsed.highlights.some((h) => h.toWord >= range!.from && h.fromWord <= range!.to);
  });
  // Span notes overlapping the current selection (for the markup-bar Clear).
  let spanNotesInSelection = $derived.by(() => {
    if (!range) return [];
    return parsed.spanNotes.filter((n) => n.toWord >= range!.from && n.fromWord <= range!.to);
  });
  let selectionHasMarkup = $derived(selectionHasHighlight || spanNotesInSelection.length > 0);

  /** Markup Clear: strip every highlight AND span note overlapping the
   *  selection, then drop the selection. */
  function clearMarkupUnderSelection() {
    if (!range) return;
    if (selectionHasHighlight) onclearhighlight?.(range.from, range.to);
    for (const n of spanNotesInSelection) onspannoteremove?.(n.id);
    clearSelection();
  }
  let dragging = $state(false);
  let pickerOpen = $state(false);
  // startWord of the run whose header picker is open (header click reassigns
  // the whole turn), or null.
  let headerPicker = $state<number | null>(null);
  // Word/selection editor (text + timing + add/delete) over the range. Labelled
  // "Edit word" for a single word, "Edit selection" for several - one modal.

  let editingSelection = $state(false);
  let selectionInfo = $derived.by(() => {
    if (!range) return null;
    const speaker =
      parsed.runs.find((r) => range!.from >= r.startWord && range!.from <= r.endWord)?.speaker ?? "";
    return {
      words: words.slice(range.from, range.to + 1),
      prevStart: range.from > 0 ? words[range.from - 1].start : null,
      nextStart: range.to + 1 < words.length ? words[range.to + 1].start : null,
      speaker,
    };
  });

  // While the editor is open, playback is confined to the selection: it stops at
  // the word after it. Retiming inside the editor is only legible if you can hear
  // the words in isolation, and running on into the rest of the record is exactly
  // what makes that impossible.
  let playCeiling = $derived(editingSelection ? (selectionInfo?.nextStart ?? null) : null);
  // `selectionInfo` recomputes on every word edit, so only a CHANGED ceiling is
  // announced - re-announcing rearms the host's pause timer mid-playback.
  let announcedCeiling: number | null = null;
  $effect(() => {
    const c = playCeiling;
    untrack(() => {
      if (c === announcedCeiling) return;
      announcedCeiling = c;
      onplayceiling?.(c);
    });
  });
  // Lift the ceiling if this view unmounts with the editor still open.
  $effect(() => () => onplayceiling?.(null));

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

  // Markup shows only observed, relevant content: you can't mark up what you
  // haven't reviewed. `markupVisible` is the gIndex set (observed AND not
  // irrelevant); `renderRuns` are the turns with any such word (all turns in
  // edit mode). The word loop hides the rest. `[irrelevant]` turns never show in
  // markup regardless of the eye toggle.
  let markupVisible = $derived.by(() => {
    const s = new Set<number>();
    if (mode !== "markup") return s;
    for (let g = 0; g < words.length; g++) {
      if (observed.has(g) && !irrelevantWords.has(g)) s.add(g);
    }
    return s;
  });
  let renderRuns = $derived.by(() => {
    if (mode !== "markup") return visibleRuns;
    return runs.filter((r) => {
      if (r.speaker === SPEAKER_IRRELEVANT) return false;
      if (filteredSpeakers.size > 0 && !filteredSpeakers.has(r.speaker)) return false;
      for (let g = r.startWord; g <= r.endWord; g++) if (markupVisible.has(g)) return true;
      return false;
    });
  });
  let markupEmpty = $derived(mode === "markup" && markupVisible.size === 0);
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
      styleEpoch++;
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
      if (changed) {
        observed = next;
        styleEpoch++;
      }
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
      // Words whose start falls in (prev, t], PLUS the word under the playhead at
      // the interval start. After a skip-irrelevant seek the playhead lands
      // exactly on the first relevant word (its start == prev), which the open
      // lower bound of (prev, t] would exclude forever - so without this that
      // word could never be auto-observed even though it plays through. Adding
      // the word at `prev` is idempotent during normal continuous play.
      const landing = wordActiveAt(words, prev);
      const crossed = wordsInTimeRange(words, prev, t);
      const candidates = landing >= 0 ? [landing, ...crossed] : crossed;
      const fresh = candidates.filter((g) => !observed.has(g));
      if (fresh.length) {
        const next = new Set(observed);
        for (const g of fresh) next.add(g);
        observed = next;
        for (const g of fresh) applyWord(g);
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

  function rangeNoneObserved(): boolean {
    if (!range) return true;
    for (let g = range.from; g <= range.to; g++) if (observed.has(g)) return false;
    return true;
  }

  // Explicitly set the selected words observed (seen) or not. The seen/unseen
  // marking now lives in the top observation toolbar, not the floating bar.
  function setSelectionObserved(seen: boolean) {
    if (!range) return;
    const next = new Set(observed);
    for (let g = range.from; g <= range.to; g++) {
      if (seen) next.add(g);
      else next.delete(g);
    }
    observed = next;
    for (let g = range.from; g <= range.to; g++) applyWord(g);
  }

  // Word-case cycling for the selection: lower -> Title -> UPPER -> lower,
  // starting from whatever the current case is. The floating bar's case button
  // shows the current case and advances it on each click.
  type CaseMode = "lower" | "title" | "upper";
  function titleCase(w: string): string {
    const lw = w.toLowerCase();
    const idx = lw.search(/[a-z]/);
    return idx < 0 ? lw : lw.slice(0, idx) + lw[idx].toUpperCase() + lw.slice(idx + 1);
  }
  function applyCase(w: string, mode: CaseMode): string {
    if (mode === "lower") return w.toLowerCase();
    if (mode === "upper") return w.toUpperCase();
    return titleCase(w);
  }
  function detectCase(texts: string[]): CaseMode | "mixed" {
    const letters = texts.join("").replace(/[^a-zA-Z]/g, "");
    if (!letters) return "mixed";
    if (letters === letters.toLowerCase()) return "lower";
    if (letters === letters.toUpperCase()) return "upper";
    return texts.every((w) => w === titleCase(w)) ? "title" : "mixed";
  }
  function nextCase(c: CaseMode | "mixed"): CaseMode {
    const order: CaseMode[] = ["lower", "title", "upper"];
    return c === "mixed" ? "title" : order[(order.indexOf(c) + 1) % order.length];
  }
  // Advance the selection to the next case, writing the cased text back but
  // keeping the selection so repeated clicks keep cycling.
  function cycleCase() {
    if (!range) return;
    const sel = words.slice(range.from, range.to + 1);
    const mode = nextCase(detectCase(sel.map((w) => w.text)));
    onreplaceselection?.(
      range.from,
      range.to,
      sel.map((w) => ({ text: applyCase(w.text, mode), start: w.start })),
    );
  }
  // Label showing the selection's current case for the bar button.
  let caseLabel = $derived.by(() => {
    if (!range) return "Aa";
    const c = detectCase(words.slice(range.from, range.to + 1).map((w) => w.text));
    return { lower: "abc", title: "Abc", upper: "ABC", mixed: "Aa" }[c];
  });

  function observedInRun(run: SpeakerRun): number {
    let n = 0;
    for (let g = run.startWord; g <= run.endWord; g++) if (observed.has(g)) n++;
    return n;
  }

  function selectBlock(run: SpeakerRun) {
    headerPicker = null;
    pickerOpen = false;
    anchor = run.startWord;
    range = { from: run.startWord, to: run.endWord };
  }

  // --- Time-anchored notes: reviewer annotations pinned to a moment, not a
  // word - what's on screen, an action, or a non-verbal event (laughter,
  // applause, a pause) the speech transcript can't carry. Persisted locally for
  // now; the committed {hash}.notes.json sidecar is the follow-up. ---
  interface VisualNote {
    id: string;
    at: number;
    text: string;
  }

  // Quick tags for non-verbal events - the things speech transcription drops.
  // Picking one writes a inline note marker (e.g. `{{laughs}}`) so it reads like a
  // standard transcript event. Shared with the segment editor's quick-insert.
  const NOTE_PRESETS = EVENT_NOTE_PRESETS;

  // Notes are transient compose state only: adding one opens an inline editor,
  // and committing writes the inline note token into the BODY (a `{{t:}}{{laughs}}`
  // word the digester reads as meta), not a localStorage overlay - so a note is
  // real, persists, and reaches extraction, matching the segment editor. An
  // uncommitted note lives only for the compose session.
  let notes = $state<VisualNote[]>([]);
  let editingNoteId = $state<string | null>(null);
  let noteInputEl = $state<HTMLTextAreaElement>();

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

  // --- Span notes: free text over a word range --------------------------------
  // Composing a new span note holds the selected range + draft text until saved;
  // editing an existing one is by its id. Both write to the body via the host
  // handlers (real, persisted markers), mirroring the point-note commit path.
  let composeSpanNote = $state<{ from: number; to: number; text: string } | null>(null);
  let editingSpanNoteId = $state<string | null>(null);
  let editingSpanNoteText = $state("");
  let spanNoteInputEl = $state<HTMLTextAreaElement>();

  /** Begin a span note over the current selection: capture the range, drop the
   *  selection (so the compose card is readable), and focus the editor. */
  function startSpanNote() {
    if (!range) return;
    composeSpanNote = { from: range.from, to: range.to, text: "" };
    pickerOpen = false;
    clearSelection();
    setTimeout(() => spanNoteInputEl?.focus(), 0);
  }

  /** Commit the compose draft to a real span note (no-op on empty text). */
  function commitSpanNote() {
    const c = composeSpanNote;
    composeSpanNote = null;
    if (!c) return;
    if (c.text.trim()) onspannote?.(c.from, c.to, c.text);
  }

  function cancelSpanNote() {
    composeSpanNote = null;
  }

  function startSpanNoteEdit(id: string, text: string) {
    editingSpanNoteId = id;
    editingSpanNoteText = text;
    setTimeout(() => spanNoteInputEl?.focus(), 0);
  }

  function saveSpanNoteEdit(id: string) {
    editingSpanNoteId = null;
    onspannoteedit?.(id, editingSpanNoteText);
  }

  function removeSpanNote(id: string) {
    if (editingSpanNoteId === id) editingSpanNoteId = null;
    onspannoteremove?.(id);
  }

  /** Plain text of the current word selection, words space-joined as shown. */
  function selectionText(): string {
    if (!range) return "";
    return words
      .slice(range.from, range.to + 1)
      .map((w) => w.text)
      .join(" ");
  }

  // Publish the selection so Ctrl+F can search for it without the host having
  // to reach into this component's word range.
  $effect(() => {
    void range;
    untrack(() => onselectiontext?.(selectionText()));
  });

  /** Put the selected words on the clipboard. The selection is a custom word
   *  range and the transcript is `select-none`, so the browser has nothing to
   *  copy natively - we write the text ourselves. Falls back to execCommand for
   *  non-secure contexts where navigator.clipboard is unavailable. */
  async function copySelection(): Promise<void> {
    const text = selectionText();
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
    } catch {
      /* fall through to the legacy path */
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } finally {
      document.body.removeChild(ta);
    }
  }

  function inEditableTarget(t: EventTarget | null): boolean {
    return (
      t instanceof HTMLInputElement ||
      t instanceof HTMLTextAreaElement ||
      (t instanceof HTMLElement && t.isContentEditable)
    );
  }

  function onWindowKeydown(e: KeyboardEvent) {
    // Escape dismisses an active word selection (and its floating bar / picker).
    // The edit-selection dialog handles its own Escape, so defer while it is open
    // or while focus is in a field (typing in a note/dialog).
    if (e.key === "Escape") {
      if (editingSelection || inEditableTarget(e.target)) return;
      if (composeSpanNote) {
        e.preventDefault();
        cancelSpanNote();
        return;
      }
      if (pickerOpen || headerPicker !== null || range) {
        e.preventDefault();
        pickerOpen = false;
        headerPicker = null;
        clearSelection();
      }
      return;
    }
    // Ctrl/Cmd-C copies the selected words. Defer to the browser when focus is
    // in a field or there's a real text selection (e.g. note text), so normal
    // copy keeps working there.
    if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C") && !e.altKey) {
      const nativeSelection = (window.getSelection()?.toString() ?? "").length > 0;
      if (!range || nativeSelection || inEditableTarget(e.target)) return;
      e.preventDefault();
      void copySelection();
      return;
    }
    if (e.key !== "v" || e.ctrlKey || e.metaKey || e.altKey) return;
    if (inEditableTarget(e.target)) return;
    e.preventDefault();
    addNoteAtCurrentTime();
  }

  /** Commit a composed note into the body as a first-class `[...]` event note
   *  attached to the word at its moment. The note is not a word - it adds no
   *  gIndex - so the observed set and coverage are untouched. */
  function writeEventNoteToBody(at: number, text: string) {
    oneventnote?.(at, text);
  }

  function commitNote(id: string) {
    const note = notes.find((n) => n.id === id);
    const text = note?.text.trim() ?? "";
    notes = notes.filter((n) => n.id !== id); // remove the transient compose note
    editingNoteId = null;
    if (note && text) writeEventNoteToBody(note.at, text);
  }

  /** Insert a preset event marker at the note's moment and close the editor.
   *  The label is bare - brackets are the on-disk notation, added on serialise. */
  function applyPreset(note: VisualNote, label: string) {
    notes = notes.filter((n) => n.id !== note.id);
    editingNoteId = null;
    writeEventNoteToBody(note.at, label);
  }

  // Braces are the `{{...}}` notation, not content: the reviewer never types them.
  function blockBrackets(e: KeyboardEvent) {
    if (e.key === "{" || e.key === "}") e.preventDefault();
  }

  function deleteNote(id: string) {
    notes = notes.filter((n) => n.id !== id);
    if (editingNoteId === id) editingNoteId = null;
  }

  // Editing a committed note (one that already lives in the body as a
  // word.notes entry), by anchor word gIndex + its ordinal among that word's
  // notes. Kept distinct from the transient compose editor above.
  let editingBodyNote = $state<{ gIndex: number; ordinal: number; text: string } | null>(null);
  function openBodyNoteEditor(gIndex: number, ordinal: number) {
    editingBodyNote = { gIndex, ordinal, text: words[gIndex]?.notes?.[ordinal] ?? "" };
  }
  function saveBodyNote() {
    if (!editingBodyNote) return;
    const { gIndex, ordinal, text } = editingBodyNote;
    editingBodyNote = null;
    oneventnoteedit?.(gIndex, ordinal, text);
  }
  function removeBodyNote(gIndex: number, ordinal: number) {
    if (editingBodyNote?.gIndex === gIndex && editingBodyNote.ordinal === ordinal) {
      editingBodyNote = null;
    }
    oneventnoteremove?.(gIndex, ordinal);
  }

  function secondsToClock(s: number): string {
    const t = Math.max(0, Math.floor(s));
    const pad = (n: number) => String(n).padStart(2, "0");
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    return h > 0 ? `${h}:${pad(m)}:${pad(t % 60)}` : `${m}:${pad(t % 60)}`;
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
    // Reposition the floating bar when the selection changes.
    void range;
    if (range) schedulePositionBar();
  });

  // --- Imperative per-word highlighting -------------------------------------
  // Each word span carries a static class; its highlight state (selected,
  // active/karaoke, resume marker, deep-linked claim, observed) is applied here
  // by toggling classes on only the words that changed. This keeps a selection
  // drag or a playback tick O(words changed), not O(all words): with tens of
  // thousands of word spans, a reactive per-word class re-evaluated the lot on
  // every change, which made selection crawl. The looks live in app.css
  // (`.wt-word`); precedence is by source order there.

  // gIndex -> the rendered word span. Rebuilt whenever the rendered run set
  // changes (record load, filter, edit). Off-screen words under
  // content-visibility are still in the DOM, so they stay addressable here.
  let wordEls = new Map<number, HTMLElement>();
  // Bumped to force a full restyle when `observed` changes with no DOM delta to
  // drive an incremental update from (draft restore, async server-coverage
  // merge). In-session marks (auto-observe, set seen/unseen) apply their own
  // deltas directly and don't bump this.
  let styleEpoch = $state(0);

  function rebuildWordEls() {
    wordEls = new Map();
    if (!scrollEl) return;
    for (const el of scrollEl.querySelectorAll<HTMLElement>("[data-word-index]")) {
      wordEls.set(Number(el.dataset.wordIndex), el);
    }
  }

  // Set word g's classes from the current highlight state. Idempotent. Reads
  // state non-reactively - callers run inside untrack or an event handler.
  function applyWord(g: number) {
    const el = wordEls.get(g);
    if (!el) return;
    const c = el.classList;
    c.toggle("wt-sel", range !== null && g >= range.from && g <= range.to);
    c.toggle("wt-claim", claimWords.has(g));
    c.toggle("wt-resume", g === resumeWord);
    c.toggle("wt-active", g === activeWord);
    c.toggle("wt-observed", observed.has(g));
    // Reviewer-highlight underline bands: sparse, so paint straight onto the
    // word rather than carry a class per possible band count.
    const cols = highlightColorsByWord.get(g);
    applyWordHighlight(el, cols);
    c.toggle("wt-highlight", cols !== undefined);
    c.toggle("wt-spannote", spanNoteWordSet.has(g));
    c.toggle("wt-markup-focus", focusWordSet.has(g));
  }

  function reapplyAll() {
    for (const g of wordEls.keys()) applyWord(g);
  }

  // Restyle only the words whose membership of the selection changed between two
  // ranges. For overlapping ranges that's just the moved edge, so extending a
  // drag by one word is one update, not one per word in the selection.
  function applyRangeDelta(
    a: { from: number; to: number } | null,
    b: { from: number; to: number } | null,
  ) {
    if (!a && !b) return;
    if (!a) {
      for (let g = b!.from; g <= b!.to; g++) applyWord(g);
      return;
    }
    if (!b) {
      for (let g = a.from; g <= a.to; g++) applyWord(g);
      return;
    }
    if (b.to < a.from || a.to < b.from) {
      for (let g = a.from; g <= a.to; g++) applyWord(g);
      for (let g = b.from; g <= b.to; g++) applyWord(g);
      return;
    }
    for (let g = Math.min(a.from, b.from); g < Math.max(a.from, b.from); g++) applyWord(g);
    for (let g = Math.min(a.to, b.to) + 1; g <= Math.max(a.to, b.to); g++) applyWord(g);
  }

  // Per-word estimate for content-visibility's contain-intrinsic-size, so the
  // scrollbar and jump targets are about right before a run has been rendered
  // once. The `auto` keyword (in the style attribute) then caches the real
  // height after first paint, so the estimate only matters initially.
  function runIntrinsic(run: SpeakerRun): number {
    const n = run.endWord - run.startWord + 1;
    return 56 + Math.ceil(n / 11) * 23;
  }

  // Pointer interaction is delegated from the words container: `pointerenter`
  // doesn't bubble, so per-word handlers meant tens of thousands of listeners.
  // One pointerdown + one pointerover (which does bubble) read the word from the
  // event target instead.
  function onContainerPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const el = (e.target as HTMLElement | null)?.closest?.("[data-word-index]") as HTMLElement | null;
    if (!el) return;
    onWordPointerDown(e, Number(el.dataset.wordIndex));
  }

  function onContainerPointerOver(e: PointerEvent) {
    if (!dragging) return;
    const el = (e.target as HTMLElement | null)?.closest?.("[data-word-index]") as HTMLElement | null;
    if (!el) return;
    onWordPointerEnter(Number(el.dataset.wordIndex));
  }

  // Double-click a word to jump straight into the editor on that single word.
  // Markup is read-only, so there is no word editor to open.
  function onContainerDblClick(e: MouseEvent) {
    if (mode === "markup") return;
    const el = (e.target as HTMLElement | null)?.closest?.("[data-word-index]") as HTMLElement | null;
    if (!el) return;
    selectWord(Number(el.dataset.wordIndex), false);
    editingSelection = true;
  }

  // Trackers mirroring the DOM's applied state, so each effect diffs and touches
  // only what moved.
  let appliedRange: { from: number; to: number } | null = null;
  let appliedActive = -1;
  let appliedResume: number | null = null;
  let appliedClaim = new Set<number>();

  // Full restyle when the rendered word set changes (load/filter/edit) or after
  // an observed change with no DOM delta (epoch bump). Deliberately tracks only
  // those signals - NOT range/active/etc - so a selection never triggers it.
  $effect(() => {
    void renderRuns;
    void markupVisible; // markup hides unobserved words; restyle when that set moves
    void styleEpoch;
    void highlightColorsByWord; // re-apply bands when a highlight is added/cleared
    void spanNoteWordSet; // re-apply tint when a span note is added/cleared/re-ranged
    void focusWordSet; // re-apply markup focus flash
    const el = scrollEl;
    untrack(() => {
      if (!el) return;
      rebuildWordEls();
      reapplyAll();
      appliedRange = range ? { from: range.from, to: range.to } : null;
      appliedActive = activeWord;
      appliedResume = resumeWord;
      appliedClaim = new Set(claimWords);
    });
  });

  $effect(() => {
    const r = range;
    untrack(() => {
      const prev = appliedRange;
      appliedRange = r ? { from: r.from, to: r.to } : null;
      applyRangeDelta(prev, appliedRange);
    });
  });

  $effect(() => {
    const a = activeWord;
    untrack(() => {
      if (a === appliedActive) return;
      const prev = appliedActive;
      appliedActive = a;
      if (prev >= 0) applyWord(prev);
      if (a >= 0) applyWord(a);
    });
  });

  $effect(() => {
    const r = resumeWord;
    untrack(() => {
      if (r === appliedResume) return;
      const prev = appliedResume;
      appliedResume = r;
      if (prev !== null) applyWord(prev);
      if (r !== null) applyWord(r);
    });
  });

  $effect(() => {
    const cw = claimWords;
    untrack(() => {
      for (const g of appliedClaim) if (!cw.has(g)) applyWord(g);
      for (const g of cw) if (!appliedClaim.has(g)) applyWord(g);
      appliedClaim = new Set(cw);
    });
  });

  function clampToRun(a: number, b: number): { from: number; to: number } | null {
    // Markup annotates across speakers, so a selection there is only bounded by
    // the transcript itself; editing must stay in one turn (reassign/split are
    // per-turn operations), so it clamps `b` into the anchor's run.
    if (mode === "markup") {
      if (words.length === 0) return null;
      const lo = Math.max(0, Math.min(a, b));
      const hi = Math.min(words.length - 1, Math.max(a, b));
      return { from: lo, to: hi };
    }
    const run = runOfWord.get(a);
    if (!run) return null;
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
      return;
    }
    // Ctrl/Alt/Cmd+click (or drag) selects without moving playback, so you can
    // grab words to copy or edit while the audio keeps its place. A plain click
    // still seeks there.
    const selectOnly = e.ctrlKey || e.altKey || e.metaKey;
    selectWord(g, false);
    dragging = true;
    if (!selectOnly && onseek && words[g]) onseek(words[g].start);
  }

  function onWordPointerEnter(g: number) {
    if (dragging && anchor !== null) {
      range = clampToRun(anchor, g);
    }
  }

  function stopDrag() {
    dragging = false;
  }

  function clearSelection() {
    anchor = null;
    range = null;
    pickerOpen = false;
    editingSelection = false;
  }

  function chooseSpeaker(name: string) {
    if (range) onreassign(range.from, range.to, name);
    clearSelection();
  }

  let observedPct = $derived(observedPercent(coverageVerdict.observed_coverage));

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

  // Scroll to a side-list-clicked markup range (its first word, centred), same
  // retry-across-frames reasoning as the claim scroll.
  function scrollToFocus() {
    const first = focusWords?.from;
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
      const target = scrollEl.scrollTop + (word.top - view.top) - view.height * 0.4;
      scrollEl.scrollTo({ top: Math.max(0, target) });
    };
    requestAnimationFrame(tryScroll);
  }

  $effect(() => {
    void focusWords?.seq;
    untrack(() => {
      if (focusWords) scrollToFocus();
    });
  });

  function toggleHeaderPicker(run: SpeakerRun) {
    if (mode === "markup") return; // no speaker reassignment in read-only markup
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

<!-- A span-note card: shown inline at the range's first word. Distinct from the
     amber point-note cards (primary-tinted, monitor icon) to read as range
     context, not an in-flow beat. -->
{#snippet spanNoteCard(id: string, text: string, count: number)}
  <span
    style="display:flex"
    class="my-1.5 items-start gap-1.5 rounded border border-primary/50 bg-primary-container/20 px-2 py-1 text-xs not-italic text-on-surface select-text"
  >
    <svg class="w-3.5 h-3.5 flex-none mt-0.5 text-primary" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <path stroke-linecap="round" d="M8 21h8M12 17v4" />
    </svg>
    {#if editingSpanNoteId === id}
      <span style="display:flex" class="flex-1 min-w-0 flex-col gap-1.5">
        <textarea
          bind:this={spanNoteInputEl}
          bind:value={editingSpanNoteText}
          onblur={() => saveSpanNoteEdit(id)}
          onkeydown={(e) => { blockBrackets(e); if (e.key === "Escape") { e.preventDefault(); saveSpanNoteEdit(id); } }}
          rows="2"
          placeholder="What the words miss here - on-screen text, an image, context... (empty removes the note)"
          class="w-full bg-surface border border-primary rounded px-1.5 py-1 text-xs text-on-surface outline-none resize-y"
        ></textarea>
        <button onclick={() => saveSpanNoteEdit(id)} class="self-start text-xs font-ui font-medium text-primary cursor-pointer hover:underline">Save</button>
      </span>
    {:else}
      <span class="flex-none text-[10px] font-ui uppercase tracking-wide text-primary/70 mt-0.5 tabular-nums">
        {count}w
      </span>
      <span class="flex-1 min-w-0 whitespace-pre-wrap font-medium">{text}</span>
      <button
        onclick={() => startSpanNoteEdit(id, text)}
        class="flex-none text-on-surface-muted/70 hover:text-primary cursor-pointer"
        title="Edit note" aria-label="Edit note"
      >
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path stroke-linecap="round" stroke-linejoin="round" d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
      </button>
      <button
        onclick={() => removeSpanNote(id)}
        class="flex-none text-on-surface-muted/70 hover:text-error cursor-pointer"
        title="Remove note" aria-label="Remove note"
      >
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    {/if}
  </span>
{/snippet}

<!-- The compose card for a new span note over the just-selected range. -->
{#snippet spanNoteCompose()}
  <span
    style="display:flex"
    class="my-1.5 items-start gap-1.5 rounded border border-primary bg-primary-container/20 px-2 py-1 text-xs not-italic text-on-surface select-text"
  >
    <svg class="w-3.5 h-3.5 flex-none mt-0.5 text-primary" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <path stroke-linecap="round" d="M8 21h8M12 17v4" />
    </svg>
    <span style="display:flex" class="flex-1 min-w-0 flex-col gap-1.5">
      <textarea
        bind:this={spanNoteInputEl}
        bind:value={composeSpanNote!.text}
        onblur={commitSpanNote}
        onkeydown={(e) => {
          blockBrackets(e);
          if (e.key === "Escape") { e.preventDefault(); cancelSpanNote(); }
        }}
        rows="2"
        placeholder="What the words miss over these words - on-screen text, an image, context (no braces)..."
        class="w-full bg-surface border border-primary rounded px-1.5 py-1 text-xs text-on-surface outline-none resize-y"
      ></textarea>
      <span style="display:flex" class="items-center gap-3">
        <button onmousedown={(e) => e.preventDefault()} onclick={commitSpanNote} class="text-xs font-ui font-medium text-primary cursor-pointer hover:underline">Save</button>
        <button onmousedown={(e) => e.preventDefault()} onclick={cancelSpanNote} class="text-xs font-ui text-on-surface-muted hover:text-on-surface cursor-pointer">Cancel</button>
      </span>
    </span>
  </span>
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
      <span class="text-xs font-ui text-on-surface-secondary tabular-nums">
        {count} word{count === 1 ? "" : "s"}
      </span>
      {#if mode === "markup"}
        <!-- Annotation actions: mint a highlight (no text) or a note (with text),
             and clear any mark under the selection. Editing lives in the Ingest
             tab; markup is read-only over the words. -->
        <div class="w-px h-4 bg-border" aria-hidden="true"></div>
        <button
          onclick={() => { if (range) { onhighlight?.(range.from, range.to); clearSelection(); } }}
          class="text-xs font-ui font-medium text-primary cursor-pointer hover:underline"
          title="Highlight these words (highlights may overlap)"
        >
          Highlight
        </button>
        <div class="w-px h-4 bg-border" aria-hidden="true"></div>
        <button
          onclick={startSpanNote}
          class="text-xs font-ui font-medium text-primary cursor-pointer hover:underline"
          title="Attach a note over these words - what's on screen, context the words miss"
        >
          Note
        </button>
        {#if selectionHasMarkup}
          <div class="w-px h-4 bg-border" aria-hidden="true"></div>
          <button
            onclick={clearMarkupUnderSelection}
            class="text-xs font-ui font-medium text-on-surface-secondary cursor-pointer hover:underline"
            title="Remove the highlight(s)/note(s) over these words"
          >
            Clear
          </button>
        {/if}
      {:else}
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
          onclick={cycleCase}
          class="text-xs font-ui font-medium text-primary cursor-pointer hover:underline tabular-nums min-w-7 text-center"
          title="Cycle case: lowercase -> Capitalised -> UPPERCASE"
        >
          {caseLabel}
        </button>
        <div class="w-px h-4 bg-border" aria-hidden="true"></div>
        <button
          onclick={() => { pickerOpen = false; editingSelection = true; }}
          class="text-xs font-ui font-medium text-primary cursor-pointer hover:underline"
          title={single
            ? "Edit this word: text, timing, split or delete"
            : "Edit the selected words together: text, timing, add/delete words"}
        >
          {single ? "Edit word" : "Edit selection"}
        </button>
      {/if}
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
  </div>
{/if}

<!-- Top toolbar: drop a time-anchored note at the current playback moment
     (also bound to the `v` key, handled in IngestViewer) plus observation
     controls. Hidden in markup, which is read-only and annotation-only. -->
{#if mode !== "markup"}
<div class="flex-none flex items-center gap-2 px-4 py-1.5 border-b border-border bg-surface-alt">
  <button
    onclick={() => addNoteAtCurrentTime()}
    class="flex items-center gap-1.5 text-xs font-ui font-medium text-primary cursor-pointer hover:underline"
    title="Add a note at the current playback time - what's on screen, an action, a sound (v)"
  >
    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
      />
    </svg>
    Add note
  </button>
  <span class="text-xs font-ui text-on-surface-muted tabular-nums">at {secondsToClock(currentTime)}</span>
  {#if range}
    {@const selN = range.to - range.from + 1}
    <span class="ml-auto text-xs font-ui text-on-surface-muted tabular-nums">
      {selN} selected
    </span>
    <button
      onclick={() => setSelectionObserved(true)}
      disabled={rangeAllObserved()}
      class="text-xs font-ui font-medium hover:underline
        {rangeAllObserved() ? 'text-on-surface-muted/50 cursor-default' : 'text-primary cursor-pointer'}"
      title="Mark the selected words as observed"
    >
      Set observed
    </button>
    <button
      onclick={() => setSelectionObserved(false)}
      disabled={rangeNoneObserved()}
      class="text-xs font-ui font-medium hover:underline
        {rangeNoneObserved() ? 'text-on-surface-muted/50 cursor-default' : 'text-primary cursor-pointer'}"
      title="Mark the selected words as not observed"
    >
      Set not observed
    </button>
  {:else}
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
  {/if}
  <span class="text-xs font-ui text-on-surface-muted/60">{notes.length} note{notes.length === 1 ? "" : "s"}</span>
</div>
{/if}

<div
  bind:this={scrollEl}
  onscroll={() => range && schedulePositionBar()}
  class="flex-1 overflow-auto"
  data-scroll-sync
>
  <!-- Top headroom so the selection bar always has room to sit above even the
       first line, and never has to flip below it. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="select-none pt-12"
    onpointerdown={onContainerPointerDown}
    onpointerover={onContainerPointerOver}
    ondblclick={onContainerDblClick}
  >
    {#if markupEmpty}
      <p class="px-6 py-8 text-sm text-on-surface-muted max-w-prose">
        Nothing to mark up yet. Only content you've observed (and that isn't marked
        irrelevant) shows here - observe the transcript in the Ingest tab first,
        then come back to highlight and note it.
      </p>
    {/if}
    {#each renderRuns as run (run.startWord)}
      {@const obs = observedInRun(run)}
      {@const total = run.endWord - run.startWord + 1}
      {@const runGs = Array.from({ length: total }, (_, k) => run.startWord + k).filter(
        (g) => mode !== "markup" || markupVisible.has(g),
      )}
      <!-- content-visibility:auto lets the browser skip layout/paint for runs
           off-screen while keeping their words in the DOM (so jump-to-word,
           claim links and karaoke centring still find them). It clips overflow,
           which would cut off this run's speaker dropdown, so the run with an
           open header picker switches to visible. -->
      <div
        class="border-b border-border/50 px-4 pt-3 pb-2"
        style="content-visibility:{headerPicker === run.startWord
          ? 'visible'
          : 'auto'};contain-intrinsic-size:auto {runIntrinsic(run)}px"
      >
        <div class="flex items-center justify-between gap-2 pb-1">
          {#if mode === "markup"}
            <!-- Read-only speaker label: markup doesn't reassign speakers. -->
            <div class="flex items-center gap-2 px-1 -mx-1">
              <div class="w-4 flex-none flex items-center justify-center">
                <SpeakerDot speaker={run.speaker} />
              </div>
              <span class="text-xs font-ui font-medium text-on-surface-secondary">{run.speaker}</span>
            </div>
          {:else}
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
          {/if}
        </div>
        <!-- leading-[1.75]: a touch more than relaxed so highlight underline
             bands sit in real leading below a wrapped line, never reaching the
             text below. -->
        <p class="pl-6 text-sm text-on-surface leading-[1.75]">
          {#each runGs as g (g)}<span
              data-word-index={g}
              class="wt-word">{words[g].text}</span>{" "}
            <!-- Committed event notes on this word: first-class annotation
                 chips, NOT spoken words - no timestamp, never in the word
                 editor. display:flex breaks each onto its own line. -->
            {#each words[g].notes ?? [] as noteText, ordinal (ordinal)}
              <span
                data-event-note={g}
                data-note-ordinal={ordinal}
                style="display:flex"
                class="my-1.5 items-start gap-1.5 rounded border border-warning/50 bg-warning-container/20 px-2 py-1 text-xs not-italic text-on-surface select-text"
              >
                <svg class="w-3.5 h-3.5 flex-none mt-0.5 text-warning" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                {#if editingBodyNote?.gIndex === g && editingBodyNote.ordinal === ordinal}
                  <span style="display:flex" class="flex-1 min-w-0 flex-col gap-1.5">
                    <textarea
                      bind:value={editingBodyNote.text}
                      onblur={saveBodyNote}
                      onkeydown={(e) => { blockBrackets(e); if (e.key === "Escape") { e.preventDefault(); saveBodyNote(); } }}
                      rows="2"
                      placeholder="e.g. laughs, applause, inaudible..."
                      class="w-full bg-surface border border-primary rounded px-1.5 py-1 text-xs text-on-surface outline-none resize-y"
                    ></textarea>
                    <span style="display:flex" class="flex-wrap items-center gap-1">
                      <span class="text-[10px] font-ui uppercase tracking-wide text-on-surface-muted/70 mr-0.5">Quick</span>
                      {#each NOTE_PRESETS as preset}
                        <button
                          type="button"
                          onpointerdown={(e) => e.preventDefault()}
                          onclick={() => { if (editingBodyNote) editingBodyNote.text = preset; }}
                          class="px-1.5 py-0.5 rounded-full border border-border text-[11px] font-ui text-on-surface-secondary hover:bg-primary-container/30 hover:border-primary/50 cursor-pointer"
                        >{preset}</button>
                      {/each}
                    </span>
                    <button onclick={saveBodyNote} class="self-start text-xs font-ui font-medium text-primary cursor-pointer hover:underline">Save</button>
                  </span>
                {:else}
                  <span class="flex-1 min-w-0 whitespace-pre-wrap font-medium">{noteText}</span>
                  {#if oneventnoteedit}
                    <button
                      onclick={() => openBodyNoteEditor(g, ordinal)}
                      class="flex-none text-on-surface-muted/70 hover:text-primary cursor-pointer"
                      title="Edit note" aria-label="Edit note"
                    >
                      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                        <path stroke-linecap="round" stroke-linejoin="round" d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </svg>
                    </button>
                    <button
                      onclick={() => removeBodyNote(g, ordinal)}
                      class="flex-none text-on-surface-muted/70 hover:text-error cursor-pointer"
                      title="Remove note" aria-label="Remove note"
                    >
                      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                        <path stroke-linecap="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  {/if}
                {/if}
              </span>
            {/each}
            {#each notesByAnchorWord.get(g) ?? [] as note (note.id)}
              <!-- Reviewer note: rendered inline at its moment but clearly
                   markup, not speech (playback ignores it - it isn't a word).
                   display:flex breaks it onto its own line. -->
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
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
                  />
                </svg>
                {#if editingNoteId === note.id}
                  <span style="display:flex" class="flex-1 min-w-0 flex-col gap-1.5">
                    <textarea
                      bind:this={noteInputEl}
                      bind:value={note.text}
                      onblur={() => commitNote(note.id)}
                      onkeydown={(e) => {
                        blockBrackets(e);
                        if (e.key === "Escape") {
                          e.preventDefault();
                          commitNote(note.id);
                        }
                      }}
                      rows="2"
                      placeholder="Note this moment - a sound, an action (no braces - added automatically)..."
                      class="w-full bg-surface border border-primary rounded px-1.5 py-1 text-xs text-on-surface outline-none resize-y"
                    ></textarea>
                    <!-- Quick event tags. preventDefault on pointerdown keeps the
                         textarea focused so its onblur doesn't bin the empty note
                         before this click sets the text. -->
                    <span style="display:flex" class="flex-wrap items-center gap-1">
                      <span class="text-[10px] font-ui uppercase tracking-wide text-on-surface-muted/70 mr-0.5"
                        >Quick</span
                      >
                      {#each NOTE_PRESETS as preset}
                        <button
                          type="button"
                          onpointerdown={(e) => e.preventDefault()}
                          onclick={() => applyPreset(note, preset)}
                          class="px-1.5 py-0.5 rounded-full border border-border text-[11px] font-ui text-on-surface-secondary hover:bg-primary-container/30 hover:border-primary/50 cursor-pointer"
                          title={`Tag this moment as [${preset}]`}
                        >{preset}</button>
                      {/each}
                    </span>
                    <span style="display:flex" class="items-center gap-3">
                      <button
                        onclick={() => commitNote(note.id)}
                        class="text-xs font-ui font-medium text-primary cursor-pointer hover:underline"
                      >Save</button>
                    </span>
                  </span>
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
            <!-- Span notes starting at this word: free text over a word range,
                 shown as a card at the range's first word. The tinted words
                 (.wt-spannote) show its extent. -->
            {#each spanNotesByStartWord.get(g) ?? [] as sn (sn.id)}
              {@render spanNoteCard(sn.id, sn.text, sn.toWord - sn.fromWord + 1)}
            {/each}
            {#if composeSpanNote?.from === g}
              {@render spanNoteCompose()}
            {/if}
          {/each}
        </p>
      </div>
    {/each}
  </div>

  {#if editingSelection && range && selectionInfo}
    <EditSelectionDialog
      words={selectionInfo.words}
      prevStart={selectionInfo.prevStart}
      nextStart={selectionInfo.nextStart}
      speaker={selectionInfo.speaker}
      {sourceHash}
      {mediaDuration}
      {currentTime}
      onseek={(t) => onseek?.(t)}
      oncancel={() => { editingSelection = false; }}
      onsave={(newWords) => {
        if (range) onreplaceselection?.(range.from, range.to, newWords);
        editingSelection = false;
        range = null;
      }}
    />
  {/if}
</div>
