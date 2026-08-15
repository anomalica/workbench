<script lang="ts">
  import { untrack } from "svelte";
  import { mergeSpans, subtractSpans, type CoverageSpan } from "$lib/coverage";
  import {
    parseTextBlocks,
    totalUnits,
    observedLineSpans,
    blocksCoveredBySpans,
    unitsInSpans,
    markIrrelevantLines,
    unmarkIrrelevantAt,
    shiftSpansForMark,
    shiftSpansForRemoval,
    type TextBlock,
  } from "$lib/text-blocks";
  import {
    hasPrecedingImage,
    markAsCaption,
    moveCaptionTo,
    setImageRelevanceAt,
    imageDescriptionAt,
    setImageDescriptionAt,
    remapSpans,
  } from "$lib/image-captions";
  import { safeLocalSet } from "$lib/storage";

  let {
    body,
    renderBlock,
    previousObserved = [],
    storageKey = "",
    containerEl = $bindable(),
    onscroll,
    onverdict,
    onbodyedit,
    onblockclick,
  }: {
    /** Record body with the frontmatter already stripped. */
    body: string;
    /** Render one block's source markdown to trusted HTML (the parent reuses
     *  its annotation + redaction + marked pipeline). `lineFrom` is the block's
     *  first body line, so per-image controls can be stamped with the
     *  whole-body line that identifies their annotation. */
    renderBlock: (source: string, lineFrom: number) => string;
    /** This reviewer's prior committed coverage (line spans), shown as read. */
    previousObserved?: CoverageSpan[];
    /** localStorage key for persisting this session's pending marks. */
    storageKey?: string;
    /** Bindable scroll container, exposed so the parent can scroll to quotes. */
    containerEl?: HTMLDivElement;
    /** Forwarded scroll handler (digest scroll-sync). */
    onscroll?: (e: Event) => void;
    /** Apply a body edit (mark/unmark irrelevant) through the parent's
     *  DocumentStore, so it undoes and commits like any review edit.
     *  Absent in view-only contexts - the marking UI hides. */
    onbodyedit?: (newBody: string) => void;
    /** Fired with a clicked block's first source line - the parent's
     *  follow-in-source uses it to jump the source pane to that page. */
    onblockclick?: (lineFrom: number) => void;
    /** Report the coverage verdict whenever it changes, so a review submit can
     *  persist the observed line spans + fraction to the sidecar. */
    onverdict?: (v: {
      spans: { from: number; to: number }[];
      observed_coverage: number;
      digestible: boolean;
      total_units: number;
    }) => void;
  } = $props();

  let blocks = $derived(parseTextBlocks(body));
  // The body renders faithfully - every block is shown, nothing suppressed.
  let renderedBlocks = $derived(
    blocks
      .map((b) => ({ block: b, html: renderBlock(b.source, b.lineFrom) }))
      .filter((r) => r.html.trim() !== "" || r.block.irrelevant),
  );
  let displayedIndices = $derived(new Set(renderedBlocks.map((r) => r.block.index)));
  // A content block that counts toward coverage but renders to nothing (e.g. a
  // markdown link-reference definition) has no gutter to click, so block-by-block
  // review could never cover it and the record would stall below 100%. Auto-
  // observe those unmarkable blocks: the reviewer sees no prose to read there.
  // Derived (not $state), so it re-aligns when a body edit renumbers lines;
  // these spans join the stored verdict so the digester gate, which still counts
  // those lines, sees them observed too.
  let autoObservedSpans = $derived(
    blocks
      .filter((b) => !b.irrelevant && b.contentLines.length > 0 && !displayedIndices.has(b.index))
      .map((b) => ({ from: b.lineFrom, to: b.lineTo })),
  );

  // Group runs of consecutive irrelevant blocks into one collapsible region
  // strip; everything else renders as ordinary blocks.
  type Rendered = { block: TextBlock; html: string };
  type DisplayItem =
    | { kind: "block"; block: TextBlock; html: string }
    | { kind: "region"; blocks: Rendered[] };
  let displayItems = $derived.by(() => {
    const items: DisplayItem[] = [];
    for (const r of renderedBlocks) {
      const last = items[items.length - 1];
      if (r.block.irrelevant) {
        if (last?.kind === "region") last.blocks.push(r);
        else items.push({ kind: "region", blocks: [r] });
      } else {
        items.push({ kind: "block", block: r.block, html: r.html });
      }
    }
    return items;
  });

  // Regions are collapsed by default; expansion is keyed by the region's
  // first source line (stable for a given body version).
  let expandedRegions = $state<number[]>([]);

  function regionKey(region: { blocks: Rendered[] }): number {
    return region.blocks[0].block.lineFrom;
  }

  function toggleRegion(key: number) {
    expandedRegions = expandedRegions.includes(key)
      ? expandedRegions.filter((k) => k !== key)
      : [...expandedRegions, key];
  }

  // Marking is offered only when the parent wired an edit path and the
  // selection holds at least one markable (non-irrelevant, content) block.
  let selectionMarkable = $derived.by(() => {
    if (!onbodyedit || !range) return false;
    const chosen = selectedIndices()
      .map((i) => blocks.find((b) => b.index === i))
      .filter((b): b is TextBlock => !!b);
    return chosen.length > 0 && chosen.every((b) => !b.irrelevant);
  });

  function markSelectionIrrelevant() {
    if (!onbodyedit || !range) return;
    const chosen = selectedIndices()
      .map((i) => blocks.find((b) => b.index === i))
      .filter((b): b is TextBlock => !!b && !b.irrelevant);
    if (chosen.length === 0) return;
    const lineFrom = Math.min(...chosen.map((b) => b.lineFrom));
    const lineTo = Math.max(...chosen.map((b) => b.lineTo));
    observedSpans = shiftSpansForMark(observedSpans, lineFrom, lineTo);
    livePrevObserved = shiftSpansForMark(livePrevObserved, lineFrom, lineTo);
    shiftPending((spans) => shiftSpansForMark(spans, lineFrom, lineTo));
    onbodyedit(markIrrelevantLines(body, lineFrom, lineTo));
    clearSelection();
  }

  function unmarkRegion(region: { blocks: Rendered[] }) {
    if (!onbodyedit) return;
    const { body: newBody, removed } = unmarkIrrelevantAt(body, regionKey(region));
    if (removed.length === 0) return;
    observedSpans = shiftSpansForRemoval(observedSpans, removed);
    livePrevObserved = shiftSpansForRemoval(livePrevObserved, removed);
    shiftPending((spans) => shiftSpansForRemoval(spans, removed));
    onbodyedit(newBody);
  }

  // A block that is real prose, not an annotation. A multi-line annotation now
  // carries no content lines (its whole comment is flagged), so such a block has
  // contentLines.length === 0 and fails the check anyway; the source guard stays
  // as belt-and-braces so annotation text is never moved into an image caption.
  function isProseBlock(b: TextBlock): boolean {
    return !b.irrelevant && b.contentLines.length > 0 && !b.source.trimStart().startsWith("<!--");
  }

  // "Mark as caption": offered when the selection is real prose with an image
  // annotation above it to attach to.
  let selectionCaptionable = $derived.by(() => {
    if (!onbodyedit || !range) return false;
    const chosen = selectedIndices()
      .map((i) => blocks.find((b) => b.index === i))
      .filter((b): b is TextBlock => !!b);
    if (chosen.length === 0 || !chosen.every(isProseBlock)) return false;
    return hasPrecedingImage(body, Math.min(...chosen.map((b) => b.lineFrom)));
  });

  // After a caption is set, the reviewer can re-target it to a different image
  // (nearest-preceding is only the default guess). `pendingCaption.line` is the
  // annotation the caption currently sits on. Images are identified by their
  // annotation's body line, never by `file` - the same media file can be
  // annotated twice (a repeated figure dedupes to one file), and a file-keyed
  // lookup resolves both to the first one.
  let pendingCaption = $state<{ line: number } | null>(null);

  // Body edits renumber lines, so any held line identity is moved with them.
  function shiftPending(shift: (spans: CoverageSpan[]) => CoverageSpan[]) {
    if (pendingCaption) {
      const [s] = shift([{ from: pendingCaption.line, to: pendingCaption.line }]);
      pendingCaption = s ? { line: s.from } : null;
    }
    if (editingDescription) {
      const [s] = shift([{ from: editingDescription.line, to: editingDescription.line }]);
      if (s) editingDescription = { ...editingDescription, line: s.from };
      else editingDescription = null;
    }
  }

  function markSelectionAsCaption() {
    if (!onbodyedit || !range) return;
    const chosen = selectedIndices()
      .map((i) => blocks.find((b) => b.index === i))
      .filter((b): b is TextBlock => !!b && isProseBlock(b));
    if (chosen.length === 0) return;
    const lineFrom = Math.min(...chosen.map((b) => b.lineFrom));
    const lineTo = Math.max(...chosen.map((b) => b.lineTo));
    const edit = markAsCaption(body, lineFrom, lineTo);
    if (!edit.ok) return;
    observedSpans = remapSpans(observedSpans, edit.oldToNew);
    livePrevObserved = remapSpans(livePrevObserved, edit.oldToNew);
    shiftPending((spans) => remapSpans(spans, edit.oldToNew));
    onbodyedit(edit.body);
    pendingCaption = edit.imageLine === undefined ? null : { line: edit.imageLine };
    clearSelection();
  }

  /** Re-point the pending caption to the clicked image. */
  function retargetCaption(toLine: number) {
    if (!onbodyedit || !pendingCaption || toLine === pendingCaption.line) return;
    const edit = moveCaptionTo(body, pendingCaption.line, toLine);
    if (!edit.ok) return;
    observedSpans = remapSpans(observedSpans, edit.oldToNew);
    livePrevObserved = remapSpans(livePrevObserved, edit.oldToNew);
    shiftPending((spans) => remapSpans(spans, edit.oldToNew));
    onbodyedit(edit.body);
    pendingCaption = { line: edit.imageLine ?? toLine };
  }

  // This session's pending marks, persisted as line spans (stable across the
  // block re-indexing an edit would cause). Prior committed coverage is shown
  // too but can't be unmarked here.
  let observedSpans = $state<CoverageSpan[]>([]);
  let restoredKey = "";
  $effect(() => {
    const key = storageKey;
    if (key === restoredKey) return;
    restoredKey = key;
    let restored: CoverageSpan[] = [];
    try {
      const raw = key ? localStorage.getItem(key) : null;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) restored = parsed;
      }
    } catch {
      restored = [];
    }
    observedSpans = restored;
    clearSelection();
    pendingCaption = null;
  });

  $effect(() => {
    const key = restoredKey;
    const spans = observedSpans;
    if (!key) return;
    if (spans.length === 0) {
      try {
        localStorage.removeItem(key);
      } catch {
        // best-effort
      }
    } else {
      safeLocalSet(key, JSON.stringify(spans));
    }
  });

  // Prior committed coverage, held locally so it can be shifted in step with
  // an in-session body edit (mark irrelevant / caption). previousObserved is
  // line-indexed against the body as committed; inserting/removing lines
  // renumbers the body, so without this the prior reads stop mapping to their
  // renumbered blocks and drop out of the coverage total. Re-synced from the
  // prop only when it actually changes (record switch, coverage fetch, submit)
  // - never mid-edit - so the shifts survive.
  let livePrevObserved = $state<CoverageSpan[]>([]);
  $effect(() => {
    // Re-sync ONLY when previousObserved changes (record switch, coverage
    // fetch, submit) - never on a body edit, so in-session shifts survive.
    // `body` is read untracked for the same reason. Drop/clamp spans that
    // reference lines past the current body: a content-hash-stable re-ingest
    // (audio/pdf) keeps the coverage sidecar but reshapes the body, so
    // carried-over spans can dangle beyond it. A dangling span never blocks
    // reaching 100% (the reviewer re-confirms via Mark all read); the clamp
    // just stops it over- or under-counting.
    const prev = previousObserved;
    const maxLine = untrack(() => body.split("\n").length - 1);
    livePrevObserved = prev
      .filter((s) => s.from <= maxLine)
      .map((s) => (s.to > maxLine ? { ...s, to: maxLine } : s));
  });

  let priorBlocks = $derived(blocksCoveredBySpans(blocks, livePrevObserved));
  let sessionBlocks = $derived(blocksCoveredBySpans(blocks, observedSpans));

  let total = $derived(totalUnits(blocks));
  let coveredUnits = $derived(
    unitsInSpans(blocks, mergeSpans([...livePrevObserved, ...observedSpans, ...autoObservedSpans])),
  );
  let pct = $derived(total > 0 ? Math.round((coveredUnits / total) * 100) : 0);

  // The verdict mirrors the word editor's: this session's spans plus the
  // cumulative fraction + digestible flag the digester gate reads.
  let coverageVerdict = $derived({
    spans: mergeSpans([...observedSpans, ...autoObservedSpans]).map((s) => ({ from: s.from, to: s.to })),
    observed_coverage: total > 0 ? coveredUnits / total : 0,
    digestible: total > 0 && coveredUnits === total,
    total_units: total,
  });
  $effect(() => {
    onverdict?.(coverageVerdict);
  });

  // --- Selection over block indices ---
  let anchor = $state<number | null>(null);
  let range = $state<{ from: number; to: number } | null>(null);
  let dragging = $state(false);

  function clearSelection() {
    anchor = null;
    range = null;
    dragging = false;
  }

  function selectBlock(i: number, extend: boolean) {
    if (extend && anchor !== null) {
      range = { from: Math.min(anchor, i), to: Math.max(anchor, i) };
    } else {
      anchor = i;
      range = { from: i, to: i };
    }
  }

  // Per-image relevance and caption re-target act on image figures, which sit
  // in structural blocks (zero units) that don't take a pointerdown selection
  // handler - so both are handled by delegation on the block-list container.
  /** The annotation line a control carries, or null when it is absent or the
   *  render could not resolve one (`-1`). */
  function imageLineOf(el: HTMLElement | null): number | null {
    const raw = el?.dataset.imageLine;
    if (raw === undefined) return null;
    const line = Number(raw);
    return Number.isInteger(line) && line >= 0 ? line : null;
  }

  function onImageControlClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    const toggle = target.closest(".image-relevance-toggle") as HTMLElement | null;
    const toggleLine = imageLineOf(toggle);
    if (toggleLine !== null) {
      e.preventDefault();
      e.stopPropagation();
      toggleImageRelevance(toggleLine, toggle?.dataset.irrelevant === "true");
      return;
    }
    const rmBtn = target.closest(".image-description-remove") as HTMLElement | null;
    const rmLine = imageLineOf(rmBtn);
    if (rmLine !== null) {
      e.preventDefault();
      e.stopPropagation();
      removeImageDescription(rmLine);
      return;
    }
    const descBtn = target.closest(".image-description-edit") as HTMLElement | null;
    const descLine = imageLineOf(descBtn);
    if (descLine !== null) {
      e.preventDefault();
      e.stopPropagation();
      openDescriptionEditor(descLine);
      return;
    }
    if (pendingCaption) {
      const fig = target.closest("figure[data-image-line]") as HTMLElement | null;
      const figLine = imageLineOf(fig);
      if (figLine !== null) {
        e.preventDefault();
        retargetCaption(figLine);
      }
    }
  }

  // Flip the display-only `irrelevant` flag on the image annotation. Shifts the
  // session/prior spans past the one-line annotation edit, like the caption
  // edits. Never changes coverage totals (the image block stays zero-unit).
  function toggleImageRelevance(line: number, currentlyIrrelevant: boolean) {
    if (!onbodyedit) return;
    const edit = setImageRelevanceAt(body, line, !currentlyIrrelevant);
    if (!edit.ok) return;
    observedSpans = remapSpans(observedSpans, edit.oldToNew);
    livePrevObserved = remapSpans(livePrevObserved, edit.oldToNew);
    shiftPending((spans) => remapSpans(spans, edit.oldToNew));
    onbodyedit(edit.body);
  }

  // The image description editor: free-text the reviewer writes to transcribe or
  // describe what is IN the image. Distinct from the caption (which the source
  // printed) - the description is extractable content.
  let editingDescription = $state<{ line: number; text: string } | null>(null);
  function openDescriptionEditor(line: number) {
    editingDescription = { line, text: imageDescriptionAt(body, line) };
  }
  function saveDescription() {
    if (!onbodyedit || !editingDescription) return;
    const { line, text } = editingDescription;
    const edit = setImageDescriptionAt(body, line, text);
    editingDescription = null;
    if (!edit.ok) return;
    observedSpans = remapSpans(observedSpans, edit.oldToNew);
    livePrevObserved = remapSpans(livePrevObserved, edit.oldToNew);
    shiftPending((spans) => remapSpans(spans, edit.oldToNew));
    onbodyedit(edit.body);
  }

  // Clear the description field in one click (same commit path as an edit).
  function removeImageDescription(line: number) {
    if (!onbodyedit) return;
    const edit = setImageDescriptionAt(body, line, "");
    if (!edit.ok) return;
    observedSpans = remapSpans(observedSpans, edit.oldToNew);
    livePrevObserved = remapSpans(livePrevObserved, edit.oldToNew);
    shiftPending((spans) => remapSpans(spans, edit.oldToNew));
    onbodyedit(edit.body);
  }

  /** True while Alt is held: the blocks release the selection so the browser
   *  can make a text one. */
  let textSelect = $state(false);

  function onBlockPointerDown(e: PointerEvent, i: number) {
    if (e.button !== 0) return;
    // Alt-drag is a TEXT selection, not a block one. The plain drag belongs to
    // read coverage - it is the commoner act and had the gesture first - so
    // marking up a phrase (a note on some handwriting, a highlight) has to ask
    // for it, and while Alt is held the blocks stop swallowing the selection.
    if (e.altKey || e.ctrlKey) return;
    // Let clicks on links behave normally. Native text selection is suppressed
    // via `select-none` on the blocks, so only the block highlight shows.
    if ((e.target as HTMLElement).closest("a")) return;
    const block = blocks.find((b) => b.index === i);
    if (block) onblockclick?.(block.lineFrom);
    if (e.shiftKey) {
      selectBlock(i, true);
    } else {
      dragging = true;
      selectBlock(i, false);
    }
  }

  function onBlockPointerEnter(i: number) {
    if (dragging && anchor !== null) range = { from: Math.min(anchor, i), to: Math.max(anchor, i) };
  }

  function onWindowPointerUp() {
    dragging = false;
  }

  function onWindowKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && editingDescription) {
      e.preventDefault();
      editingDescription = null;
      return;
    }
    if (e.key === "Escape" && (range || pendingCaption)) {
      e.preventDefault();
      clearSelection();
      pendingCaption = null;
    }
  }

  function selectedIndices(): number[] {
    if (!range) return [];
    const out: number[] = [];
    for (let i = range.from; i <= range.to; i++) out.push(i);
    return out;
  }

  // All selected blocks already marked this session -> the action unmarks.
  let selectionAllMarked = $derived.by(() => {
    const idx = range ? selectedIndices() : [];
    return idx.length > 0 && idx.every((i) => sessionBlocks.has(i));
  });

  function spansForBlocks(indices: number[]): CoverageSpan[] {
    return indices
      .map((i) => blocks.find((b) => b.index === i))
      .filter((b): b is NonNullable<typeof b> => !!b && b.contentLines.length > 0)
      .map((b) => ({ from: b.lineFrom, to: b.lineTo }));
  }

  function markSelection(read: boolean) {
    const spans = spansForBlocks(selectedIndices());
    if (spans.length === 0) return;
    observedSpans = read
      ? mergeSpans([...observedSpans, ...spans])
      : subtractSpans(observedSpans, spans);
  }

  function toggleBlock(i: number) {
    const spans = spansForBlocks([i]);
    if (spans.length === 0) return;
    observedSpans = sessionBlocks.has(i)
      ? subtractSpans(observedSpans, spans)
      : mergeSpans([...observedSpans, ...spans]);
  }

  function markAll() {
    observedSpans = observedLineSpans(blocks, new Set(blocks.map((b) => b.index)));
  }

  function clearAll() {
    observedSpans = [];
    clearSelection();
  }

  function blockState(i: number): "prior" | "session" | "none" {
    if (sessionBlocks.has(i)) return "session";
    if (priorBlocks.has(i)) return "prior";
    return "none";
  }

  function inSelection(i: number): boolean {
    return !!range && i >= range.from && i <= range.to;
  }

  // Scroll to the first block the reviewer hasn't read yet (a content block not
  // covered by this session's marks or their prior committed coverage).
  function jumpToFirstUnread() {
    for (const { block } of renderedBlocks) {
      if (block.contentLines.length === 0) continue;
      if (sessionBlocks.has(block.index) || priorBlocks.has(block.index)) continue;
      if (!containerEl?.querySelector(`[data-block-index="${block.index}"]`)) continue;
      anchor = block.index;
      range = { from: block.index, to: block.index };
      // Scroll next frame so the range-change re-render doesn't cancel it;
      // scroll the container directly (scrollIntoView targets the wrong ancestor).
      const idx = block.index;
      requestAnimationFrame(() => {
        const el = containerEl?.querySelector<HTMLElement>(`[data-block-index="${idx}"]`);
        if (!el || !containerEl) return;
        const view = containerEl.getBoundingClientRect();
        const b = el.getBoundingClientRect();
        const target = containerEl.scrollTop + (b.top - view.top) - view.height * 0.4;
        // Instant, not smooth (smooth scrollTo is a no-op in some Chromium
        // profiles, and a jump reads fine landing immediately).
        containerEl.scrollTo({ top: Math.max(0, target) });
      });
      return;
    }
  }
