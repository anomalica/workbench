<script lang="ts">
  import type { IngestSummary } from "$lib/api";

  let {
    ingests,
    sortBy,
    sortAsc,
    onsort,
    onselect,
  }: {
    ingests: IngestSummary[];
    sortBy: string;
    sortAsc: boolean;
    onsort: (field: string) => void;
    onselect: (hash: string) => void;
  } = $props();

  const typeLabels: Record<string, string> = {
    pdf: "PDF",
    web: "Web",
    audio: "Audio",
    video: "Video",
  };

  const copyrightLabels: Record<string, string> = {
    public_domain: "public domain",
    open_licence: "open licence",
    publicly_accessible: "publicly accessible",
    restricted: "restricted",
  };

  const copyrightColours: Record<string, string> = {
    public_domain: "text-success",
    open_licence: "text-success",
    publicly_accessible: "text-primary",
    restricted: "text-on-surface-muted",
  };
</script>

<!-- Column headers -->
<div class="flex items-center px-6 py-2 border-b border-border bg-surface-alt text-xs font-ui text-on-surface-muted select-none sticky top-0 z-10">
  <button onclick={() => onsort("type")} class="w-12 flex-none cursor-pointer hover:text-on-surface text-left" title="Sort by type">
    Type {sortBy === "type" ? (sortAsc ? "\u25B2" : "\u25BC") : ""}
  </button>
  <button onclick={() => onsort("date")} class="w-20 flex-none cursor-pointer hover:text-on-surface text-left" title="Sort by date">
    Date {sortBy === "date" ? (sortAsc ? "\u25B2" : "\u25BC") : ""}
  </button>
  <button onclick={() => onsort("publisher")} class="w-28 flex-none cursor-pointer hover:text-on-surface text-left" title="Sort by publisher">
    Publisher {sortBy === "publisher" ? (sortAsc ? "\u25B2" : "\u25BC") : ""}
  </button>
  <button onclick={() => onsort("title")} class="flex-1 cursor-pointer hover:text-on-surface text-left pr-3" title="Sort by title">
    Title {sortBy === "title" ? (sortAsc ? "\u25B2" : "\u25BC") : ""}
  </button>
  <button onclick={() => onsort("author")} class="w-40 flex-none cursor-pointer hover:text-on-surface text-left" title="Sort by author">
    Author {sortBy === "author" ? (sortAsc ? "\u25B2" : "\u25BC") : ""}
  </button>
  <button onclick={() => onsort("copyright")} class="w-32 flex-none cursor-pointer hover:text-on-surface text-right" title="Sort by access">
    {sortBy === "copyright" ? (sortAsc ? "\u25B2" : "\u25BC") : ""} Access
  </button>
</div>

<!-- Rows -->
<div>
  {#each ingests as ingest}
    <button
      class="w-full text-left px-6 py-2.5 border-b border-border/50 hover:bg-surface-alt transition-colors cursor-pointer"
      onclick={() => onselect(ingest.content_hash)}
    >
      <div class="flex items-baseline gap-0">
        <span class="text-xs font-ui font-medium text-primary uppercase w-12 flex-none">
          {typeLabels[ingest.source_type] ?? ingest.source_type}
        </span>
        <span class="text-xs text-on-surface-muted font-mono w-20 flex-none">{ingest.date}</span>
        <span class="text-xs text-on-surface-secondary w-28 flex-none truncate">
          {ingest.publisher || ""}
        </span>
        <p class="text-sm text-on-surface truncate flex-1 pr-3">{ingest.title}</p>
        <span class="text-xs text-on-surface-secondary w-40 flex-none truncate">
          {ingest.authors?.join(", ") ?? ""}
        </span>
        <span class="text-xs font-ui w-32 flex-none text-right {copyrightColours[ingest.copyright_status] ?? 'text-on-surface-muted'}">
          {copyrightLabels[ingest.copyright_status] ?? ingest.copyright_status}
        </span>
      </div>
    </button>
  {/each}
</div>
