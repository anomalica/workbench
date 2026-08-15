<script lang="ts">
  import { untrack, onMount } from "svelte";
  import {
    saveScrollAnchor,
    loadScrollAnchor,
    resolveAnchorTarget,
    shouldPersistScroll,
  } from "$lib/scroll-anchor";
  import { foldTurns, parseWords, wordsInTimeRange, wordActiveAt } from "$lib/transcript-words";
  import type { SpeakerRun, WordExternal } from "$lib/transcript-words";
  import { buildContextIndex } from "$lib/highlight-context";
  import { pointerMoved } from "$lib/drag-intent";
  import { EVENT_NOTE_PRESETS } from "$lib/transcript";
  import {
    assignableSpecialSpeakers,
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
    onmodechange,
    showObservedOnly = false,
    onobservedonlychange,
    focusWords = null,
    onclearfocus,
    sourceHash = "",
    recordHash = "",
    mediaDuration = null,
    copyrightStatus = null,
    namedSpeakers = [],
    currentTime = 0,
    filteredSpeakers = new Set<string>(),
    hideIrrelevant = true,
    storageKey = "",
    serverObserved = [],
    storedCoverage = null,
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
    onhighlightcontext,
    onhighlightcontextremove,
    onselectiontext,
    onlinksource,
    onlinkopen,
    onlinkremove,
    onexternal,
    onexternalremove,
    onexternaledit,
    linkTitles,
    onseek,
    onpause,
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
    /** Raised by the sub-toolbar mode switch. The owner holds the mode (and
     *  persists it), so this component stays controlled - the same body renders
     *  across a mode change with no remount, which is the whole point of folding
     *  Markup back in from a separate tab. */
    onmodechange?: (mode: "edit" | "markup") => void;
    /** Filter the transcript to observed, relevant words only. INDEPENDENT of
     *  mode: it used to be welded to markup, so switching mode also changed what
     *  was on screen. Now a mode switch never moves a word, and this is a
     *  separate toolbar toggle the owner persists. */
    showObservedOnly?: boolean;
    onobservedonlychange?: (value: boolean) => void;
    /** Scroll to + flash an inclusive word range (the markup side list clicking a
     *  mark). `seq` is bumped per navigation so re-clicking the same mark
     *  re-triggers. */
    focusWords?: { from: number; to: number; seq: number } | null;
    /** Ask the owner to drop `focusWords`. Raised on any press in the transcript
     *  so the emphasis never becomes a stuck selection the reviewer has to hunt
     *  for a way to clear. */
    onclearfocus?: () => void;
    /** Source SHA-256 (== content hash for a/v records), so the word editor can
     *  fetch a waveform window for the audio around a timestamp. */
    sourceHash?: string;
    /** Stable per-record key for the scroll anchor - SAME across the Ingest and
     *  Markup tabs, so switching between them returns to the same word. */
    recordHash?: string;
    /** Media length in seconds, to clamp the waveform window. */
    mediaDuration?: number | null;
    /** Record copyright status - decides whether the peaks sidecar is openly
     *  addressable online. */
    copyrightStatus?: string | null;
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
    /** The sidecar's stored observed_coverage (0..1), the durable cumulative
     *  truth. When the live recompute falls BELOW it - impossible, since
     *  observation only grows - the word-index spans no longer align (the body
     *  grew under transcript edits) and per-word shading is unreliable. */
    storedCoverage?: number | null;
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
    /** Record that highlight `of` needs earlier highlight `needs` for context. */
    onhighlightcontext?: (of: string, needs: string) => void;
    onhighlightcontextremove?: (of: string, needs: string) => void;
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
    /** Pause playback in place (no seek). Raised when a press in markup mode
     *  becomes a DRAG: dragging is the reviewer lining up a highlight, and
     *  playback running on under the selection fights the gesture. */
    onpause?: () => void;
    /** Start the cross-record link flow for the selected range: the owner opens
     *  its record picker (this component has no record list) and calls
     *  doc.addWordLink on confirm. Markup-mode action. */
    onlinksource?: (from: number, to: number) => void;
    /** Open the linked record. */
    onlinkopen?: (target: string) => void;
    onlinkremove?: (id: string) => void;
    /** Mark the range as external content - played or quoted here. */
    onexternal?: (from: number, to: number) => void;
    onexternalremove?: (id: string) => void;
    /** Reopen the source question on an existing passage. */
    onexternaledit?: (id: string) => void;
    /** Titles of the records this one links to, by content hash. A link is
     *  stored as a hash, which tells the reviewer nothing on its own - without
     *  a title the underline says "this refers to something" and stops. */
    linkTitles?: Map<string, string>;
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

  // Restore the scroll anchor once the words are on screen. rAF-retries because
  // on a fresh mount the word DOM is not painted on the first frame.
  onMount(() => {
    let frames = 0;
    const tryRestore = () => {
      restoreScrollAnchor();
      if (!anchorRestored && frames++ < 30) requestAnimationFrame(tryRestore);
    };
    requestAnimationFrame(tryRestore);
  });
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
  // INGEST reads for content: a highlight there only needs to register as
  // PRESENT. Six palette colours stacked one band per overlap is noise when
  // you're trying to read - so Ingest gets a single hairline in the text's own
  // colour at low alpha, and MARKUP keeps the colour coding, which is where
  // telling one highlight from another is the job.
  const SUBTLE_BAND_H = 1; // px
  const SUBTLE_HL = "color-mix(in srgb, currentColor 30%, transparent)";
  // Which highlight ids cover a word, so a click can say WHICH highlight was hit.
  let highlightIdsByWord = $derived.by(() => {
    const m = new Map<number, string[]>();
    for (const h of parsed.highlights) {
      for (let g = h.fromWord; g <= h.toWord; g++) {
        const list = m.get(g) ?? [];
        list.push(h.id);
        m.set(g, list);
      }
    }
    return m;
  });

  let highlightById = $derived(new Map(parsed.highlights.map((h) => [h.id, h])));

  let contextIndex = $derived(buildContextIndex(parsed.highlightContexts));

  // Words inside a cross-record link span, for the dotted "this references
  // another record" underline. Rendered in BOTH modes - a link is navigation,
  // not markup colour - and deliberately fainter than any highlight band.
  let linkWordSet = $derived.by(() => {
    const s = new Set<number>();
    for (const l of parsed.links) for (let g = l.fromWord; g <= l.toWord; g++) s.add(g);
    return s;
  });

  /** Words inside a passage marked as external content, and what each one says
   *  it is - the tint tells the reviewer at a glance that this was played or
   *  quoted here rather than said here. */
  let externalWordSet = $derived.by(() => {
    const m = new Map<number, string>();
    for (const e of parsed.externals) {
      const label = e.description
        ? `External content: ${e.description}`
        : "External content - played or quoted here, not said here";
      for (let g = e.fromWord; g <= e.toWord; g++) m.set(g, label);
    }
    return m;
  });

  /** Turns that lie wholly inside a quoted passage.
   *
   *  They keep their own speaker name. Letters were tried and are wrong: they
   *  restart per passage, so voice A in one clip and voice A in another read as
   *  the same person when they are strangers - and they flatten a voice the
   *  reviewer HAS identified back to an anonymous label. The diarisation number
   *  is already unique within the record, so `Speaker 8` stays `Speaker 8`, and
   *  a named one keeps their name. What marks it as a clip is the block it sits
   *  in, not a rewritten label. */
  /** The quoted passage a turn OPENS, if any - so its source is shown once at
   *  the top of the passage rather than repeated on every turn inside it. A
   *  clip that cuts between two voices is one clip, and one source. */
  let externalOpensAt = $derived.by(() => {
    const m = new Map<number, (typeof parsed.externals)[number]>();
    for (const e of parsed.externals) {
      const first = runs.find((r) => r.startWord >= e.fromWord && r.endWord <= e.toWord);
      if (first) m.set(first.startWord, e);
    }
    return m;
  });

  let quotedRuns = $derived.by(() => {
    const s = new Set<number>();
    for (const e of parsed.externals) {
      for (const r of runs) {
        if (r.startWord >= e.fromWord && r.endWord <= e.toWord) s.add(r.startWord);
      }
    }
    return s;
  });

  /** A turn broken at every quoted boundary: prose, clip, prose. The clip
   *  becomes its own block with its own header, which is the only way the
   *  reviewer can see where it starts, where it ends, and what it is. */
  function turnSegments(turn: { parts: { run: SpeakerRun; cut: boolean }[] }) {
    type Seg =
      | { kind: "words"; key: string; gs: number[] }
      | { kind: "external"; key: string; gs: number[]; external: WordExternal }
      | { kind: "cut"; key: string; from: number; to: number };
    const out: Seg[] = [];
    for (const part of turn.parts) {
      if (part.cut) {
        out.push({ kind: "cut", key: `c${part.run.startWord}`, from: part.run.startWord, to: part.run.endWord });
        continue;
      }
      let run: { gs: number[]; ext: WordExternal | null } | null = null;
      const flush = () => {
        if (!run || run.gs.length === 0) return;
        out.push(
          run.ext
            ? { kind: "external", key: `e${run.ext.id}-${run.gs[0]}`, gs: run.gs, external: run.ext }
            : { kind: "words", key: `w${run.gs[0]}`, gs: run.gs },
        );
        run = null;
      };
      for (let g = part.run.startWord; g <= part.run.endWord; g++) {
        if (showObservedOnly && !observedVisible.has(g)) continue;
        const ext = parsed.externals.find((e) => g >= e.fromWord && g <= e.toWord) ?? null;
        if (!run || run.ext !== ext) {
          flush();
          run = { gs: [], ext };
        }
        run.gs.push(g);
      }
      flush();
    }
    return out;
  }

  /** The words a cut removed, by range - the segment form does not carry the
   *  run the old markup read it from. */
  function cutTextRange(from: number, to: number): string {
    const out: string[] = [];
    for (let g = from; g <= to; g++) out.push(words[g]?.text ?? "");
    return `Marked irrelevant - not sent for extraction:\n\n${out.join(" ").trim()}`;
  }

  /** The transcript as a flat list of blocks, where a quoted region is ONE
   *  block containing whatever it covers - including the speaker changes
   *  inside it.
   *
   *  Grouping per turn could never do this: a clip that runs from the middle of
   *  one turn, through a whole answer by someone else, into the start of a
   *  third is one quotation, and drawing it as three stacked blocks with three
   *  headers said it was three. The speakers inside it become labels within the
   *  block rather than turns of their own. */
  let renderBlocks = $derived.by(() => {
    type Item = { speaker: string | null; seg: ReturnType<typeof turnSegments>[number] };
    type Block =
      | { kind: "turn"; key: string; turn: (typeof turns)[number]; segs: ReturnType<typeof turnSegments> }
      | { kind: "external"; key: string; external: WordExternal; items: Item[] };
    const out: Block[] = [];
    let open: Extract<Block, { kind: "external" }> | null = null;

    for (const turn of turns) {
      const segs = turnSegments(turn);
      let ownSegs: typeof segs = [];
      const flushTurn = () => {
        if (ownSegs.length === 0) return;
        out.push({ kind: "turn", key: `t${turn.lead.startWord}-${ownSegs[0].key}`, turn, segs: ownSegs });
        ownSegs = [];
      };
      let lastSpeakerShown: string | null = null;
      for (const seg of segs) {
        if (seg.kind === "external") {
          flushTurn();
          if (!open || open.external.id !== seg.external.id) {
            open = { kind: "external", key: `x${seg.external.id}`, external: seg.external, items: [] };
            out.push(open);
            lastSpeakerShown = null;
          }
          // Name the voice only when it changes, so a clip that stays with one
          // person does not repeat their name every paragraph.
          const label: string | null =
            turn.lead.speaker !== lastSpeakerShown ? turn.lead.speaker : null;
          if (label) lastSpeakerShown = label;
          open.items.push({ speaker: label, seg });
          continue;
        }
        open = null;
        ownSegs.push(seg);
      }
      flushTurn();
    }
    return out;
  });

  let externalAtSelection = $derived.by(() => {
    const r = range;
    if (!r) return null;
    return parsed.externals.find((e) => e.fromWord <= r.to && e.toWord >= r.from) ?? null;
  });

  /** The link the current selection sits on, if any - what "open it", "change
   *  it" and "remove it" act upon. A link is authored from a selection, so it
   *  is edited from one too, rather than needing a second gesture to learn. */
  /** The turn a header dropdown was opened on, so "set as external content"
   *  reached from there marks that whole turn when no words are selected. */
  let currentRunRange = $derived.by(() => {
    if (headerPicker === null) return null;
    const run = runs.find((r) => r.startWord === headerPicker);
    return run ? { from: run.startWord, to: run.endWord } : null;
  });

  let linkAtSelection = $derived.by(() => {
    const r = range;
    if (!r) return null;
    return parsed.links.find((l) => l.fromWord <= r.to && l.toWord >= r.from) ?? null;
  });

  /** What each linked word points at, for its tooltip. Falls back to the hash
   *  when the target is not in the corpus listing - an unresolvable link is
   *  worth seeing as such rather than showing nothing. */
  let linkLabelByWord = $derived.by(() => {
    const m = new Map<number, string>();
    for (const l of parsed.links) {
      const hash = l.target.replace(/^sha256:/, "");
      const title = linkTitles?.get(hash) ?? linkTitles?.get(l.target);
      const label = title
        ? `Refers to: ${title}`
        : `Refers to another record (${hash.slice(0, 12)}) - not found in this corpus`;
      for (let g = l.fromWord; g <= l.toWord; g++) m.set(g, label);
    }
    return m;
  });

  /** The ids this highlight needs for context, and whether each still exists.
   *  A missing one is DANGLING: kept and shown unresolved, never dropped - the
   *  reviewer decides, because a silent removal loses their intent. */
  function contextOf(id: string): { id: string; missing: boolean }[] {
    return contextIndex.needs(id).map((n) => ({ id: n, missing: !highlightById.has(n) }));
  }

  /** Highlights that name THIS one as context - the other direction of the chain,
   *  so a reviewer can follow it both ways. */
  function contextDependents(id: string): string[] {
    return contextIndex.dependents(id);
  }


  /** The highlight under a word, for the click that completes the gesture. When
   *  several overlap, the innermost (last opened) is the one meant. */
  function highlightAtWord(g: number): string | null {
    const ids = highlightIdsByWord.get(g);
    return ids && ids.length ? ids[ids.length - 1] : null;
  }

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
  function applyWordHighlight(el: HTMLElement, cols: string[] | undefined, subtle = false) {
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
    const h = subtle ? SUBTLE_BAND_H : BAND_H;
    s.backgroundImage = cols.map((c) => `linear-gradient(${c}, ${c})`).join(",");
    s.backgroundRepeat = "no-repeat";
    s.backgroundSize = cols.map(() => `100% ${h}px`).join(",");
    // Band i (i=0 innermost) sits `(n-1-i)*PITCH`px up from the padding bottom,
    // so band 0 hugs the text and the rest step downward.
    s.backgroundPosition = cols
      .map((_, i) => `left 0 bottom ${(n - 1 - i) * BAND_PITCH}px`)
      .join(",");
    s.paddingBottom = `${(n - 1) * BAND_PITCH + h}px`;
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
  // A cut is no longer filtered OUT when hidden - it is drawn as a marker
  // instead of as words. Removing it from the list entirely is what left the
  // two halves of an interrupted turn looking like two separate turns, and it
  // also hid the fact that anything had been cut at all. The eye toggle now
  // chooses between the marker and the words behind it.
  let visibleRuns = $derived(
    runs.filter((r) => {
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
  /** Words that are not the reviewer's to observe: cut content, and anything
   *  inside a quoted passage.
   *
   *  A clip has no observation state - its turns carry no "mark seen" control,
   *  because seeing a clip is not reviewing this record's transcript. Leaving
   *  those words in the denominator meant coverage could never reach 100%, and
   *  "jump to unobserved" walked the reviewer into a clip it would then walk
   *  them into again, forever. */
  let irrelevantWords = $derived.by(() => {
    const s = new Set<number>();
    for (const run of runs) {
      if (run.speaker === SPEAKER_IRRELEVANT) {
        for (let g = run.startWord; g <= run.endWord; g++) s.add(g);
      }
    }
    for (const e of parsed.externals) {
      for (let g = e.fromWord; g <= e.toWord; g++) s.add(g);
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

  /** "Clear" alone made the reviewer open the menu to find out what it would
   *  take away. It says which. */
  let clearLabel = $derived(
    selectionHasHighlight && spanNotesInSelection.length > 0
      ? "Clear highlight and note"
      : selectionHasHighlight
        ? "Clear highlight"
        : "Clear note",
  );

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
  /** The markup menu, closed by default and by every gesture that ends the
   *  selection it acts on. */
  let markupOpen = $state(false);
  /** Whether the markup menu opens leftwards, because opening rightwards would
   *  take it past the edge of the window. */
  let menuFlipped = $state(false);
  // startWord of the run whose header picker is open (header click reassigns
  // the whole turn), or null.
  let headerPicker = $state<number | null>(null);
  // Word/selection editor (text + timing + add/delete) over the range. Labelled
  // One modal for a word or a run of them.

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
  // Where in the transcript you were, so an Ingest <-> Markup switch returns you
  // there instead of the top. Keyed per record (shared by both tabs) and anchored
  // on a WORD INDEX, because the two tabs render different word subsets and a
  // pixel offset would mean different places in each.
  let lastPersistedAnchor = -1;
  // Context-link authoring: the reviewer picks a highlight, then clicks an
  // EARLIER one to say "this needs that". Two clicks, no form - the gesture has
  // to be cheap or reviewers write big sloppy highlights instead of small chained
  // ones, which is the behaviour the feature exists to encourage.
  let contextFor = $state<string | null>(null);

  let anchorRestored = false;
  // Last currentTime the playback-follow acted on, to tell a forward tick (follow)
  // from a seek or pause (don't).
  let lastFollowTime = -1;

  /** The index of the topmost word currently visible - the thing worth
   *  remembering. Reads the DOM, so it lives in the component. */
  function topVisibleWord(): number | null {
    if (!scrollEl) return null;
    const top = scrollEl.getBoundingClientRect().top;
    let best: number | null = null;
    let bestDelta = Infinity;
    for (const el of scrollEl.querySelectorAll<HTMLElement>("[data-word-index]")) {
      const delta = el.getBoundingClientRect().top - top;
      if (delta >= -4 && delta < bestDelta) {
        bestDelta = delta;
        best = Number(el.dataset.wordIndex);
        if (delta >= 0 && delta < 40) break; // close enough to the top edge
      }
    }
    return best;
  }

  function persistScrollAnchor() {
    if (!recordHash) return;
    const w = topVisibleWord();
    if (w === null || !shouldPersistScroll(lastPersistedAnchor, w)) return;
    if (saveScrollAnchor(recordHash, w)) lastPersistedAnchor = w;
  }

  /** Jump to the saved word INSTANTLY - the whole point is to kill the ~10s
   *  smooth animation the karaoke follow would otherwise run from the top. Falls
   *  back to the nearest word this tab actually renders. */
  function restoreScrollAnchor() {
    if (anchorRestored || !recordHash || !scrollEl) return;
    const saved = loadScrollAnchor(recordHash);
    if (saved === null) {
      anchorRestored = true;
      return;
    }
    const rendered: number[] = [];
    for (const el of scrollEl.querySelectorAll<HTMLElement>("[data-word-index]")) {
      rendered.push(Number(el.dataset.wordIndex));
    }
    rendered.sort((a, b) => a - b);
    const target = resolveAnchorTarget(saved, rendered);
    if (target === null) return; // words not painted yet - try again next tick
    const el = scrollEl.querySelector<HTMLElement>(`[data-word-index="${target}"]`);
    if (!el) return;
    const view = scrollEl.getBoundingClientRect();
    const word = el.getBoundingClientRect();
    scrollEl.scrollTop = scrollEl.scrollTop + (word.top - view.top) - view.height * 0.3;
    lastPersistedAnchor = target;
    anchorRestored = true;
  }
  let barEl = $state<HTMLElement>();
  let barStyle = $state("");

  // Observation tracking: word gIndices that have been "seen" - auto-filled as
  // playback passes each word, or marked manually. Unobserved words render
  // faded; the set persists per record in localStorage. Always reassigned (not
  // mutated) so reactivity fires regardless of Set-proxy behaviour.
  let observed = $state(new Set<number>());
  let lastPlayTime = -1;

  // "Show only observed" filters the transcript to observed, relevant words -
  // INDEPENDENT of edit/markup mode, so switching mode never changes what is on
  // screen. `observedVisible` is the gIndex set (observed AND not irrelevant);
  // `renderRuns` are the turns with any such word (all turns when the filter is
  // off). The word loop hides the rest. `[irrelevant]` turns never show while
  // the filter is on, regardless of the eye toggle.
  let observedVisible = $derived.by(() => {
    const s = new Set<number>();
    if (!showObservedOnly) return s;
    for (let g = 0; g < words.length; g++) {
      // When per-word observation is unreliable (the spans drifted under the
      // reviewer's own transcript edits), showing nothing is the same lie as
      // greying everything: it tells a reviewer his finished record has no
      // reviewed content. Unknown is not unobserved - show it all and let him
      // work.
      if ((coverageUnreliable || observed.has(g)) && !irrelevantWords.has(g)) s.add(g);
    }
    return s;
  });
  let renderRuns = $derived.by(() => {
    if (!showObservedOnly) return visibleRuns;
    return runs.filter((r) => {
      if (r.speaker === SPEAKER_IRRELEVANT) return false;
      if (filteredSpeakers.size > 0 && !filteredSpeakers.has(r.speaker)) return false;
      for (let g = r.startWord; g <= r.endWord; g++) if (observedVisible.has(g)) return true;
      return false;
    });
  });

  /** Whether each rendered run draws a header and a divider, and whether it is
   *  a cut folded into the turn around it. See runDisplays. */
  // Cuts only fold into the surrounding turn while they are drawn as markers.
  // Showing the words puts them back in the flow, where they need their own
  // block to be readable as removed content.
  let turns = $derived(
    hideIrrelevant
      ? foldTurns(renderRuns, SPEAKER_IRRELEVANT)
      : renderRuns.map((r) => ({ speaker: r.speaker, lead: r, parts: [{ run: r, cut: false }] })),
  );

  /** The words a cut removed, for the marker's tooltip - the reviewer checking
   *  their own cut needs to see what is behind it without undoing it. No count
   *  is shown: the common cut is a two-word correction, and saying "2 words
   *  cut" in the prose is louder than the words it replaced. */
  function cutText(run: SpeakerRun): string {
    const out: string[] = [];
    for (let g = run.startWord; g <= run.endWord; g++) out.push(words[g]?.text ?? "");
    return `Marked irrelevant - not sent for extraction:\n\n${out.join(" ").trim()}`;
  }
  let observedEmpty = $derived(showObservedOnly && observedVisible.size === 0);
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
      // Only follow ACTUAL PLAYBACK - currentTime ticking forward in small steps.
      // A big jump is a seek (the playhead restore lands the audio at the resume
      // point, which would otherwise yank the transcript away from the scroll
      // position the reviewer switched tabs to keep); a static time is paused.
      // Following either would fight the reviewer's own place.
      const t = currentTime;
      const delta = t - lastFollowTime;
      lastFollowTime = t;
      if (!(delta > 0 && delta < 1.5)) return;
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

  // Live coverage below the stored cumulative value = the word-index spans have
  // drifted (the body grew under this reviewer's own transcript corrections), so
  // per-word observation cannot be trusted. Observation never decreases, so a
  // lower live number can only mean a shifted basis.
  let coverageUnreliable = $derived(
    storedCoverage != null && coverageVerdict.observed_coverage < storedCoverage - 0.005,
  );

  function observedInRun(run: SpeakerRun): number {
    // When per-word observation is unreliable (spans drifted under body edits),
    // report the run as fully covered rather than 0/N - a bogus "0 observed" on a
    // reviewed turn is the same lie as the 0% header. Unknown, not unobserved.
    if (coverageUnreliable) return run.endWord - run.startWord + 1;
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
  /** Ctrl/Cmd-Enter saves whatever note is being written.
   *
   *  A plain Enter has to stay a newline - a note about what is on screen often
   *  runs to two lines - and Escape reads as "throw this away" even where it
   *  saves. So the deliberate save gets the shortcut every editor uses for it,
   *  and the reviewer never has to reach for the mouse to keep two words. */
  function isSaveKey(e: KeyboardEvent): boolean {
    return e.key === "Enter" && (e.ctrlKey || e.metaKey);
  }

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
    // Note authoring is Markup's job. Leaving the shortcut live in Ingest would
    // reintroduce, invisibly, exactly the affordance just removed from its
    // toolbar - a hidden key that still writes notes from the reading view.
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
    c.toggle("wt-observed", coverageUnreliable || observed.has(g));
    // Reviewer-highlight underline bands: sparse, so paint straight onto the
    // word rather than carry a class per possible band count.
    const cols = highlightColorsByWord.get(g);
    // Ingest collapses any number of overlapping highlights to ONE faint band:
    // the signal there is "this is highlighted", not which one it is.
    const subtle = false;
    applyWordHighlight(el, subtle && cols?.length ? [SUBTLE_HL] : cols, subtle);
    c.toggle("wt-highlight", cols !== undefined);
    c.toggle("wt-spannote", spanNoteWordSet.has(g));
    c.toggle("wt-markup-focus", focusWordSet.has(g));
    c.toggle("wt-chain", hoverChainWords.has(g));
    c.toggle("wt-linkspan", linkWordSet.has(g));
    c.toggle("wt-external", externalWordSet.has(g));
    // Native tooltip rather than a hover card: it costs no layout, survives
    // the content-visibility skipping, and is what a reader tries first.
    const linkLabel = linkLabelByWord.get(g);
    const extLabel = externalWordSet.get(g);
    const label = [extLabel, linkLabel].filter(Boolean).join("\n");
    if (label) el.title = label;
    else if (el.title) el.removeAttribute("title");
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
    // Any press in the transcript drops the side-list's focus emphasis - that
    // emphasis is a "here it is" pointer, not a selection to be dismissed, so
    // it must not outlive the next thing the reviewer does. Fires before the
    // word check so pressing the gaps between words clears it too.
    if (focusWords) onclearfocus?.();
    const el = (e.target as HTMLElement | null)?.closest?.("[data-word-index]") as HTMLElement | null;
    if (!el) return;
    onWordPointerDown(e, Number(el.dataset.wordIndex));
  }

  function onContainerPointerOver(e: PointerEvent) {
    const el = (e.target as HTMLElement | null)?.closest?.("[data-word-index]") as HTMLElement | null;
    if (!dragging) {
      // Not dragging: this is a plain hover. Track the chain-hover emphasis.
      {
        const id = el ? highlightAtWord(Number(el.dataset.wordIndex)) : null;
        hoverChainId = id && contextIndex.isChained(id) ? id : null;
      }
      return;
    }
    // A pointerover does NOT mean the reviewer moved. Clicking a word seeks the
    // audio, which scrolls the transcript, which slides a different word under a
    // perfectly still cursor - and the browser reports that as entering a new
    // word. Extending on it turned single clicks into selections spanning
    // everything back to wherever the scroll landed.
    //
    // The pointer's own coordinates tell the two apart: a real drag changes them,
    // content moving underneath does not.
    if (!pointerMovedSincePress(e)) return;
    if (!el) return;
    onWordPointerEnter(Number(el.dataset.wordIndex));
  }

  /** Where the pointer went down, so a later pointerover can be judged as a real
   *  drag or as the page having moved under a stationary cursor. */
  let pressOrigin: { x: number; y: number } | null = null;

  /** The word a markup-mode press wants to play. Held until pointerup: a bare
   *  click plays it then, but a real drag cancels it and pauses instead -
   *  dragging is annotation, and playback jumping to the drag's first word
   *  fought the gesture. Only ever set in markup mode. */
  let pendingSeek: number | null = null;

  // Hovering a chained highlight lights its whole chain - itself plus every
  // highlight it needs or is needed by - so the connection is visible without
  // clicking anything. Markup-only: Ingest keeps highlights deliberately subtle.
  // `hoverChainId` changes only when the hover crosses a highlight boundary, so
  // sweeping the cursor across plain words costs one Map lookup per word.
  let hoverChainId = $state<string | null>(null);
  let hoverChainWords = $derived.by(() => {
    const s = new Set<number>();
    if (!hoverChainId) return s;
    const ids = [
      hoverChainId,
      ...contextIndex.needs(hoverChainId),
      ...contextIndex.dependents(hoverChainId),
    ];
    for (const id of ids) {
      const h = highlightById.get(id);
      if (!h) continue; // dangling reference: nothing on screen to light
      for (let g = h.fromWord; g <= h.toWord; g++) s.add(g);
    }
    return s;
  });

  function pointerMovedSincePress(e: PointerEvent): boolean {
    return pointerMoved(pressOrigin, { x: e.clientX, y: e.clientY });
  }

  // Double-click a word to jump straight into the editor on that single word.
  function onContainerDblClick(e: MouseEvent) {
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
  let appliedChain = new Set<number>();

  // Full restyle when the rendered word set changes (load/filter/edit) or after
  // an observed change with no DOM delta (epoch bump). Deliberately tracks only
  // those signals - NOT range/active/etc - so a selection never triggers it.
  $effect(() => {
    void renderRuns;
    void observedVisible; // the observed-only filter hides words; restyle when that set moves
    void styleEpoch;
    void highlightColorsByWord; // re-apply bands when a highlight is added/cleared
    void spanNoteWordSet; // re-apply tint when a span note is added/cleared/re-ranged
    void focusWordSet; // re-apply markup focus flash
    void linkWordSet; // re-apply the link underline when a link is added/removed
    void linkLabelByWord; // and its tooltip when the titles arrive
    void externalWordSet; // and the tint when a passage is marked as quoted
    const el = scrollEl;
    untrack(() => {
      if (!el) return;
      rebuildWordEls();
      reapplyAll();
      appliedRange = range ? { from: range.from, to: range.to } : null;
      appliedActive = activeWord;
      appliedResume = resumeWord;
      appliedClaim = new Set(claimWords);
      appliedChain = new Set(hoverChainWords);
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

  $effect(() => {
    const hw = hoverChainWords;
    untrack(() => {
      for (const g of appliedChain) if (!hw.has(g)) applyWord(g);
      for (const g of hw) if (!appliedChain.has(g)) applyWord(g);
      appliedChain = new Set(hw);
    });
  });

  /** Whether the selection sits inside a single speaker turn. Reassign and
   *  split are per-turn operations; across a boundary they have no meaning, so
   *  they withdraw rather than the selection being prevented. */
  let selectionInOneRun = $derived(
    range !== null && runOfWord.get(range.from)?.startWord === runOfWord.get(range.to)?.startWord,
  );

  function clampToRun(a: number, b: number): { from: number; to: number } | null {
    // A SELECTION IS NEVER CLAMPED. It used to stop at the speaker boundary
    // outside markup mode, because reassign and split are per-turn operations
    // and a selection spanning two turns has no meaning for them. But that made
    // the boundary a wall for every OTHER purpose too - a quote crossing a
    // question and its answer could not be highlighted or noted without
    // switching modes, and the sentence a reviewer wants to mark is very often
    // exactly the one that crosses.
    //
    // So the selection is free and the ACTIONS gate instead: per-turn
    // operations offer themselves only while the selection sits in one turn,
    // which is a statement about those operations rather than a restriction on
    // reading.
    if (words.length === 0) return null;
    const lo = Math.max(0, Math.min(a, b));
    const hi = Math.min(words.length - 1, Math.max(a, b));
    return { from: lo, to: hi };
  }

  function selectWord(g: number, extend: boolean) {
    headerPicker = null;
    // Second half of the context gesture: while picking, a click on a word inside
    // an EARLIER highlight completes the link instead of moving the selection.
    if (contextFor !== null) {
      const target = highlightAtWord(g);
      if (target && target !== contextFor) {
        onhighlightcontext?.(contextFor, target);
        contextFor = null;
        return;
      }
      // A click on empty text cancels rather than silently doing nothing, so the
      // reviewer is never left in a mode they can't see.
      if (!target) {
        contextFor = null;
        return;
      }
    }
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
    hoverChainId = null;
    if (e.shiftKey) {
      selectWord(g, true);
      return;
    }
    // Ctrl/Alt/Cmd+click (or drag) selects without moving playback, so you can
    // grab words to copy or edit while the audio keeps its place. A plain click
    // still seeks there.
    const selectOnly = e.ctrlKey || e.altKey || e.metaKey;
    // A click while picking context is CONSUMED by the gesture (it completes or
    // cancels the link) - it must not also move playback. The reviewer is
    // pointing at the earlier highlight, not asking to hear it.
    const pickingContext = contextFor !== null;
    selectWord(g, false);
    dragging = true;
    pressedAt = performance.now();
    pressOrigin = { x: e.clientX, y: e.clientY };
    if (!selectOnly && !pickingContext && onseek && words[g]) {
      // Playback is deferred to pointerup so a drag can cancel it: a bare click
      // plays the word, a drag is a selection and pauses instead. This was
      // markup's behaviour; with one view it is everyone's, and it is the
      // better one - an immediate seek starts audio under a gesture that turns
      // out to be a selection.
      pendingSeek = words[g].start;
      // The PRESS stops playback, not just a drag across words. Holding on a
      // word is how you steady yourself before selecting, and audio running on
      // under a held finger is the same fight a drag has. Releasing without
      // moving still fires the pending seek, so a plain click plays as before.
      if (!pausedForDrag) {
        pausedForDrag = true;
        onpause?.();
      }
    }
  }

  function onWordPointerEnter(g: number) {
    if (dragging && anchor !== null) {
      // The press has become a DRAG - the reviewer is selecting a range, and
      // audio running on under the gesture fights it. True in either mode: in
      // markup the pending click-to-play is simply cancelled, while in edit the
      // press has already seeked and started playing, so it has to be stopped.
      // Only the first crossing pauses; after that the drag is silent anyway.
      if (g !== anchor) {
        // Cancel any click-to-play the press armed, AND stop playback that the
        // press already started. Markup arms a pending seek; edit seeks
        // immediately - either way the drag means "I am selecting", so nothing
        // should be playing under it. Once per gesture.
        pendingSeek = null;
        if (!pausedForDrag) {
          pausedForDrag = true;
          onpause?.();
        }
      }
      range = clampToRun(anchor, g);
    }
  }

  /** Whether this drag has already stopped playback, so crossing further words
   *  does not keep firing a pause. Reset when the gesture ends. */
  let pausedForDrag = false;

  /** When the current press started, so a HOLD can be told from a click.
   *
   *  Both pause on the way down. A click then releases into the pending seek
   *  and plays from that word, which is what a click is for. A hold means the
   *  reviewer wanted the audio to stop - they are reading, or about to select,
   *  or looking at something - and playing on release would undo the one thing
   *  they asked for. Same outcome as a drag, without having to move. */
  let pressedAt = 0;
  const HOLD_MS = 350;

  function stopDrag() {
    const held = pressedAt > 0 && performance.now() - pressedAt >= HOLD_MS;
    pausedForDrag = false;
    pressedAt = 0;
    if (pendingSeek !== null) {
      // A hold has already paused; releasing it must not start playing again.
      if (!held) onseek?.(pendingSeek);
      pendingSeek = null;
    }
    dragging = false;
    pressOrigin = null;
  }

  function clearSelection() {
    markupOpen = false;
    anchor = null;
    range = null;
    pickerOpen = false;
    editingSelection = false;
  }

  function chooseSpeaker(name: string) {
    if (range) onreassign(range.from, range.to, name);
    clearSelection();
  }

  // The header shows the durable stored coverage when the live recompute is
  // untrustworthy - unknown is not unobserved, and telling a reviewer his
  // finished record is 0% observed is the exact failure this guards.
  let observedPct = $derived(
    coverageUnreliable && storedCoverage != null
      ? observedPercent(storedCoverage)
      : observedPercent(coverageVerdict.observed_coverage),
  );

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
  {@const special = assignableSpecialSpeakers(currentSpeaker ?? undefined)}
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
    {#if onexternal}
      <!-- Reached from here because this is where the reviewer already is when
           they notice a turn is a clip: they opened this menu to ask "who is
           this". It marks the PASSAGE, so whoever is in the clip keeps their
           name - which is what the old [external footage] speaker threw away. -->
      <div class="border-t border-border mt-1 pt-1">
        <button
          onclick={() => {
            const r = range ?? currentRunRange;
            headerPicker = null;
            pickerOpen = false;
            if (r) onexternal?.(r.from, r.to);
          }}
          class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface"
        >
          Set as external content
        </button>
      </div>
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
          onkeydown={(e) => {
            blockBrackets(e);
            if (isSaveKey(e)) { e.preventDefault(); saveSpanNoteEdit(id); return; }
            if (e.key === "Escape") { e.preventDefault(); saveSpanNoteEdit(id); }
          }}
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
          if (isSaveKey(e)) { e.preventDefault(); commitSpanNote(); return; }
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
        <!-- Annotation actions, offered wherever the words are shown: marking a
             passage is not a separate activity from reading or correcting it,
             and making it a mode meant deciding which one you were in before
             you knew what you had found. -->
        <div class="relative">
          <button
            onclick={(e) => {
              e.stopPropagation();
              if (!selectionInOneRun) return;
              pickerOpen = !pickerOpen;
            }}
            disabled={!selectionInOneRun}
            aria-label="Assign speaker"
            class="flex items-center gap-0.5 p-1 rounded transition-colors
              {selectionInOneRun
                ? 'text-primary cursor-pointer hover:bg-primary/10'
                : 'text-on-surface-muted/40 cursor-default'}"
            title={selectionInOneRun
              ? "Assign these words to a speaker"
              : "This selection crosses a speaker change. Reassigning is a per-turn operation - select within one turn to use it."}
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.75" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round"
                d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
            <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {#if pickerOpen}
            {@render speakerMenu(selectedSpeaker, chooseSpeaker)}
          {/if}
        </div>
        <div class="w-px h-4 bg-border" aria-hidden="true"></div>
        <button
          onclick={() => { pickerOpen = false; editingSelection = true; }}
          aria-label="Edit"
          class="text-primary cursor-pointer p-1 rounded hover:bg-primary/10 transition-colors"
          title={single
            ? "Edit this word: text, timing, split or delete"
            : "Edit the selected words together: text, timing, add/delete words"}
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.75" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round"
              d="M16.86 3.99a1.88 1.88 0 012.66 2.65L7.6 18.56l-3.54.89.89-3.54L16.86 3.99z" />
          </svg>
        </button>
        <div class="w-px h-4 bg-border" aria-hidden="true"></div>
        <button
          onclick={cycleCase}
          class="text-xs font-ui font-medium text-primary cursor-pointer hover:underline tabular-nums min-w-7 text-center"
          title="Cycle case: lowercase -> Capitalised -> UPPERCASE"
        >
          {caseLabel}
        </button>
        <div class="relative">
          <!-- Markup lives behind one button rather than four in a row.
               Highlight, note, link and external footage are each used less
               often than assigning a speaker or fixing a word, and four more
               icons made the common jobs harder to find than the rare ones. -->
          <button
            onclick={(e) => {
              e.stopPropagation();
              // Flip the menu to the right edge when opening it at the far side
              // of the pane would push it off screen - a menu the reviewer has
              // to scroll sideways to read is one they cannot use.
              const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
              menuFlipped = box.left + 220 > window.innerWidth;
              markupOpen = !markupOpen;
            }}
            aria-label="Markup"
            aria-expanded={markupOpen}
            class="flex items-center gap-0.5 p-1 rounded transition-colors cursor-pointer
              {markupOpen || selectionHasMarkup || linkAtSelection
                ? 'text-primary bg-primary/10'
                : 'text-primary hover:bg-primary/10'}"
            title="Highlight, add note, link to a source, set as external content"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.75" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M14.5 3.5l6 6-7.5 7.5H7.5l-1.5-4 8.5-9.5z" />
              <path stroke-linecap="round" stroke-width="3.5" d="M5.5 21h13" />
            </svg>
            <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {#if markupOpen}
            <div
              class="absolute {menuFlipped ? 'right-0' : 'left-0'} top-full mt-1 z-40 min-w-44 rounded border border-border
                bg-surface-raised shadow-xl py-1 flex flex-col items-stretch"
            >
          <button
            onclick={() => { if (range) { onhighlight?.(range.from, range.to); clearSelection(); } }}
            aria-label="Highlight"
            class="flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs font-ui cursor-pointer transition-colors hover:bg-primary-container/30 text-on-surface"
            title="Highlight these words (highlights may overlap)"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.75" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round"
                d="M14.5 3.5l6 6-7.5 7.5H7.5l-1.5-4 8.5-9.5z" />
              <path stroke-linecap="round" stroke-width="3.5" d="M5.5 21h13" />
            </svg>
              <span>Highlight</span>
          </button>
          {#if range && highlightAtWord(range.from)}
            {@const hit = highlightAtWord(range.from)}
            <button
              onclick={() => { contextFor = hit; clearSelection(); }}
              class="flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs font-ui cursor-pointer transition-colors hover:bg-primary-container/30 text-on-surface"
              title="This highlight needs an earlier one to make sense (e.g. it says 'he' - link the highlight that names him). Click it next."
            >
              Needs context
            </button>
          {/if}
          <button
            onclick={startSpanNote}
            aria-label="Note"
            class="flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs font-ui cursor-pointer transition-colors hover:bg-primary-container/30 text-on-surface"
            title="Attach a note over these words - what's on screen, context the words miss"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.75" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round"
                d="M4 5.5A1.5 1.5 0 015.5 4h13A1.5 1.5 0 0120 5.5v9a1.5 1.5 0 01-1.5 1.5H9l-5 4V5.5zM8 8h8M8 11.5h5" />
            </svg>
              <span>Add note</span>
          </button>
          {#if linkAtSelection}
            <!-- These words are ALREADY linked, so the bar stops offering to
                 link them and offers what can be done with the link instead:
                 follow it, point it somewhere else, or take it off. Editing from
                 the same selection that authored it means there is no second
                 gesture to learn. -->
                        <button
              onclick={() => onlinkopen?.(linkAtSelection.target)}
              aria-label="Open the linked record"
              class="flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs font-ui cursor-pointer transition-colors hover:bg-primary-container/30 text-on-surface"
              title={linkLabelByWord.get(linkAtSelection.fromWord) ?? "Open the linked record"}
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.75" viewBox="0 0 24 24" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round"
                  d="M14 4h6v6M20 4l-8.5 8.5M18 14v5.5A1.5 1.5 0 0116.5 21h-11A1.5 1.5 0 014 19.5v-11A1.5 1.5 0 015.5 7H11" />
              </svg>
              <span>Open the linked record</span>
            </button>
            <button
              onclick={() => { if (range) { onlinksource?.(range.from, range.to); clearSelection(); } }}
              aria-label="Change the linked record"
              class="flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs font-ui cursor-pointer transition-colors hover:bg-primary-container/30 text-on-surface"
              title="Point these words at a different record"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.75" viewBox="0 0 24 24" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round"
                  d="M16.86 3.99a1.88 1.88 0 012.66 2.65L7.6 18.56l-3.54.89.89-3.54L16.86 3.99z" />
              </svg>
              <span>Point at a different record</span>
            </button>
            <button
              onclick={() => { onlinkremove?.(linkAtSelection.id); clearSelection(); }}
              aria-label="Remove the link"
              class="flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs font-ui cursor-pointer transition-colors hover:bg-primary-container/30 text-on-surface-muted hover:text-error"
              title="Remove this link - the words stay, the reference goes"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.75" viewBox="0 0 24 24" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round"
                  d="M10.5 13.5a4 4 0 005.66 0l2-2M13.5 10.5a4 4 0 00-5.66 0l-2 2M4 4l16 16" />
              </svg>
              <span>Remove the link</span>
            </button>
          {:else if onlinksource}
            <!-- A source reference IS a note - a note whose body is another
                 record rather than typed text - so it sits with Note rather than
                 as a separate verb in the bar. -->
                        <button
              onclick={() => { if (range) { onlinksource?.(range.from, range.to); clearSelection(); } }}
              aria-label="Link external source"
              class="flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs font-ui cursor-pointer transition-colors hover:bg-primary-container/30 text-on-surface"
              title="The speaker is talking ABOUT another record - their own words, mentioning it"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.75" viewBox="0 0 24 24" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round"
                  d="M10.5 13.5a4 4 0 005.66 0l3-3a4 4 0 10-5.66-5.66l-1 1M13.5 10.5a4 4 0 00-5.66 0l-3 3a4 4 0 105.66 5.66l1-1" />
              </svg>
              <span>Link to a source</span>
            </button>
          {/if}
          {#if externalAtSelection}
            <button
              onclick={() => { onexternalremove?.(externalAtSelection.id); clearSelection(); }}
              aria-label="Remove external mark"
              class="flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs font-ui cursor-pointer transition-colors hover:bg-primary-container/30 text-on-surface-muted hover:text-error"
              title="These words are this recording's own after all - remove the external mark"
            >
              <svg class="w-4 h-4 flex-none" fill="none" stroke="currentColor" stroke-width="1.75" viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3" y="5" width="18" height="13" rx="2" />
                <path stroke-linecap="round" d="M4 4l16 16" />
              </svg>
              <span>Not external after all</span>
            </button>
          {:else if onexternal}
            <!-- The speaker is NOT changed by this. The person in a clip is
                 still the person who said it; what is external is the
                 passage. Naming them "X (External Footage)" is what gave the
                 corpus four spellings of one man. -->
            <button
              onclick={() => { if (range) onexternal?.(range.from, range.to); }}
              aria-label="Mark as external"
              class="flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs font-ui cursor-pointer transition-colors hover:bg-primary-container/30 text-on-surface"
              title="These words are not the speaker's - a clip played here, or a passage read out from somewhere else"
            >
              <svg class="w-4 h-4 flex-none" fill="none" stroke="currentColor" stroke-width="1.75" viewBox="0 0 24 24" aria-hidden="true">
                <rect x="2" y="6" width="14" height="10" rx="2" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M22 8l-6 4 6 4V8z" />
              </svg>
              <span>Set as external content</span>
            </button>
          {/if}
          {#if selectionHasMarkup}
            <button
              onclick={clearMarkupUnderSelection}
              class="flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs font-ui cursor-pointer transition-colors hover:bg-primary-container/30 text-on-surface-muted"
              title="Remove the highlight(s)/note(s) over these words"
            >
              {clearLabel}
            </button>
          {/if}
            </div>
          {/if}
        </div>
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

<!-- Top toolbar: playback clock and selection state on the left, coverage on the
     right. Shown in BOTH modes.

     COVERAGE IS NEVER HIDDEN. It used to be the {:else} of "is anything
     selected", and the whole bar was dropped in markup - so the number vanished
     for the entire act of marking up, which is exactly when it is being watched:
     the reviewer steers by it, submitting at around 75-80%. Selection state
     therefore sits on the LEFT and coverage stays anchored right, so the figure
     never moves or disappears as a selection comes and goes. -->
<div class="flex-none flex items-center gap-2 px-4 py-1.5 border-b border-border bg-surface-alt">

  <span class="text-xs font-ui text-on-surface-muted tabular-nums">Playing {secondsToClock(currentTime)}</span>
  {#if range}
    {@const selN = range.to - range.from + 1}
    <span class="text-xs font-ui text-on-surface-muted tabular-nums">{selN} selected</span>
    <!-- Observation is an Ingest job; markup is annotation-only. -->
    {#if true}
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
    {/if}
  {/if}
  <span
    class="ml-auto text-xs font-ui font-medium tabular-nums {observedPct >= 100 ? 'text-success' : 'text-on-surface-secondary'}"
    title={coverageUnreliable
      ? "Your saved coverage. Per-word observation can't be shown for this record - its transcript was edited since review, shifting the word positions - so nothing here is greyed as unobserved."
      : "Share of this record's words you've observed"}
  >
    {observedPct}% observed{#if coverageUnreliable}<span class="text-on-surface-muted font-normal"> (saved)</span>{/if}
  </span>
  {#if observedPct < 100 && !coverageUnreliable && !range}
    <button
      onclick={jumpToFirstUnobserved}
      class="text-xs font-ui font-medium text-primary cursor-pointer hover:underline"
      title="Scroll to the first word you haven't observed yet"
    >
      Jump to unobserved
    </button>
  {/if}
  {#if onobservedonlychange}
    <label
      class="flex items-center gap-1 text-xs font-ui text-on-surface-secondary cursor-pointer select-none"
      title="Hide everything you haven't observed - focuses the view on reviewed content. Independent of the mode."
    >
      <input
        type="checkbox"
        checked={showObservedOnly}
        onchange={(e) => onobservedonlychange?.(e.currentTarget.checked)}
        class="cursor-pointer"
      />
      Observed only
    </label>
  {/if}
  <span class="text-xs font-ui text-on-surface-muted/60">{notes.length} note{notes.length === 1 ? "" : "s"}</span>
</div>

{#if contextFor !== null}
  <div class="flex-none flex items-center gap-2 px-4 py-1.5 bg-primary/10 border-b border-primary/30">
    <span class="text-xs font-ui text-on-surface">
      Click the earlier highlight that <strong>{contextFor}</strong> needs for context.
    </span>
    <button
      onclick={() => (contextFor = null)}
      class="ml-auto text-xs font-ui text-on-surface-muted hover:text-on-surface cursor-pointer"
    >Cancel</button>
  </div>
{/if}

{#if range && highlightAtWord(range.from)}
  {@const hit = highlightAtWord(range.from)!}
  {@const needs = contextOf(hit)}
  {@const dependents = contextDependents(hit)}
  {#if needs.length || dependents.length}
    <!-- The chain, both directions, so it can be followed either way in one hop. -->
    <div class="flex-none flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5 bg-surface-alt border-b border-border">
      {#if needs.length}
        <span class="text-[11px] font-ui text-on-surface-secondary">Needs:</span>
        {#each needs as n (n.id)}
          <button
            onclick={() => { if (!n.missing) { const t = highlightById.get(n.id); if (t) selectWord(t.fromWord, false); } }}
            class="text-[11px] font-ui rounded px-1.5 py-0.5 cursor-pointer transition-colors
              {n.missing
                ? 'bg-error/15 text-error line-through'
                : 'bg-primary/15 text-primary hover:bg-primary/25'}"
            title={n.missing
              ? "That highlight was deleted. The link is kept, not silently dropped - remove it or re-highlight the passage."
              : "Jump to the highlight this one depends on"}
          >{n.id}{#if n.missing} (missing){/if}</button>
          <button
            onclick={() => onhighlightcontextremove?.(hit, n.id)}
            class="text-[11px] font-ui text-on-surface-muted hover:text-error cursor-pointer -ml-2"
            title="Remove this context link"
            aria-label="Remove context link"
          >&#x2715;</button>
        {/each}
      {/if}
      {#if dependents.length}
        <span class="text-[11px] font-ui text-on-surface-secondary">Needed by:</span>
        {#each dependents as d (d)}
          <button
            onclick={() => { const t = highlightById.get(d); if (t) selectWord(t.fromWord, false); }}
            class="text-[11px] font-ui rounded px-1.5 py-0.5 bg-surface text-on-surface-secondary hover:bg-surface-alt cursor-pointer"
            title="Jump to the later highlight that depends on this one"
          >{d}</button>
        {/each}
      {/if}
    </div>
  {/if}
{/if}

<div
  bind:this={scrollEl}
  onscroll={() => {
    if (range) schedulePositionBar();
    if (anchorRestored) persistScrollAnchor();
  }}
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
    onpointerleave={() => (hoverChainId = null)}
    ondblclick={onContainerDblClick}
  >
    {#if observedEmpty}
      <p class="px-6 py-8 text-sm text-on-surface-muted max-w-prose">
        "Show only observed" is on, but nothing here is observed yet - so there is
        nothing to show. Turn the filter off to see the whole transcript, or
        observe some of it first.
      </p>
    {/if}
    {#each renderBlocks as block (block.key)}
      {#if block.kind === "external"}
        <!-- ONE quotation: one rule, one header, one strip - with the voices
             inside it as labels rather than as turns of their own, because a
             clip that cuts between two people is still one clip. -->
        <div class="wt-quoted-turn border-b border-border/50 px-4 py-2">
          <div class="group/ext flex items-center gap-2 pb-1 text-[11px] font-ui">
            <span class="text-on-surface-muted/50 uppercase tracking-wide flex-none">External</span>
            {#if block.external.description}
              <span class="text-on-surface-muted/80 truncate">{block.external.description}</span>
            {:else if block.external.target}
              <span class="text-on-surface-muted/80 truncate">a record in this corpus</span>
            {:else}
              <span class="text-warning/70 italic truncate">no source noted</span>
            {/if}
            <span class="flex-1"></span>
            <button
              onclick={() => onexternaledit?.(block.external.id)}
              class="flex-none px-1 rounded cursor-pointer text-on-surface-muted/60 hover:text-primary opacity-0 group-hover/ext:opacity-100 transition-opacity"
              title="Change where this came from">edit</button>
            <button
              onclick={() => onexternalremove?.(block.external.id)}
              class="flex-none px-1 rounded cursor-pointer text-on-surface-muted/60 hover:text-error opacity-0 group-hover/ext:opacity-100 transition-opacity"
              title="These words are this recording's own after all">remove</button>
          </div>
          {#each block.items as item, i (i)}
            {#if item.speaker}
              <div class="flex items-center gap-2 pt-1 text-xs font-ui text-on-surface-muted/70">
                <span class="flex-none w-2.5 h-2.5 rounded-full border border-current opacity-40" aria-hidden="true"></span>
                {item.speaker}
              </div>
            {/if}
            {#if item.seg.kind === "external"}
              <p class="pl-4 text-sm leading-[1.75]">{@render wordSpans(item.seg.gs)}</p>
            {/if}
          {/each}
        </div>
      {:else}
        {@const turn = block.turn}
      {@const run = turn.lead}
      {@const quotedLabel = quotedRuns.has(run.startWord)}
      {@const opensExternal = externalOpensAt.get(run.startWord)}
      {@const spoken = turn.parts.filter((p) => !p.cut)}
      {@const obs = spoken.reduce((n, p) => n + observedInRun(p.run), 0)}
      {@const total = spoken.reduce((n, p) => n + p.run.endWord - p.run.startWord + 1, 0)}
      <!-- content-visibility:auto lets the browser skip layout/paint for runs
           off-screen while keeping their words in the DOM (so jump-to-word,
           claim links and karaoke centring still find them). It clips overflow,
           which would cut off this run's speaker dropdown, so the run with an
           open header picker switches to visible. -->
      <div
        class="border-b border-border/50 px-4 pt-3 pb-2 {quotedLabel
          ? 'wt-quoted-turn'
          : ''}"
        style="content-visibility:{headerPicker === run.startWord
          ? 'visible'
          : 'auto'};contain-intrinsic-size:auto {runIntrinsic(run)}px"
      >
        {#if opensExternal && !quotedRuns.has(run.startWord)}
          <!-- The passage's own header: what this clip is, said once at the
               top of it. It belongs to the passage, not to the speakers inside
               it - a clip cutting between two voices is still one clip from
               one place. -->
          <div class="group/ext flex items-center gap-2 pb-1.5 -mt-1 text-[11px] font-ui">
            <span class="text-on-surface-muted/50 uppercase tracking-wide flex-none">External</span>
            {#if opensExternal.description}
              <span class="text-on-surface-muted/80 truncate">{opensExternal.description}</span>
            {:else if opensExternal.target}
              <span class="text-on-surface-muted/80 truncate">a record in this corpus</span>
            {:else}
              <span class="text-warning/70 italic truncate">no source noted</span>
            {/if}
            <span class="flex-1"></span>
            <button
              onclick={() => onexternaledit?.(opensExternal.id)}
              class="flex-none px-1 rounded cursor-pointer text-on-surface-muted/60 hover:text-primary opacity-0 group-hover/ext:opacity-100 transition-opacity"
              title="Change where this came from"
            >edit</button>
            <button
              onclick={() => onexternalremove?.(opensExternal.id)}
              class="flex-none px-1 rounded cursor-pointer text-on-surface-muted/60 hover:text-error opacity-0 group-hover/ext:opacity-100 transition-opacity"
              title="These words are this recording's own after all"
            >remove</button>
          </div>
        {/if}
        <div class="flex items-center justify-between gap-2 pb-1">
          {#if quotedLabel}
            <!-- Still a picker: a reviewer who knows whose clip this is should
                 be able to say so. Muted, and tagged, because the fact worth
                 seeing first is that it is quoted. -->
            <div class="relative inline-block">
              <button
                onclick={(e) => { e.stopPropagation(); toggleHeaderPicker(run); }}
                class="group flex items-center gap-2 cursor-pointer rounded px-1 -mx-1 hover:bg-primary-container/20 transition-colors"
                title="Whose voice is this in the clip?"
              >
                <!-- No icon: the block's own header two lines up already says
                     EXTERNAL, and a camera here repeats it in a second
                     vocabulary. A hollow dot keeps the row aligned with every
                     other speaker row. -->
                <span
                  class="flex-none w-2.5 h-2.5 rounded-full border border-current opacity-40"
                  aria-hidden="true"
                ></span>
                <span class="text-xs font-ui text-on-surface-muted/80 group-hover:underline">
                  {run.speaker}
                </span>
              </button>
              {#if headerPicker === run.startWord}
                {@render speakerMenu(run.speaker, (name) => chooseRunSpeaker(run, name))}
              {/if}
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
        <!-- A turn is drawn as SEGMENTS, not as one paragraph, because a clip
             inside it has to become its own block: text, then the quotation
             stepped out with its own header, then the text resuming. Painting
             the words differently was never enough - the reviewer could not see
             where the clip began or what it was. -->
        {#each block.segs as seg (seg.key)}
          {#if seg.kind === "external"}
            {@const opens = seg.gs[0] === seg.external.fromWord}
            {@const closes = seg.gs[seg.gs.length - 1] === seg.external.toWord}
            <!-- A clip can run across several turns. It is ONE clip, so only
                 the segment that opens it carries the header, and the strip is
                 unbroken between them: three headers for one quotation read as
                 three quotations. A turn that is wholly quoted already sits in
                 the block, so its segment does not draw a second one. -->
            <div
              class="{quotedRuns.has(turn.lead.startWord) ? '' : 'wt-quoted-turn'}
                {opens ? 'mt-2 pt-1.5' : ''} {closes ? 'mb-2 pb-1.5' : ''}"
            >
              {#if opens}
              <div class="group/ext flex items-center gap-2 pb-1 text-[11px] font-ui">
                <span class="text-on-surface-muted/50 uppercase tracking-wide flex-none">External</span>
                {#if seg.external.description}
                  <span class="text-on-surface-muted/80 truncate">{seg.external.description}</span>
                {:else if seg.external.target}
                  <span class="text-on-surface-muted/80 truncate">a record in this corpus</span>
                {:else}
                  <span class="text-warning/70 italic truncate">no source noted</span>
                {/if}
                <span class="flex-1"></span>
                <button
                  onclick={() => onexternaledit?.(seg.external.id)}
                  class="flex-none px-1 rounded cursor-pointer text-on-surface-muted/60 hover:text-primary opacity-0 group-hover/ext:opacity-100 transition-opacity"
                  title="Change where this came from">edit</button>
                <button
                  onclick={() => onexternalremove?.(seg.external.id)}
                  class="flex-none px-1 rounded cursor-pointer text-on-surface-muted/60 hover:text-error opacity-0 group-hover/ext:opacity-100 transition-opacity"
                  title="These words are this recording's own after all">remove</button>
              </div>
              {/if}
              <p class="pl-2 text-sm leading-[1.75]">{@render wordSpans(seg.gs)}</p>
            </div>
          {:else if seg.kind === "cut"}
            <p class="pl-6 text-sm text-on-surface leading-[1.75]">
              <span
                class="wt-cut {activeWord >= seg.from && activeWord <= seg.to ? 'wt-cut-active' : ''}"
                title={cutTextRange(seg.from, seg.to)}
                aria-label="Content marked irrelevant"
              ></span>
            </p>
          {:else}
            <p class="pl-6 text-sm text-on-surface leading-[1.75]">{@render wordSpans(seg.gs)}</p>
          {/if}
        {/each}
      </div>
      {/if}
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
      {copyrightStatus}
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

{#snippet wordSpans(gs: number[])}
          {#each gs as g (g)}<span
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
{/snippet}
