<script lang="ts">
  import type { IngestSummary } from "$lib/api";

  let {
    ingests,
    onselect,
  }: {
    ingests: IngestSummary[];
    onselect: (hash: string) => void;
  } = $props();

  const typeLabels: Record<string, string> = {
    pdf: "PDF",
    web: "Web",
    audio: "Audio",
    video: "Video",
  };
</script>

<div class="space-y-1">
  {#each ingests as ingest}
    <button
      class="w-full text-left px-4 py-3 rounded hover:bg-surface-alt transition-colors cursor-pointer"
      onclick={() => onselect(ingest.content_hash)}
    >
      <div class="flex items-baseline gap-2">
        <span class="text-xs font-ui font-medium text-primary uppercase">
          {typeLabels[ingest.source_type] ?? ingest.source_type}
        </span>
        <span class="text-xs text-on-surface-muted">{ingest.date}</span>
      </div>
      <p class="text-sm text-on-surface mt-0.5 line-clamp-2">{ingest.title}</p>
    </button>
  {/each}
</div>
