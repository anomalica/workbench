<script lang="ts">
  import { computeDiff } from "$lib/document.svelte";

  let {
    original,
    modified,
  }: {
    original: string;
    modified: string;
  } = $props();

  let lines = $derived(computeDiff(original, modified));
  let hasChanges = $derived(lines.some((l) => l.type !== "same"));
</script>

{#if !hasChanges}
  <div class="p-4 text-sm text-on-surface-muted text-center">No changes</div>
{:else}
  <div class="font-mono text-xs leading-relaxed">
    {#each lines as line}
      {#if line.text === "..."}
        <div class="px-4 py-1 text-on-surface-muted bg-surface-alt border-y border-border/30">...</div>
      {:else if line.type === "remove"}
        <div class="px-4 py-0.5 bg-error-container/40 text-on-error-container">
          <span class="select-none mr-2 text-error/60">-</span>{line.text}
        </div>
      {:else if line.type === "add"}
        <div class="px-4 py-0.5 bg-success-container/40 text-on-success-container">
          <span class="select-none mr-2 text-success/60">+</span>{line.text}
        </div>
      {:else}
        <div class="px-4 py-0.5 text-on-surface-muted">
          <span class="select-none mr-2">&nbsp;</span>{line.text}
        </div>
      {/if}
    {/each}
  </div>
{/if}
