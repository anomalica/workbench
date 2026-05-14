<script lang="ts">
  import type { IngestSummary } from "$lib/api";

  type DateField = "published" | "ingested" | "reviewed";

  let {
    ingests,
    sortBy,
    sortAsc,
    reviewedHashes = new Set(),
    reviewedTimes = {},
    dateField = "published",
    onsort,
    ondatefield,
    onselect,
  }: {
    ingests: IngestSummary[];
    sortBy: string;
    sortAsc: boolean;
    reviewedHashes?: Set<string>;
    reviewedTimes?: Record<string, string>;
    dateField?: DateField;
    onsort: (field: string) => void;
    ondatefield?: (field: DateField) => void;
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

  const dateFieldLabels: Record<DateField, string> = {
    published: "Published",
    ingested: "Ingested",
    reviewed: "Reviewed",
  };

  function dateValueFor(ingest: IngestSummary): string {
    if (dateField === "ingested") return ingest.date_ingested || "";
    if (dateField === "reviewed") return reviewedTimes[ingest.content_hash] || "";
    return ingest.date || "";
  }

  let dateMenuOpen = $state(false);

  function handleDocClick(e: MouseEvent) {
    if (!dateMenuOpen) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("[data-date-menu]")) return;
    if (target?.closest('[data-date-menu-trigger="1"]')) return;
    dateMenuOpen = false;
  }

  $effect(() => {
    if (!dateMenuOpen) return;
    document.addEventListener("mousedown", handleDocClick);
    return () => document.removeEventListener("mousedown", handleDocClick);
  });

  function pickDateField(f: DateField) {
    dateMenuOpen = false;
    ondatefield?.(f);
  }
</script>

<!-- Column headers -->
<div class="flex items-center px-6 py-2 border-b border-border bg-surface-alt text-xs font-ui text-on-surface-muted select-none sticky top-0 z-10">
  <span class="w-6 flex-none" aria-hidden="true"></span>
  <button onclick={() => onsort("type")} class="w-12 flex-none cursor-pointer hover:text-on-surface text-left" title="Sort by type">
    Type {sortBy === "type" ? (sortAsc ? "▲" : "▼") : ""}
  </button>

  <!-- Date column: label-click toggles sort direction; chevron opens
       field-picker menu. Width is fixed but the menu is absolutely
       positioned so it can extend wider than the column. -->
  <div class="w-20 flex-none relative flex items-center">
    <button
      onclick={() => onsort("date")}
      class="cursor-pointer hover:text-on-surface text-left flex-1"
      title="Sort by {dateFieldLabels[dateField].toLowerCase()} date"
    >
      {dateFieldLabels[dateField]} {sortBy === "date" ? (sortAsc ? "▲" : "▼") : ""}
    </button>
    <button
      data-date-menu-trigger="1"
      onclick={(e) => { e.stopPropagation(); dateMenuOpen = !dateMenuOpen; }}
      class="cursor-pointer hover:text-on-surface px-1 -mr-1"
      title="Switch date field"
      aria-label="Switch date field"
    >
      <svg class="w-3 h-3 inline-block" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6" />
      </svg>
    </button>
    {#if dateMenuOpen}
      <div
        data-date-menu
        class="absolute top-full left-0 mt-1 min-w-32 z-20 bg-surface border border-border rounded shadow-lg py-1 normal-case"
      >
        {#each (["published", "ingested", "reviewed"] as DateField[]) as f}
          <button
            onclick={() => pickDateField(f)}
            class="w-full text-left text-xs font-ui px-3 py-1.5 hover:bg-surface-alt
              {dateField === f ? 'text-primary font-medium' : 'text-on-surface'}"
          >
            {dateFieldLabels[f]}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <button onclick={() => onsort("publisher")} class="w-28 flex-none cursor-pointer hover:text-on-surface text-left" title="Sort by publisher">
    Publisher {sortBy === "publisher" ? (sortAsc ? "▲" : "▼") : ""}
  </button>
  <button onclick={() => onsort("title")} class="flex-1 cursor-pointer hover:text-on-surface text-left pr-3" title="Sort by title">
    Title {sortBy === "title" ? (sortAsc ? "▲" : "▼") : ""}
  </button>
  <button onclick={() => onsort("author")} class="w-40 flex-none cursor-pointer hover:text-on-surface text-left" title="Sort by author">
    Author {sortBy === "author" ? (sortAsc ? "▲" : "▼") : ""}
  </button>
  <button onclick={() => onsort("copyright")} class="w-32 flex-none cursor-pointer hover:text-on-surface text-right" title="Sort by access">
    {sortBy === "copyright" ? (sortAsc ? "▲" : "▼") : ""} Access
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
        <span
          class="w-6 flex-none text-center text-sm leading-none"
          title={reviewedHashes.has(ingest.content_hash) ? "Reviewed" : "Not yet reviewed"}
        >
          {#if reviewedHashes.has(ingest.content_hash)}
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
