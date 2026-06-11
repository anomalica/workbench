<script lang="ts">
  import type { CoverageSpan } from "$lib/coverage";

  let {
    lineCount,
    pending = [],
    previous = [],
    onjump,
  }: {
    lineCount: number;
    /** Pending (unsubmitted) coverage runs, as body line spans. */
    pending?: CoverageSpan[];
    /** The reviewer's own previously submitted coverage. */
    previous?: CoverageSpan[];
    /** Called with the body line the user clicked, to scroll the transcript there. */
    onjump?: (line: number) => void;
  } = $props();

  let track = $state<HTMLDivElement | null>(null);

  function pct(line: number): number {
    return lineCount > 0 ? (line / lineCount) * 100 : 0;
  }

  function spanStyle(s: CoverageSpan): string {
    const top = pct(s.from);
    const height = Math.max(0.75, pct(s.to + 1) - top);
    return `top:${top}%;height:${height}%`;
  }

  function handleClick(e: MouseEvent) {
    if (!track || lineCount <= 0 || !onjump) return;
    const rect = track.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    onjump(Math.min(lineCount - 1, Math.floor(frac * lineCount)));
  }
</script>

<div class="flex gap-2 items-stretch select-none">
  <div
    bind:this={track}
    class="relative flex-none w-8 h-44 rounded bg-surface-alt border border-border overflow-hidden
      {onjump ? 'cursor-pointer' : ''}"
    role="button"
    tabindex="-1"
    aria-label="Coverage overview - click to scroll the transcript there"
    onclick={handleClick}
    onkeydown={() => {}}
  >
    <!-- Own previous coverage -->
    {#each previous as s}
      <div
        class="absolute inset-x-0 bg-success/40 pointer-events-none"
        style={spanStyle(s)}
        title="Previously covered by you"
      ></div>
    {/each}
    <!-- Pending (unsubmitted) coverage -->
    {#each pending as s}
      <div
        class="absolute inset-x-0 bg-warning/50 border-y border-warning pointer-events-none"
        style={spanStyle(s)}
        title="Pending coverage"
      ></div>
    {/each}
  </div>
  <div class="flex flex-col justify-between text-[10px] text-on-surface-muted font-ui py-0.5">
    <span>line 1</span>
    <span>line {lineCount}</span>
  </div>
</div>
