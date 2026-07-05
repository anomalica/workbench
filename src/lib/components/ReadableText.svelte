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
    leadingTitleBlocks,
    type TextBlock,
  } from "$lib/text-blocks";
  import {
    hasPrecedingImage,
    markAsCaption,
    moveCaptionByFile,
    remapSpans,
  } from "$lib/image-captions";
  import { safeLocalSet } from "$lib/storage";

  let {
    body,
    documentTitle = "",
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
    /** The record's title. A leading body block that merely repeats it (a
     *  PDF/ebook title page, or the legacy injected title prelude) is hidden
     *  from display, since the title is shown separately as the document
     *  heading - so it never appears twice. Coverage counting is unchanged. */
    documentTitle?: string;
    /** Render one block's source markdown to trusted HTML (the parent reuses
     *  its annotation + redaction + marked pipeline). */
    renderBlock: (source: string) => string;
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
  // Leading blocks that duplicate the title, hidden from display only.
  let suppressed = $derived(leadingTitleBlocks(blocks, documentTitle));
  let renderedBlocks = $derived(
    blocks
      .map((b) => ({ block: b, html: renderBlock(b.source) }))
      .filter((r) => !suppressed.has(r.block.index) && (r.html.trim() !== "" || r.block.irrelevant)),
  );
  let displayedIndices = $derived(new Set(renderedBlocks.map((r) => r.block.index)));
  // Content blocks that count toward coverage but are never shown to the
  // reviewer - a title heading suppressed because it duplicates the document
  // H1, or an annotation block that renders to nothing - have no gutter to
  // click, so block-by-block review could never cover them and the record would
  // cap at (total - hidden)/total, stuck below 100%. Auto-observe them: the
  // reviewer reads the title as the heading, and empty-render annotations carry
  // no prose. Derived (not $state), so it re-aligns automatically when a body
  // edit renumbers lines. These spans join the stored verdict so the digester
  // gate, which still counts those lines, sees them as observed too.
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
    onbodyedit(markIrrelevantLines(body, lineFrom, lineTo));
    clearSelection();
  }

  function unmarkRegion(region: { blocks: Rendered[] }) {
    if (!onbodyedit) return;
    const { body: newBody, removed } = unmarkIrrelevantAt(body, regionKey(region));
    if (removed.length === 0) return;
    observedSpans = shiftSpansForRemoval(observedSpans, removed);
    livePrevObserved = shiftSpansForRemoval(livePrevObserved, removed);
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
  // (nearest-preceding is only the default guess). `pendingCaption.file` is the
  // image the caption currently sits on.
  let pendingCaption = $state<{ file: string } | null>(null);

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
    onbodyedit(edit.body);
    pendingCaption = edit.imageFile ? { file: edit.imageFile } : null;
    clearSelection();
  }

  /** Re-point the pending caption to the clicked image. */
  function retargetCaption(toFile: string) {
    if (!onbodyedit || !pendingCaption || toFile === pendingCaption.file) return;
    const edit = moveCaptionByFile(body, pendingCaption.file, toFile);
    if (!edit.ok) return;
    observedSpans = remapSpans(observedSpans, edit.oldToNew);
    livePrevObserved = remapSpans(livePrevObserved, edit.oldToNew);
    onbodyedit(edit.body);
    pendingCaption = { file: edit.imageFile ?? toFile };
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

  function onBlockPointerDown(e: PointerEvent, i: number) {
    if (e.button !== 0) return;
    // Let clicks on links behave normally. Native text selection is suppressed
    // via `select-none` on the blocks, so only the block highlight shows.
    if ((e.target as HTMLElement).closest("a")) return;
    // Re-targeting a caption: a click on any image moves the pending caption
    // there instead of selecting the block.
    if (pendingCaption) {
      const fig = (e.target as HTMLElement).closest("figure[data-image-file]") as HTMLElement | null;
      if (fig?.dataset.imageFile) {
        e.preventDefault();
        retargetCaption(fig.dataset.imageFile);
        return;
      }
    }
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

<svelte:window onpointerup={onWindowPointerUp} onkeydown={onWindowKeydown} />

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

  <!-- Block list -->
  <div
    bind:this={containerEl}
    data-scroll-sync
    {onscroll}
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
                  <div class="prose prose-sm max-w-none select-none prose-img:rounded prose-img:max-w-full">
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
            class="prose prose-sm max-w-none flex-1 py-1 select-none
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
</style>