</script>

<svelte:window
  onpointerup={onWindowPointerUp}
  onkeydown={(e) => {
    if (e.key === "Alt" || e.key === "Control") textSelect = true;
    onWindowKeydown(e);
  }}
  onkeyup={(e) => {
    // Held, not toggled - and released on blur too, or leaving the window with
    // Alt down leaves the blocks unselectable.
    if (e.key === "Alt" || e.key === "Control") textSelect = false;
  }}
  onblur={() => (textSelect = false)}
/>

<div class="flex flex-col min-h-0 flex-1">
  <!-- Coverage toolbar: progress + contextual selection actions -->
  <div
    class="flex-none flex items-center gap-3 px-4 py-2 border-b border-border bg-surface-alt/60 text-xs font-ui"
  >
    <span class="font-medium text-on-surface tabular-nums whitespace-nowrap">{pct}% read</span>
    <div class="flex-1 h-1.5 rounded-full bg-surface overflow-hidden max-w-xs">
      <div class="h-full bg-primary transition-all" style="width:{pct}%"></div>
    </div>
    {#if pct < 100}
      <button
        onclick={jumpToFirstUnread}
        class="font-medium text-primary cursor-pointer hover:underline whitespace-nowrap"
        title="Scroll to the first block you haven't read yet"
      >
        Jump to unread
      </button>
    {/if}

    {#if range}
      {@const n = range.to - range.from + 1}
      <span class="text-on-surface-secondary tabular-nums whitespace-nowrap">
        {n} block{n === 1 ? "" : "s"} selected
      </span>
      <button
        onclick={() => markSelection(!selectionAllMarked)}
        class="font-medium text-primary cursor-pointer hover:underline whitespace-nowrap"
        title={selectionAllMarked ? "Mark the selection as not read" : "Mark the selection as read"}
      >
        {selectionAllMarked ? "Mark unread" : "Mark read"}
      </button>
      {#if selectionMarkable}
        <!-- Guidance summarised from the canonical list in
             architecture/review-workbench.md#what-to-mark-irrelevant -
             link/summarise, never duplicate. -->
        <button
          onclick={markSelectionIrrelevant}
          class="font-medium text-warning cursor-pointer hover:underline whitespace-nowrap"
          title="Kept in the record, excluded from extraction. Mark anything that is not domain content: marketing and self-promotion, copyright/legal pages, contents and indices, bibliographies and endnote lists, dedication-style filler, ads and AV filler. Full guidance: review-workbench.md - What to mark irrelevant."
        >
          Mark irrelevant
        </button>
      {/if}
      {#if selectionCaptionable}
        <button
          onclick={markSelectionAsCaption}
          class="font-medium text-primary cursor-pointer hover:underline whitespace-nowrap"
          title="Move this text into the caption field of the image above. Captions (often carrying a copyright or attribution line) are kept on the image and excluded from extraction, so they aren't read as claims."
        >
          Mark as caption
        </button>
      {/if}
      <button
        onclick={clearSelection}
        class="text-on-surface-muted hover:text-on-surface cursor-pointer whitespace-nowrap"
        title="Clear selection (Esc)"
      >
        Clear
      </button>
    {:else}
      <span class="text-on-surface-muted whitespace-nowrap hidden sm:inline">
        Select what you've read, then Mark read
      </span>
      <button
        onclick={markAll}
        class="ml-auto font-medium text-primary cursor-pointer hover:underline whitespace-nowrap"
        title="Mark the whole record as read"
      >
        Mark all read
      </button>
      {#if observedSpans.length > 0}
        <button
          onclick={clearAll}
          class="text-on-surface-muted hover:text-on-surface cursor-pointer whitespace-nowrap"
          title="Clear this session's marks"
        >
          Clear marks
        </button>
      {/if}
    {/if}
  </div>

  <!-- Caption re-target bar: after a caption is set (nearest-preceding image),
       let the reviewer point it at the correct image. -->
  {#if pendingCaption}
    <div class="flex-none flex items-center gap-3 px-4 py-2 border-b border-border bg-primary/10 text-xs font-ui">
      <svg class="w-3.5 h-3.5 flex-none text-primary" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14M14 8h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
      <span class="text-on-surface">Caption attached to the highlighted image. Wrong one? Click the correct image to move it.</span>
      <button
        onclick={() => (pendingCaption = null)}
        class="ml-auto font-medium text-primary cursor-pointer hover:underline whitespace-nowrap"
        title="Keep the caption where it is (Esc)"
      >
        Done
      </button>
    </div>
  {/if}

  <!-- Image description editor: free-text transcription of what is IN the image.
       Distinct from the caption - the description is extractable content. -->
  {#if editingDescription}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onclick={(e) => {
        if (e.target === e.currentTarget) editingDescription = null;
      }}
    >
      <div class="w-full max-w-lg rounded-lg bg-surface border border-border shadow-xl flex flex-col">
        <div class="px-5 pt-4 pb-3 border-b border-border">
          <h2 class="text-sm font-ui font-semibold text-on-surface">Image description</h2>
          <p class="mt-1 text-xs text-on-surface-secondary leading-relaxed">
            Transcribe or factually describe what is <em>in</em> the image - the text of a screenshot,
            the figures in a chart, the words on a page. This is content: it feeds extraction and can
            become a claim, so keep it faithful (no interpretation). It is not the
            <span class="font-medium">caption</span> - that is the source's own attribution line and
            stays out of extraction.
          </p>
        </div>
        <div class="px-5 py-4">
          <!-- svelte-ignore a11y_autofocus -->
          <textarea
            bind:value={editingDescription.text}
            rows="5"
            autofocus
            onkeydown={(e) => {
              // Ctrl/Cmd-Enter saves an image description too: it is a note by
              // another name, and reaching for the mouse to keep one sentence
              // is what makes describing images not worth doing.
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                saveDescription();
              }
            }}
            placeholder="e.g. Tweet by @user, 3 May 2023: The Pentagon confirmed the 2004 Nimitz object remains unidentified."
            class="w-full rounded border border-border bg-surface-alt px-3 py-2 text-sm text-on-surface
              placeholder:text-on-surface-muted focus:outline-none focus:ring-1 focus:ring-primary resize-y"
          ></textarea>
        </div>
        <div class="px-5 pb-4 flex items-center justify-end gap-3">
          <button
            onclick={() => (editingDescription = null)}
            class="text-xs font-ui text-on-surface-secondary hover:text-on-surface cursor-pointer"
          >
            Cancel
          </button>
          <button
            onclick={saveDescription}
            class="text-xs font-ui font-medium px-3 py-1.5 rounded bg-primary text-on-primary
              hover:bg-primary/90 cursor-pointer"
          >
            Save description
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Block list -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    bind:this={containerEl}
    data-scroll-sync
    {onscroll}
    onclick={onImageControlClick}
    class="flex-1 overflow-auto px-4 py-4 {pendingCaption ? 'caption-retarget' : ''}"
  >
    <div class="mx-auto max-w-3xl flex flex-col">
      {#each displayItems as item (item.kind === "block" ? item.block.index : `r${regionKey(item)}`)}
        {#if item.kind === "region"}
          {@const key = regionKey(item)}
          {@const expanded = expandedRegions.includes(key)}
          <div class="my-2 rounded border border-border bg-surface-alt/50">
            <div class="flex items-center gap-2 px-3 py-1.5 text-xs font-ui">
              <span class="font-medium text-on-surface-muted uppercase tracking-wide">Irrelevant</span>
              <span class="text-on-surface-muted">
                {item.blocks.length} block{item.blocks.length === 1 ? "" : "s"} excluded from extraction
              </span>
              <button
                onclick={() => toggleRegion(key)}
                class="ml-auto text-on-surface-secondary hover:text-on-surface cursor-pointer whitespace-nowrap"
                title={expanded ? "Collapse the excluded text" : "Show the excluded text"}
              >
                {expanded ? "Hide" : "Show"}
              </button>
              {#if onbodyedit}
                <button
                  onclick={() => unmarkRegion(item)}
                  class="font-medium text-primary hover:underline cursor-pointer whitespace-nowrap"
                  title="Remove the irrelevant markers - the text returns to the record's content"
                >
                  Unmark
                </button>
              {/if}
            </div>
            {#if expanded}
              <div class="px-3 pb-2 opacity-50">
                {#each item.blocks as { html: regionHtml }}
                  <div
                    class="prose prose-sm max-w-none prose-img:rounded prose-img:max-w-full
                      {textSelect ? '' : 'select-none'}"
                  >
                    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                    {@html regionHtml}
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {:else}
        {@const block = item.block}
        {@const html = item.html}
        {@const state = blockState(block.index)}
        {@const structural = block.contentLines.length === 0}
        <!-- Drag-to-select is a pointer enhancement; keyboard users mark via the
             gutter button and toolbar actions, which are real buttons. -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="group flex gap-2 rounded transition-colors
            {inSelection(block.index) && !structural ? 'bg-primary/10' : 'hover:bg-surface-alt/40'}"
          data-block-index={block.index}
          onpointerdown={(e) => !structural && onBlockPointerDown(e, block.index)}
          onpointerenter={() => onBlockPointerEnter(block.index)}
        >
          <!-- Coverage gutter: click toggles just this block. Structural blocks
               (page markers, redaction notes - no readable units) get a plain
               spacer instead, so they read as dividers, not coverage targets. -->
          {#if structural}
            <span class="flex-none w-1.5" aria-hidden="true"></span>
          {:else}
            <button
              onclick={() => toggleBlock(block.index)}
              class="flex-none w-1.5 rounded-full my-1 cursor-pointer transition-colors
                {state === 'session'
                  ? 'bg-primary'
                  : state === 'prior'
                    ? 'bg-success'
                    : 'bg-border/50 hover:bg-on-surface-muted'}"
              title={state === "none"
                ? "Mark this block as read"
                : state === "session"
                  ? "Marked read this session - click to unmark"
                  : "Read in a previous review"}
              aria-label="Toggle read"
            ></button>
          {/if}
          <!-- Colours come from the .prose token mapping in app.css (every prose
               element wired to the brand semantic tokens, light + dark); only
               structural image utilities are set here. -->
          <div
            class="prose prose-sm max-w-none flex-1 py-1 {textSelect ? '' : 'select-none'}
              prose-img:rounded prose-img:max-w-full
              {state === 'none' && !structural ? 'opacity-70' : ''}"
          >
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            {@html html}
          </div>
        </div>
        {/if}
      {/each}
    </div>
  </div>
</div>

<style>
  /* While re-targeting a caption, every image reads as a clickable target. The
     figures render via {@html}, so these must be :global. */
  :global(.caption-retarget figure.ingest-figure) {
    cursor: pointer;
    outline: 2px dashed color-mix(in srgb, var(--color-primary) 55%, transparent);
    outline-offset: 3px;
    border-radius: 0.25rem;
  }
  :global(.caption-retarget figure.ingest-figure:hover) {
    outline-style: solid;
    outline-color: var(--color-primary);
  }

  /* Per-image relevance. The toggle hides until the figure is hovered (keeps the
     reading view clean), but stays visible once an image is marked irrelevant so
     the reviewer can always undo. Figures render via {@html}, so :global. */
  :global(figure.ingest-figure) {
    position: relative;
  }
  :global(figure.ingest-figure .image-relevance-toggle) {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    font-size: 0.7rem;
    font-weight: 500;
    line-height: 1;
    padding: 0.25rem 0.6rem;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--color-surface) 88%, transparent);
    color: var(--color-on-surface-secondary);
    border: 1px solid var(--color-border);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s;
  }
  :global(figure.ingest-figure:hover .image-relevance-toggle),
  :global(figure.ingest-figure[data-image-irrelevant="true"] .image-relevance-toggle) {
    opacity: 1;
  }
  :global(figure.ingest-figure .image-relevance-toggle:hover) {
    color: var(--color-warning);
    border-color: var(--color-warning);
  }
  /* Marked irrelevant: dim the image and badge it, so it visibly reads as
     dropped-from-display without any change to the read percentage. */
  :global(figure.ingest-figure[data-image-irrelevant="true"] img) {
    opacity: 0.4;
    filter: grayscale(1);
  }
  :global(figure.ingest-figure .image-irrelevant-tag) {
    position: absolute;
    top: 0.5rem;
    left: 0.5rem;
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: 0.2rem 0.5rem;
    border-radius: 0.25rem;
    background: var(--color-warning);
    color: var(--color-surface);
  }

  /* Image description: the reviewer's transcription of the image content. Reads
     as a distinct, labelled block (not a caption) because it is extractable
     content. The primary accent marks it apart from the muted figcaption. */
  :global(figure.ingest-figure .image-description) {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    margin-top: 0.5rem;
    padding: 0.4rem 0.7rem;
    text-align: left;
    border-left: 3px solid var(--color-primary);
    background: color-mix(in srgb, var(--color-primary) 7%, transparent);
    border-radius: 0 0.25rem 0.25rem 0;
    font-size: 0.85rem;
    line-height: 1.45;
    color: var(--color-on-surface);
  }
  :global(figure.ingest-figure .image-description-label) {
    font-size: 0.6rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-primary);
  }
  :global(figure.ingest-figure .image-description-actions) {
    display: inline-flex;
    align-items: center;
    gap: 0.6rem;
    margin-top: 0.2rem;
  }
  :global(figure.ingest-figure .image-description-edit) {
    align-self: flex-start;
    font-size: 0.7rem;
    color: var(--color-primary);
    cursor: pointer;
  }
  :global(figure.ingest-figure .image-description-edit:hover) {
    text-decoration: underline;
  }
  :global(figure.ingest-figure .image-description-remove) {
    display: inline-flex;
    align-items: center;
    color: var(--color-on-surface-muted);
    cursor: pointer;
  }
  :global(figure.ingest-figure .image-description-remove:hover) {
    color: var(--color-warning);
  }
  /* The "add description" affordance hover-reveals so undescribed images stay
     uncluttered, matching the relevance toggle. */
  :global(figure.ingest-figure .image-description-add) {
    display: inline-block;
    margin-top: 0.5rem;
    font-size: 0.72rem;
    color: var(--color-on-surface-secondary);
    border: 1px dashed var(--color-border);
    border-radius: 9999px;
    padding: 0.2rem 0.7rem;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s;
  }
  :global(figure.ingest-figure:hover .image-description-add) {
    opacity: 1;
  }
  :global(figure.ingest-figure .image-description-add:hover) {
    color: var(--color-primary);
    border-color: var(--color-primary);
  }
</style>
