<script lang="ts">
  import { mergeSpans, subtractSpans, type CoverageSpan } from "$lib/coverage";
  import {
    parseTextBlocks,
    totalUnits,
    observedLineSpans,
    blocksCoveredBySpans,
    unitsInSpans,
  } from "$lib/text-blocks";
  import { safeLocalSet } from "$lib/storage";

  let {
    body,
    renderBlock,
    previousObserved = [],
    storageKey = "",
    containerEl = $bindable(),
    onscroll,
    onverdict,
  }: {
    /** Record body with the frontmatter already stripped. */
    body: string;
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
  let renderedBlocks = $derived(
    blocks
      .map((b) => ({ block: b, html: renderBlock(b.source) }))
      .filter((r) => r.html.trim() !== ""),
  );

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

  let priorBlocks = $derived(blocksCoveredBySpans(blocks, previousObserved));
  let sessionBlocks = $derived(blocksCoveredBySpans(blocks, observedSpans));

  let total = $derived(totalUnits(blocks));
  let coveredUnits = $derived(
    unitsInSpans(blocks, mergeSpans([...previousObserved, ...observedSpans])),
  );
  let pct = $derived(total > 0 ? Math.round((coveredUnits / total) * 100) : 0);

  // The verdict mirrors the word editor's: this session's spans plus the
  // cumulative fraction + digestible flag the digester gate reads.
  let coverageVerdict = $derived({
    spans: observedSpans.map((s) => ({ from: s.from, to: s.to })),
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
    if (e.key === "Escape" && range) {
      e.preventDefault();
      clearSelection();
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

  <!-- Block list -->
  <div
    bind:this={containerEl}
    data-scroll-sync
    {onscroll}
    class="flex-1 overflow-auto px-4 py-4"
  >
    <div class="mx-auto max-w-3xl flex flex-col">
      {#each renderedBlocks as { block, html } (block.index)}
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
          <div
            class="prose prose-sm max-w-none flex-1 py-1 select-none
              text-on-surface prose-headings:text-on-surface prose-a:text-primary
              prose-img:rounded prose-img:max-w-full prose-hr:border-border
              {state === 'none' && !structural ? 'opacity-70' : ''}"
          >
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            {@html html}
          </div>
        </div>
      {/each}
    </div>
  </div>
</div>
