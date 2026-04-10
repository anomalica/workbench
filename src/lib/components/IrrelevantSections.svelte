<script lang="ts">
  export interface Section {
    id: number;
    start: number;
    end: number | null;
    label: string;
  }

  let {
    sections,
    currentTime,
    onaddstart,
    onsetend,
    onremove,
    onlabelchange,
  }: {
    sections: Section[];
    currentTime: number;
    onaddstart: () => void;
    onsetend: (id: number) => void;
    onremove: (id: number) => void;
    onlabelchange: (id: number, label: string) => void;
  } = $props();

  let pendingSection = $derived(sections.find((s) => s.end === null));

  function formatSeconds(s: number): string {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    return `${m}:${String(sec).padStart(2, "0")}`;
  }
</script>

<div class="space-y-2">
  {#if pendingSection}
    <div class="flex items-center gap-2 px-2 py-2 bg-warning-container/30 rounded">
      <span class="text-xs font-ui text-on-warning-container flex-1">
        Marking from {formatSeconds(pendingSection.start)}...
        <span class="text-on-surface-muted">(now at {formatSeconds(currentTime)})</span>
      </span>
      <button
        onclick={() => onsetend(pendingSection!.id)}
        class="text-xs font-ui font-medium px-2 py-1 bg-warning text-on-warning rounded cursor-pointer hover:opacity-90"
      >
        End here
      </button>
    </div>
  {:else}
    <button
      onclick={onaddstart}
      class="w-full text-xs font-ui text-on-surface-secondary px-2 py-2 border border-dashed border-border
        rounded hover:border-primary/50 hover:text-primary cursor-pointer transition-colors text-center"
    >
      Mark irrelevant from current position ({formatSeconds(currentTime)})
    </button>
  {/if}

  {#each sections.filter((s) => s.end !== null) as section}
    <div class="flex items-center gap-2 px-2 py-1.5 rounded border border-border/50 text-sm">
      <span class="text-xs font-mono text-on-surface-muted flex-none">
        {formatSeconds(section.start)} - {formatSeconds(section.end ?? 0)}
      </span>
      <input
        type="text"
        value={section.label}
        placeholder="e.g. intro, ad break, credits"
        oninput={(e) => onlabelchange(section.id, (e.target as HTMLInputElement).value)}
        class="flex-1 min-w-0 bg-transparent text-xs font-ui text-on-surface outline-none
          border-b border-transparent hover:border-border focus:border-primary px-1 py-0.5
          placeholder:text-on-surface-muted"
      />
      <button
        onclick={() => onremove(section.id)}
        class="text-on-surface-muted hover:text-error cursor-pointer p-0.5"
        title="Remove"
      >
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  {/each}
</div>
