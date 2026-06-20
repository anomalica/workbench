<script lang="ts">
  import { type IngestSummary, provenanceOf, isPubliclyViewable } from "$lib/api";
  import { observedPercent } from "$lib/coverage";

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
</script>

<!-- Column headers -->
<div class="flex items-center gap-3 px-6 py-2 border-b border-border bg-surface-alt text-xs font-ui text-on-surface-muted select-none sticky top-0 z-10">
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
  <button onclick={() => onsort("title")} class="flex-1 min-w-0 cursor-pointer hover:text-on-surface text-left" title="Sort by title">
    Title {sortBy === "title" ? (sortAsc ? "\u25B2" : "\u25BC") : ""}
  </button>
  <button onclick={() => onsort("creator")} class="w-36 flex-none cursor-pointer hover:text-on-surface text-left" title="Sort by creator">
    Authors / Creators {sortBy === "creator" ? (sortAsc ? "\u25B2" : "\u25BC") : ""}
  </button>
  <button onclick={() => onsort("digestible")} class="w-28 flex-none cursor-pointer hover:text-on-surface text-left" title="Sort by digestibility (how much has been observed)">
    Digestible {sortBy === "digestible" ? (sortAsc ? "\u25B2" : "\u25BC") : ""}
  </button>
  <button onclick={() => onsort("digested")} class="w-20 flex-none cursor-pointer hover:text-on-surface text-left" title="Sort by whether a digest has been built">
    Digested {sortBy === "digested" ? (sortAsc ? "\u25B2" : "\u25BC") : ""}
  </button>
  <button onclick={() => onsort("copyright")} class="w-16 flex-none cursor-pointer hover:text-on-surface text-left" title="Sort by access (publicly viewable?)">
    Public {sortBy === "copyright" ? (sortAsc ? "\u25B2" : "\u25BC") : ""}
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
      <div class="flex items-baseline gap-3">
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
        <div class="flex items-baseline gap-1.5 flex-1 min-w-0">
          {#if !provenanceOf(ingest).traceable}
            <span class="text-warning flex-none" title="Untraceable: no recoverable source/origin">&#9888;</span>
          {/if}
          <span class="text-sm text-on-surface truncate">{ingest.title}</span>
        </div>
        <span class="text-xs text-on-surface-secondary w-36 flex-none truncate">
          {#each ingest.creators ?? [] as creator, idx}
            <button
              onclick={(e) => { e.stopPropagation(); onfiltercreator?.(creator); }}
              class="inline hover:text-primary hover:underline cursor-pointer"
              title={`Show only ${creator}`}
            >{creator}</button>{#if idx < ingest.creators.length - 1}, {/if}
          {/each}
        </span>
        <span
          class="w-28 flex-none flex items-center"
          title={`${observedPercent(ingest.observed_coverage)}% observed${ingest.digestible ? " - digestible" : " - not yet digestible"}`}
        >
          <span class="flex-1 h-1.5 rounded-full bg-border overflow-hidden">
            <span
              class="block h-full rounded-full transition-all {ingest.digestible ? 'bg-success' : 'bg-primary'}"
              style="width:{observedPercent(ingest.observed_coverage)}%"
            ></span>
          </span>
        </span>
        <span class="w-20 flex-none text-xs font-ui">
          {#if ingest.digested}
            <span class="text-on-surface" title="A digest has been built">Yes</span>
          {:else if ingest.digestible}
            <span class="font-medium text-primary" title="Digestible but not yet digested">No</span>
          {:else}
            <span class="text-on-surface-muted" title="Not digested">No</span>
          {/if}
        </span>
        <span
          class="w-16 flex-none text-xs font-ui {isPubliclyViewable(ingest.copyright_status) ? 'text-success' : 'text-on-surface-muted'}"
          title={copyrightLabels[ingest.copyright_status] ?? ingest.copyright_status}
        >
          {isPubliclyViewable(ingest.copyright_status) ? "Yes" : "No"}
        </span>
      </div>
    </div>
  {/each}
</div>
