<script lang="ts">
  import { fetchHistory, type ReviewHistoryEntry } from "$lib/api";

  // Every reviewer's edits to this record, from the git history (dynamic - fetched
  // from the live endpoint, not the static snapshot). Lazy: loads on first open.
  let { hash }: { hash: string } = $props();

  let entries = $state<ReviewHistoryEntry[]>([]);
  let open = $state(false);
  let loading = $state(false);
  let loaded = $state(false);

  async function toggle() {
    open = !open;
    if (open && !loaded) {
      loading = true;
      try {
        entries = await fetchHistory(hash);
      } finally {
        loaded = true;
        loading = false;
      }
    }
  }

  function fmt(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleString("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
  }
</script>

<div class="font-ui text-xs">
  <button
    onclick={toggle}
    class="flex items-center gap-1 text-on-surface-secondary hover:text-on-surface
      cursor-pointer transition-colors"
    aria-expanded={open}
  >
    <span class="transition-transform {open ? 'rotate-90' : ''}">&rsaquo;</span>
    Review history{loaded && entries.length ? ` (${entries.length})` : ""}
  </button>
  {#if open}
    <div class="mt-1.5 pl-3 border-l border-border">
      {#if loading}
        <p class="text-on-surface-muted py-1">Loading...</p>
      {:else if entries.length === 0}
        <p class="text-on-surface-muted py-1">No review history yet.</p>
      {:else}
        <ul class="space-y-1.5">
          {#each entries as e}
            <li class="leading-snug">
              <div class="flex items-baseline gap-2">
                <span class="text-on-surface font-medium truncate">{e.by}</span>
                <span class="text-on-surface-muted tabular-nums flex-none">{fmt(e.at)}</span>
              </div>
              <div class="text-on-surface-secondary">{e.summary}</div>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>
