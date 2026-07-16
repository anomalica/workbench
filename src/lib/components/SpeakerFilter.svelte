<script lang="ts">
  import { isSpecialSpeaker } from "$lib/transcript";
  import SpeakerDot from "./SpeakerDot.svelte";

  // Read-only speaker filter for the Markup tab: markup doesn't edit speakers, so
  // this offers only click-to-filter, no rename/merge/add, no observation counts.
  // Special tokens ([irrelevant]/[narrator]/...) are never marked up, so they are
  // not listed - only real speakers (named + unnamed clusters).
  let {
    rows = null,
    filteredSpeakers,
    onfilter,
  }: {
    rows: { id: string; total: number }[] | null;
    filteredSpeakers: Set<string>;
    onfilter: (id: string) => void;
  } = $props();

  let speakers = $derived((rows ?? []).filter((r) => r.id && !isSpecialSpeaker(r.id)));
</script>

{#if speakers.length === 0}
  <p class="px-1 py-2 text-xs text-on-surface-muted">No speakers to filter.</p>
{:else}
  <div class="space-y-0.5">
    {#each speakers as r (r.id)}
      {@const active = filteredSpeakers.has(r.id)}
      <button
        onclick={() => onfilter(r.id)}
        class="w-full flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors select-none
          {active ? 'bg-primary-container/30 ring-1 ring-primary/30' : 'hover:bg-surface-alt'}"
        title="Click to filter to this speaker; click others to add them (several at once)"
      >
        <SpeakerDot speaker={r.id} size="md" ring={active} />
        <span class="flex-1 min-w-0 text-left text-sm font-ui text-on-surface truncate">{r.id}</span>
      </button>
    {/each}
  </div>
{/if}
