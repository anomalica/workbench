<script lang="ts">
  import { type IngestSummary, type ReviewPriority, provenanceOf, isPubliclyViewable } from "$lib/api";
  import { observedPercent } from "$lib/coverage";

  let {
    ingests,
    sortBy,
    sortAsc,
    reviewedHashes = new Set(),
    needsVerifyHashes = new Set(),
    reviewedTimes = {},
    priorities = {},
    dateField = "published",
    archived = false,
    onsort,
    onselect,
    onarchive,
    onunarchive,
    onfiltercreator,
    onfilterpublisher,
  }: {
    ingests: IngestSummary[];
    sortBy: string;
    sortAsc: boolean;
    reviewedHashes?: Set<string>;
    needsVerifyHashes?: Set<string>;
    reviewedTimes?: Record<string, string>;
    /** Where each unreviewed record sits in the review queue. Absent for a
     *  record that is reviewed, digested, or ranked before the queue loaded. */
    priorities?: Record<string, ReviewPriority>;
    dateField?: "published" | "ingested" | "reviewed";
    archived?: boolean;
    onsort: (field: string) => void;
    onselect: (hash: string) => void;
    onarchive?: (hash: string) => void;
    onunarchive?: (hash: string) => void;
    onfiltercreator?: (creator: string) => void;
    onfilterpublisher?: (publisher: string) => void;
  } = $props();

  /** Minutes as something a person reads at a glance. */
  function readMinutes(mins: number): string {
    if (mins < 1) return `${Math.max(10, Math.round(mins * 60 / 10) * 10)} sec`;
    if (mins < 90) return `${Math.round(mins)} min`;
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    return m ? `${h} hr ${m} min` : `${h} hr`;
  }

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
  <button onclick={() => onsort("type")} class="w-14 flex-none cursor-pointer hover:text-on-surface text-left" title="Sort by type">
    Type {sortBy === "type" ? (sortAsc ? "\u25B2" : "\u25BC") : ""}
  </button>
  <button onclick={() => onsort("date")} class="w-20 flex-none cursor-pointer hover:text-on-surface text-left" title="Sort by date">
    Date {sortBy === "date" ? (sortAsc ? "\u25B2" : "\u25BC") : ""}
  </button>
  <button onclick={() => onsort("publisher")} class="w-28 flex-none cursor-pointer hover:text-on-surface text-left" title="Sort by publisher">
    Publisher {sortBy === "publisher" ? (sortAsc ? "\u25B2" : "\u25BC") : ""}
  </button>
  <button onclick={() => onsort("copyright")} class="w-16 flex-none cursor-pointer hover:text-on-surface text-left" title="Sort by access (publicly viewable?)">
    Public {sortBy === "copyright" ? (sortAsc ? "\u25B2" : "\u25BC") : ""}
  </button>
  <button onclick={() => onsort("title")} class="flex-1 min-w-0 cursor-pointer hover:text-on-surface text-left" title="Sort by title">
    Title {sortBy === "title" ? (sortAsc ? "\u25B2" : "\u25BC") : ""}
  </button>
  <button onclick={() => onsort("creator")} class="w-36 flex-none cursor-pointer hover:text-on-surface text-left" title="Sort by creator">
    Authors / Creators {sortBy === "creator" ? (sortAsc ? "\u25B2" : "\u25BC") : ""}
  </button>
  <button
    onclick={() => onsort("priority")}
    class="w-32 flex-none cursor-pointer hover:text-on-surface text-left"
    title="Sort by what reading it is worth: entities it would feed, per minute of reading"
  >
    Worth {sortBy === "priority" ? (sortAsc ? "\u25B2" : "\u25BC") : ""}
  </button>
  <button onclick={() => onsort("digestible")} class="w-28 flex-none cursor-pointer hover:text-on-surface text-left" title="Sort by review coverage of the ingest (digestible at 100%)">
    Reviewed {sortBy === "digestible" ? (sortAsc ? "\u25B2" : "\u25BC") : ""}
  </button>
  <button onclick={() => onsort("digested")} class="w-20 flex-none cursor-pointer hover:text-on-surface text-left" title="Sort by whether a digest has been built">
    Digested {sortBy === "digested" ? (sortAsc ? "\u25B2" : "\u25BC") : ""}
  </button>
  <!-- Matches the archive/restore button cell in each row, so header labels
       sit exactly over their column values. -->
  <span class="w-8 flex-none" aria-hidden="true"></span>
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
        <span class="text-xs font-ui font-medium text-primary uppercase w-14 flex-none">
          {typeLabels[ingest.document_type || ingest.source_type] ?? (ingest.document_type || ingest.source_type)}
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
        <span
          class="w-16 flex-none text-xs font-ui {isPubliclyViewable(ingest.copyright_status) ? 'text-success' : 'text-on-surface-muted'}"
          title={copyrightLabels[ingest.copyright_status] ?? ingest.copyright_status}
        >
          {isPubliclyViewable(ingest.copyright_status) ? "Yes" : "No"}
        </span>
        <div class="flex items-baseline gap-1.5 flex-1 min-w-0">
          {#if !provenanceOf(ingest).traceable}
            <span class="text-warning flex-none" title="Untraceable: no recoverable source/origin">&#9888;</span>
          {/if}
          <span class="text-sm text-on-surface truncate">{ingest.title}</span>
          {#if ingest.pipeline_version != null && ingest.pipeline_current != null && ingest.pipeline_version < ingest.pipeline_current}
            <span
              class="flex-none text-[10px] font-ui font-medium px-1.5 py-0.5 rounded bg-warning-container/40 text-on-warning-container tabular-nums"
              title="Extraction is behind the current pipeline (v{ingest.pipeline_version} of {ingest.pipeline_current}) - pending re-ingest"
            >outdated v{ingest.pipeline_version}/{ingest.pipeline_current}</span>
          {/if}
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
        {@render worth(priorities[ingest.content_hash])}
        <span
          class="w-28 flex-none flex items-center gap-1.5"
          title={`${observedPercent(ingest.observed_coverage)}% observed${ingest.digestible ? " - digestible" : " - not yet digestible"}`}
        >
          <span class="flex-1 h-1.5 rounded-full bg-border overflow-hidden">
            <span
              class="block h-full rounded-full transition-all {ingest.digestible ? 'bg-success' : 'bg-primary'}"
              style="width:{observedPercent(ingest.observed_coverage)}%"
            ></span>
          </span>
          <span
            class="w-9 flex-none text-right text-xs font-ui tabular-nums
              {ingest.digestible ? 'font-medium text-success' : 'text-on-surface-muted'}"
          >
            {observedPercent(ingest.observed_coverage)}%
          </span>
        </span>
        <span class="w-20 flex-none text-xs font-ui">
          {#if ingest.digested && !ingest.digestible}
            <span
              class="font-medium text-warning"
              title="Digested under the old gate before review sign-off - review it, then re-digest"
            >Yes</span>
          {:else if ingest.digested}
            <span class="text-on-surface" title="A digest has been built">Yes</span>
          {:else if ingest.digestible}
            <span class="font-medium text-primary" title="Fully reviewed - ready for the digester; no digest built yet">Ready</span>
          {:else}
            <span class="text-on-surface-muted" title="Not digested">No</span>
          {/if}
        </span>
        {#if archived && onunarchive}
          <button
            onclick={(e) => { e.stopPropagation(); onunarchive(ingest.content_hash); }}
            class="flex-none w-8 h-8 flex items-center justify-center rounded
              hover:bg-surface text-on-surface-muted hover:text-on-surface transition-colors cursor-pointer"
            title="Restore from archive"
          >&#x21B6;</button>
        {:else if !archived && onarchive}
          <button
            onclick={(e) => { e.stopPropagation(); onarchive(ingest.content_hash); }}
            class="flex-none w-8 h-8 flex items-center justify-center rounded
              hover:bg-surface text-on-surface-muted hover:text-warning transition-colors cursor-pointer"
            title="Archive"
          ><svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"/></svg></button>
        {/if}
      </div>
    </div>
  {/each}
</div>

{#snippet worth(p: ReviewPriority | undefined)}
  <!-- What this record is worth reading next, in the two numbers that decide
       it: how many page-worthy entities it would feed, and how long it takes.
       Blank for anything already reviewed or digested - those are not in the
       queue, and a number there would invite reading them again. -->
  <span class="w-32 flex-none text-xs font-ui">
    {#if !p}
      <span class="text-on-surface-muted/30">&mdash;</span>
    {:else if p.housekeeping_open}
      <span
        class="text-warning"
        title="{p.housekeeping_open} housekeeping proposal{p.housekeeping_open === 1 ? '' : 's'} still open - its metadata may change under the review"
      >on hold</span>
    {:else if p.reach === 0}
      <span class="text-on-surface-muted" title="Feeds no page that already exists">
        {readMinutes(p.minutes)}
      </span>
    {:else}
      <!-- Spelled out. It read "9 · 2.9m", where the m looked like millions and
           the bare 9 said nothing at all. The units are the whole point of the
           column: what it gives, and what it costs. -->
      <span
        class="text-on-surface"
        title={`Feeds ${p.reach} page${p.reach === 1 ? "" : "s"} that already exist${p.high_bar ? ` (${p.high_bar} high-bar)` : ""}.\n\n${p.unlocks.join("\n")}`}
      >
        <span class="font-medium text-primary tabular-nums">{p.reach}</span>
        <span class="text-on-surface-muted">{p.reach === 1 ? "page" : "pages"}</span>
        <span class="text-on-surface-muted/60">&middot;</span>
        <span class="text-on-surface-muted">{readMinutes(p.minutes)}</span>
      </span>
    {/if}
  </span>
{/snippet}
