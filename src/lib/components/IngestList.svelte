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

<div>
  {#each ingests as ingest}
    <button
      class="w-full text-left px-6 py-3 border-b border-border/50 hover:bg-surface-alt transition-colors cursor-pointer"
      onclick={() => onselect(ingest.content_hash)}
    >
      <div class="flex items-baseline gap-2">
        <span class="text-xs font-ui font-medium text-primary uppercase w-12 flex-none">
          {typeLabels[ingest.source_type] ?? ingest.source_type}
        </span>
        <span class="text-xs text-on-surface-muted font-mono w-20 flex-none">{ingest.date}</span>
        <p class="text-sm text-on-surface truncate flex-1">{ingest.title}</p>
        {#if ingest.copyright_status === "public_domain"}
          <span class="text-xs font-ui text-success flex-none">public domain</span>
        {:else if ingest.copyright_status === "open_licence"}
          <span class="text-xs font-ui text-success flex-none">open licence</span>
        {:else if ingest.copyright_status === "publicly_accessible"}
          <span class="text-xs font-ui text-primary flex-none">publicly accessible</span>
        {:else if ingest.copyright_status === "restricted"}
          <span class="text-xs font-ui text-on-surface-muted flex-none">restricted</span>
        {/if}
      </div>
    </button>
  {/each}
</div>
