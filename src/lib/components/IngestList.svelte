<script lang="ts">
  import type { IngestSummary } from "$lib/api";

  let {
    ingests,
    sortBy,
    sortAsc,
    reviewedHashes = new Set(),
    needsVerifyHashes = new Set(),
    reviewedTimes = {},
    dateField = "published",
    onsort,
    onselect,
    onfiltercreator,
    onfilterpublisher,
  }: {
    ingests: IngestSummary[];
    sortBy: string;
    sortAsc: boolean;
    reviewedHashes?: Set<string>;
    needsVerifyHashes?: Set<string>;
    reviewedTimes?: Record<string, string>;
    dateField?: "published" | "ingested" | "reviewed";
    onsort: (field: string) => void;
    onselect: (hash: string) => void;
    onfiltercreator?: (creator: string) => void;
    onfilterpublisher?: (publisher: string) => void;
  } = $props();

  function dateValueFor(i: IngestSummary): string {
    if (dateField === "ingested") return i.date_ingested || "";
    if (dateField === "reviewed") return reviewedTimes[i.content_hash] || "";
    return i.date || "";
  }

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
  <span class="w-6 flex-none" aria-hidden="true"></span>
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
  <button onclick={() => onsort("creator")} class="w-40 flex-none cursor-pointer hover:text-on-surface text-left" title="Sort by creator">
    Authors / Creators {sortBy === "creator" ? (sortAsc ? "\u25B2" : "\u25BC") : ""}
  </button>
  <button onclick={() => onsort("copyright")} class="w-32 flex-none cursor-pointer hover:text-on-surface text-right" title="Sort by access">
    {sortBy === "copyright" ? (sortAsc ? "\u25B2" : "\u25BC") : ""} Access
  </button>
</div>

<!-- Rows. The row is a role="button" div (not a <button>) so the publisher and
     creator values inside it can be their own click-to-filter buttons. -->
<div>
  {#each ingests as ingest}
    <div
      role="button"
      tabindex="0"
      class="w-full text-left px-6 py-2.5 border-b border-border/50 hover:bg-surface-alt transition-colors cursor-pointer"
      onclick={() => onselect(ingest.content_hash)}
      onkeydown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onselect(ingest.content_hash);
        }
      }}
    >
      <div class="flex items-baseline gap-0">
        <span
          class="w-6 flex-none text-center text-sm leading-none"
          title={needsVerifyHashes.has(ingest.content_hash)
            ? "Review carried over - verify"
            : reviewedHashes.has(ingest.content_hash)
              ? "Reviewed"
              : "Not yet reviewed"}
        >
          {#if needsVerifyHashes.has(ingest.content_hash)}
            <span class="text-warning" aria-label="Carried over - verify">&#x21bb;</span>
          {:else if reviewedHashes.has(ingest.content_hash)}
            <span class="text-success" aria-label="Reviewed">&#x2713;</span>
          {:else}
            <span class="text-on-surface-muted/40" aria-label="Not yet reviewed">&#x2022;</span>
          {/if}
        </span>
        <span class="text-xs font-ui font-medium text-primary uppercase w-12 flex-none">
          {typeLabels[ingest.source_type] ?? ingest.source_type}
        </span>
        <span
          class="text-xs text-on-surface-muted font-mono w-20 flex-none"
          title={dateValueFor(ingest) || "no value"}
        >
          {dateValueFor(ingest).slice(0, 10) || "—"}
        </span>
        <span class="text-xs text-on-surface-secondary w-28 flex-none truncate">
          {#if ingest.publisher}
            <button
              onclick={(e) => { e.stopPropagation(); onfilterpublisher?.(ingest.publisher); }}
              class="inline hover:text-primary hover:underline cursor-pointer"
              title={`Show only ${ingest.publisher}`}
            >{ingest.publisher}</button>
          {/if}
        </span>
        <p class="text-sm text-on-surface truncate flex-1 pr-3">{ingest.title}</p>
        <span class="text-xs text-on-surface-secondary w-40 flex-none truncate">
          {#each ingest.creators ?? [] as creator, idx}
            <button
              onclick={(e) => { e.stopPropagation(); onfiltercreator?.(creator); }}
              class="inline hover:text-primary hover:underline cursor-pointer"
              title={`Show only ${creator}`}
            >{creator}</button>{#if idx < ingest.creators.length - 1}, {/if}
          {/each}
        </span>
        <span class="text-xs font-ui w-32 flex-none text-right {copyrightColours[ingest.copyright_status] ?? 'text-on-surface-muted'}">
          {copyrightLabels[ingest.copyright_status] ?? ingest.copyright_status}
        </span>
      </div>
    </div>
  {/each}
</div>
