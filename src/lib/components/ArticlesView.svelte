<script lang="ts">
  import { fetchArticles, type Article } from "$lib/api";

  // Read-only listing of the assembled knowledge-article pages (the public,
  // post-digest content layer). Entity articles link to the live site; records
  // additionally offer an in-app deep-link to the workbench's richer record view
  // via their record_hash. There is no editing here - directive authoring waits
  // on the assembler's preserve-on-regen + consume work (a written directive
  // would be wiped on the next reassembly today).
  let { onOpenRecord }: { onOpenRecord?: (recordHash: string) => void } = $props();

  let articles = $state<Article[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Reading order for the entity sections; records last (provenance class).
  const SECTION_ORDER = [
    "people",
    "organisations",
    "events",
    "objects",
    "concepts",
    "matters",
    "documents",
    "records",
  ];
  const SECTION_LABEL: Record<string, string> = {
    people: "People",
    organisations: "Organisations",
    events: "Events",
    objects: "Objects",
    concepts: "Concepts",
    matters: "Matters",
    documents: "Documents",
    records: "Records",
  };

  function label(section: string): string {
    return SECTION_LABEL[section] ?? section.charAt(0).toUpperCase() + section.slice(1);
  }

  // Group into sections in reading order; any unknown section is appended A-Z.
  let grouped = $derived.by(() => {
    const by = new Map<string, Article[]>();
    for (const a of articles) {
      const list = by.get(a.section) ?? [];
      list.push(a);
      by.set(a.section, list);
    }
    const known = SECTION_ORDER.filter((s) => by.has(s));
    const extra = [...by.keys()].filter((s) => !SECTION_ORDER.includes(s)).sort();
    return [...known, ...extra].map((section) => ({
      section,
      items: (by.get(section) ?? []).slice().sort((a, b) => a.title.localeCompare(b.title)),
    }));
  });

  fetchArticles()
    .then((a) => {
      articles = a;
    })
    .catch((e) => {
      error = e instanceof Error ? e.message : String(e);
    })
    .finally(() => {
      loading = false;
    });
</script>

<div class="flex-1 flex flex-col min-h-0">
  <div class="px-6 py-2 border-b border-border bg-surface-alt flex items-center gap-3 flex-none">
    <h1 class="text-sm font-ui font-medium text-on-surface">Articles</h1>
    {#if !loading}
      <span class="text-xs font-ui text-on-surface-muted tabular-nums">
        {articles.length} assembled {articles.length === 1 ? "page" : "pages"}
      </span>
    {/if}
    <span class="flex-1"></span>
    {#if error}<span class="text-xs font-ui text-error">{error}</span>{/if}
  </div>

  <div class="flex-1 overflow-auto">
    {#if loading}
      <p class="px-6 py-6 text-sm text-on-surface-muted">Loading...</p>
    {:else if articles.length === 0}
      <div class="max-w-3xl mx-auto px-6 py-10 text-center text-on-surface-muted">
        <p class="text-sm">
          No assembled articles yet. The assembler builds these from reviewed records;
          they appear here once an assembly run has produced pages.
        </p>
      </div>
    {:else}
      <div class="max-w-3xl mx-auto px-6 py-6 space-y-8">
        <p class="text-sm text-on-surface-secondary">
          Assembled knowledge pages (read-only). Titles open the public site in a new tab;
          record pages also link to the workbench's own inspection view.
        </p>

        {#each grouped as g (g.section)}
          <section>
            <h2 class="text-xs font-ui uppercase tracking-wide text-on-surface-muted mb-1.5">
              {label(g.section)}
              <span class="text-on-surface-muted/70">({g.items.length})</span>
            </h2>
            <ul class="rounded-lg border border-border bg-surface divide-y divide-border">
              {#each g.items as a (a.section + "/" + a.slug)}
                <li class="px-4 py-3">
                  <div class="flex items-baseline justify-between gap-3">
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="text-on-surface font-medium hover:text-primary transition-colors truncate"
                    >
                      {a.title}
                    </a>
                    {#if a.record_hash && onOpenRecord}
                      <button
                        onclick={() => onOpenRecord?.(a.record_hash!)}
                        class="text-xs font-ui text-on-surface-muted hover:text-primary
                          flex-none cursor-pointer transition-colors whitespace-nowrap"
                        title="Open this record in the workbench review view"
                      >
                        Inspect record &rsaquo;
                      </button>
                    {/if}
                  </div>
                  {#if a.description}
                    <p class="text-sm text-on-surface-secondary mt-0.5 line-clamp-2">
                      {a.description}
                    </p>
                  {/if}
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      </div>
    {/if}
  </div>
</div>
