<script lang="ts">
  import type { CoverageSpan } from "$lib/coverage";
  import { mergeSpans } from "$lib/coverage";

  let {
    lineCount,
    spans,
    previous = [],
    onchange,
  }: {
    lineCount: number;
    /** Currently selected spans (the proposed coverage submission). */
    spans: CoverageSpan[];
    /** The reviewer's own previously submitted coverage. */
    previous?: CoverageSpan[];
    onchange: (spans: CoverageSpan[]) => void;
  } = $props();

  let track = $state<HTMLDivElement | null>(null);
  let dragAnchor = $state<number | null>(null);
  let dragCurrent = $state<number | null>(null);

  function lineAt(clientY: number): number {
    if (!track || lineCount <= 0) return 0;
    const rect = track.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    return Math.min(lineCount - 1, Math.floor(frac * lineCount));
  }

  function pct(line: number): number {
    return lineCount > 0 ? (line / lineCount) * 100 : 0;
  }

  function spanStyle(s: CoverageSpan): string {
    const top = pct(s.from);
    const height = Math.max(0.75, pct(s.to + 1) - top);
    return `top:${top}%;height:${height}%`;
  }

  let dragPreview = $derived(
    dragAnchor !== null && dragCurrent !== null
      ? { from: Math.min(dragAnchor, dragCurrent), to: Math.max(dragAnchor, dragCurrent) }
      : null,
  );

  function onPointerDown(e: PointerEvent) {
    if (lineCount <= 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragAnchor = lineAt(e.clientY);
    dragCurrent = dragAnchor;
  }

  function onPointerMove(e: PointerEvent) {
    if (dragAnchor === null) return;
    dragCurrent = lineAt(e.clientY);
  }

  function onPointerUp() {
    if (dragAnchor === null || dragCurrent === null) return;
    const from = Math.min(dragAnchor, dragCurrent);
    const to = Math.max(dragAnchor, dragCurrent);
    dragAnchor = null;
    dragCurrent = null;
    // A plain click inside an existing span removes it; anything else
    // (click outside, or a drag) adds the range to the selection.
    const hit = from === to ? spans.find((s) => from >= s.from && from <= s.to) : null;
    if (hit) {
      onchange(spans.filter((s) => s !== hit));
    } else {
      onchange(mergeSpans([...spans, { from, to }]));
    }
  }
</script>

<div class="flex gap-2 items-stretch select-none">
  <div
    bind:this={track}
    class="relative flex-none w-8 h-44 rounded bg-surface-alt border border-border cursor-crosshair overflow-hidden touch-none"
    role="slider"
    aria-label="Coverage span selector"
    aria-valuemin={0}
    aria-valuemax={Math.max(0, lineCount - 1)}
    aria-valuenow={spans[0]?.from ?? 0}
    tabindex="0"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
  >
    <!-- Own previous coverage: thin marker on the left edge -->
    {#each previous as s}
      <div
        class="absolute left-0 w-1 bg-success/70 pointer-events-none"
        style={spanStyle(s)}
        title="Previously covered by you"
      ></div>
    {/each}
    <!-- Proposed selection -->
    {#each spans as s}
      <div
        class="absolute left-1 right-0 bg-primary/50 border-y border-primary pointer-events-none"
        style={spanStyle(s)}
      ></div>
    {/each}
    {#if dragPreview}
      <div
        class="absolute left-1 right-0 bg-primary/30 pointer-events-none"
        style={spanStyle(dragPreview)}
      ></div>
    {/if}
  </div>
  <div class="flex flex-col justify-between text-[10px] text-on-surface-muted font-ui py-0.5">
    <span>line 1</span>
    <span>line {lineCount}</span>
  </div>
</div>
