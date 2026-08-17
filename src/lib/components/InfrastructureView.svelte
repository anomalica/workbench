<script lang="ts">
  /**
   * The infrastructure half of the corpus, which nothing has ever read.
   *
   * Every extraction splits in two: what the record says about the world, and
   * what it says about the world's paperwork - who wrote which book, who cited
   * whom, which article ran where. The second half has gone into its own
   * database since the pipeline was built and no consumer has ever opened it.
   *
   * Read as a claim list it looks like debris. Followed through its node
   * references it is a bibliography: 800 works, and the corpus holds 25 of
   * them. So works are the spine of this view rather than claims, and the
   * shelf-check is on every row - the interesting question about a named work
   * is whether we have it.
   */
  import { onMount } from "svelte";
  import {
    fetchInfrastructure,
    fetchInfrastructureEntities,
    fetchInfrastructureEntity,
    fetchInfrastructureClaims,
    type InfrastructureSummary,
    type InfrastructureEntity,
    type InfrastructureEntityDetail,
    type InfrastructureClaim,
    type InfrastructureRecord,
  } from "$lib/api";

  let { onopenrecord }: { onopenrecord?: (publicHash: string) => void } = $props();

  type Tab = "document" | "person" | "organisation" | "claims";

  const TABS: { id: Tab; label: string; blurb: string }[] = [
    { id: "document", label: "Works", blurb: "Books, articles, films and documents the sources name" },
    { id: "person", label: "People", blurb: "Authors, researchers and witnesses named as sources" },
    { id: "organisation", label: "Organisations", blurb: "Publishers, agencies and institutions" },
    { id: "claims", label: "Claims", blurb: "The raw extraction, before it is followed into a graph" },
  ];

  let summary = $state<InfrastructureSummary | null>(null);
  let sourceRecords = $state<InfrastructureRecord[]>([]);
  let unavailable = $state(false);
  let booted = $state(false);
  let tab = $state<Tab>("document");
  let query = $state("");
  let heldFilter = $state<"all" | "held" | "missing">("all");
  let claimType = $state("");

  let entities = $state<InfrastructureEntity[]>([]);
  let claims = $state<InfrastructureClaim[]>([]);
  let loading = $state(false);
  let selectedId = $state<string | null>(null);
  let selected = $state<InfrastructureEntityDetail | null>(null);
  let loadingDetail = $state(false);

  const KIND_LABEL: Record<string, string> = {
    document: "work",
    person: "person",
    organisation: "organisation",
    event: "event",
    place: "place",
    topic: "topic",
    object: "object",
    project: "project",
  };

  /** Works the corpus does not hold are the whole point of the shelf-check, so
   *  the filter is on the browse list rather than buried in the detail. */
  let shown = $derived(
    heldFilter === "all"
      ? entities
      : entities.filter((e) => (heldFilter === "held" ? e.held : !e.held)),
  );

  let missingCount = $derived(summary ? summary.works_named - summary.works_held : 0);

  /** How many connections to show before asking. Forty chips above the claims
   *  pushed the reading below the fold; a dozen is an index, the rest is a
   *  list. */
  const CONNECTIONS_SHOWN = 14;
  let allConnections = $state(false);
  let connections = $derived(
    !selected
      ? []
      : allConnections
        ? selected.connected
        : selected.connected.slice(0, CONNECTIONS_SHOWN),
  );

  async function loadList() {
    loading = true;
    try {
      if (tab === "claims") {
        claims = await fetchInfrastructureClaims(claimType, query);
      } else {
        entities = await fetchInfrastructureEntities(tab, query);
      }
    } finally {
      loading = false;
    }
  }

  async function select(id: string) {
    selectedId = id;
    allConnections = false;
    loadingDetail = true;
    try {
      selected = await fetchInfrastructureEntity(id);
    } finally {
      loadingDetail = false;
    }
  }

  function switchTab(next: Tab) {
    if (tab === next) return;
    tab = next;
    query = "";
    selectedId = null;
    selected = null;
    if (next !== "document") heldFilter = "all";
    loadList();
  }

  /** Jump to a connected entity, following the citation graph the way a
   *  bibliography is actually read - work to author to their other works. */
  function follow(id: string, kind: string) {
    if (kind !== tab && (kind === "document" || kind === "person" || kind === "organisation")) {
      tab = kind;
      query = "";
      loadList();
    }
    select(id);
  }

  onMount(async () => {
    const page = await fetchInfrastructure();
    summary = page.summary;
    sourceRecords = page.records;
    unavailable = page.summary === null;
    booted = true;
    if (!unavailable) await loadList();
  });

  let debounce: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const _q = query;
    const _t = claimType;
    if (!booted || unavailable) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => loadList(), 180);
  });

  /** Claims read best gathered under the record they came from - that is the
   *  unit a reviewer can go and check. */
  let claimsByRecord = $derived.by(() => {
    const groups = new Map<string, { title: string; hash: string | null; claims: InfrastructureClaim[] }>();
    for (const c of claims) {
      const key = c.record_hash ?? c.record_title ?? "?";
      const group = groups.get(key);
      if (group) group.claims.push(c);
      else groups.set(key, { title: c.record_title ?? "Unattributed", hash: c.record_hash, claims: [c] });
    }
    return [...groups.values()];
  });

  const openRecord = (hash: string | null) => {
    if (hash) onopenrecord?.(hash.slice(0, 56));
  };

  /** In the claims view the left pane is an index into one long reading, not a
   *  set of destinations - clicking a record moves to its section rather than
   *  leaving the tab. */
  function jumpTo(key: string) {
    document
      .getElementById(`infra-rec-${key}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
</script>

{#if unavailable}
  <div class="flex-1 flex flex-col items-center justify-center gap-2 text-on-surface-muted px-6 text-center">
    <p class="text-sm font-ui">The infrastructure database hasn't been built yet.</p>
    <p class="text-xs">
      The assimilator writes it on import; no database at the configured path
      (INFRASTRUCTURE_DB_PATH).
    </p>
  </div>
{:else}
  <!-- What this is. Nobody has seen this data before, so the view says what it
       holds before it shows any of it. -->
  {#if summary}
    <div class="px-6 py-3 border-b border-border bg-surface-alt flex-none">
      <p class="text-xs font-ui text-on-surface-secondary max-w-3xl leading-relaxed">
        What the corpus's sources say about their own sources - who wrote what, who cited
        whom. Extracted alongside every record and kept apart from the claims that become
        articles.
      </p>
      <div class="flex items-baseline gap-x-6 gap-y-1 flex-wrap mt-2.5">
        <div class="flex items-baseline gap-1.5">
          <span class="text-lg font-medium text-on-surface tabular-nums">{summary.works_named}</span>
          <span class="text-xs font-ui text-on-surface-secondary">works named</span>
        </div>
        <button
          onclick={() => { switchTab("document"); heldFilter = "missing"; }}
          class="flex items-baseline gap-1.5 px-2 py-0.5 -mx-2 rounded cursor-pointer transition-colors hover:bg-surface"
          title="Works the corpus names but does not hold - the reading list its own material assembled"
        >
          <span class="text-lg font-medium text-amber-600 dark:text-amber-400 tabular-nums">{missingCount}</span>
          <span class="text-xs font-ui text-on-surface-secondary">not in the corpus</span>
        </button>
        <div class="flex items-baseline gap-1.5">
          <span class="text-lg font-medium text-on-surface tabular-nums">{summary.entities.person}</span>
          <span class="text-xs font-ui text-on-surface-secondary">people</span>
        </div>
        <div class="flex items-baseline gap-1.5">
          <span class="text-lg font-medium text-on-surface tabular-nums">{summary.entities.organisation}</span>
          <span class="text-xs font-ui text-on-surface-secondary">organisations</span>
        </div>
        <div class="flex items-baseline gap-1.5">
          <span class="text-lg font-medium text-on-surface tabular-nums">{summary.claims}</span>
          <span class="text-xs font-ui text-on-surface-secondary">claims</span>
        </div>
        <div class="flex items-baseline gap-1.5">
          <span class="text-lg font-medium text-on-surface tabular-nums">{summary.records}</span>
          <span class="text-xs font-ui text-on-surface-secondary">records digested</span>
        </div>
      </div>
    </div>
  {/if}

  <div class="px-6 py-1.5 border-b border-border flex items-center gap-1 flex-none font-ui">
    {#each TABS as t}
      <button
        onclick={() => switchTab(t.id)}
        title={t.blurb}
        class="text-xs px-2.5 py-1 rounded cursor-pointer transition-colors
          {tab === t.id
          ? 'bg-primary/15 text-primary font-medium'
          : 'text-on-surface-secondary hover:bg-surface-alt'}"
      >{t.label}</button>
    {/each}
  </div>

  <div class="flex-1 flex min-h-0">
    <!-- Index -->
    <div class="w-96 flex-none border-r border-border flex flex-col min-h-0">
      <div class="px-3 py-2 border-b border-border flex-none space-y-2">
        <input
          type="search"
          placeholder={tab === "claims" ? "Search claims and records..." : `Search ${TABS.find((t) => t.id === tab)?.label.toLowerCase()}...`}
          bind:value={query}
          class="w-full text-sm bg-surface border border-border rounded px-3 py-1.5
            text-on-surface outline-none focus:border-primary placeholder:text-on-surface-muted/60"
        />
        {#if tab === "document"}
          <div class="flex items-center gap-1">
            {#each [["all", "All"], ["missing", "Not held"], ["held", "In the corpus"]] as [id, label]}
              <button
                onclick={() => { heldFilter = id as typeof heldFilter; }}
                class="text-[11px] px-2 py-0.5 rounded cursor-pointer font-ui transition-colors
                  {heldFilter === id ? 'bg-primary text-on-primary' : 'text-on-surface-secondary hover:bg-surface-alt'}"
              >{label}</button>
            {/each}
          </div>
        {:else if tab === "claims" && summary}
          <!-- The type split is the one judgement worth exposing: administrative
               is what a bibliography is made of, and everything else was typed
               as something the extraction usually reserves for domain claims. -->
          <div class="flex items-center gap-1 flex-wrap">
            <button
              onclick={() => { claimType = ""; }}
              class="text-[11px] px-2 py-0.5 rounded cursor-pointer font-ui transition-colors
                {claimType === '' ? 'bg-primary text-on-primary' : 'text-on-surface-secondary hover:bg-surface-alt'}"
            >All <span class="tabular-nums opacity-70">{summary.claims}</span></button>
            {#each summary.by_type as t}
              <button
                onclick={() => { claimType = t.type; }}
                class="text-[11px] px-2 py-0.5 rounded cursor-pointer font-ui transition-colors
                  {claimType === t.type ? 'bg-primary text-on-primary' : 'text-on-surface-secondary hover:bg-surface-alt'}"
              >{t.type} <span class="tabular-nums opacity-70">{t.count}</span></button>
            {/each}
          </div>
        {/if}
      </div>

      <div class="flex-1 overflow-auto">
        {#if loading && !entities.length && !claims.length}
          <p class="text-on-surface-muted text-sm p-4 font-ui">Loading...</p>
        {:else if tab === "claims"}
          <p class="text-[11px] font-ui text-on-surface-muted px-3 py-2 leading-snug">
            {claims.length} claim{claims.length === 1 ? "" : "s"}{claimType
              ? ` typed ${claimType}`
              : ""} across {claimsByRecord.length} record{claimsByRecord.length === 1 ? "" : "s"}.
          </p>
          {#each claimsByRecord as group}
            <button
              onclick={() => jumpTo(group.hash ?? group.title)}
              class="w-full text-left px-3 py-2 border-b border-border/40 hover:bg-surface-alt
                transition-colors cursor-pointer"
            >
              <div class="text-sm text-on-surface truncate">{group.title}</div>
              <div class="text-[11px] font-ui text-on-surface-muted tabular-nums mt-0.5">
                {group.claims.length} claim{group.claims.length === 1 ? "" : "s"}
              </div>
            </button>
          {/each}
        {:else if shown.length === 0}
          <p class="text-on-surface-muted text-sm p-4 font-ui">Nothing matches.</p>
        {:else}
          {#each shown as e (e.id)}
            <button
              onclick={() => select(e.id)}
              class="w-full text-left px-3 py-2 border-b border-border/40 cursor-pointer transition-colors
                {selectedId === e.id ? 'bg-primary/10' : 'hover:bg-surface-alt'}"
            >
              <div class="flex items-baseline gap-2">
                <span class="text-sm text-on-surface flex-1 min-w-0 truncate">{e.name}</span>
                {#if tab === "document" && e.held}
                  <span
                    class="text-[10px] font-ui font-medium px-1.5 py-0.5 rounded flex-none
                      bg-success/20 text-success"
                    title="The corpus holds this work"
                  >held</span>
                {/if}
              </div>
              <div class="flex items-center gap-2 mt-0.5 text-[11px] font-ui text-on-surface-muted tabular-nums">
                <span>{e.mentions} mention{e.mentions === 1 ? "" : "s"}</span>
                <span>·</span>
                <span>{e.records} record{e.records === 1 ? "" : "s"}</span>
              </div>
            </button>
          {/each}
        {/if}
      </div>
    </div>

    <!-- Reading -->
    <div class="flex-1 overflow-auto min-h-0">
      {#if tab === "claims"}
        <div class="px-6 py-5 space-y-7">
          {#each claimsByRecord as group}
            <section id={`infra-rec-${group.hash ?? group.title}`} class="scroll-mt-4">
              <button
                onclick={() => openRecord(group.hash)}
                class="text-sm font-ui font-medium text-primary hover:underline cursor-pointer text-left"
                title="Open this record in the workbench"
              >{group.title}</button>
              <ul class="mt-2 space-y-2">
                {#each group.claims as c}
                  <li class="flex gap-3 items-baseline">
                    <span
                      class="flex-none text-[10px] font-ui uppercase tracking-wide w-24 text-right
                        {c.claim_type === 'administrative'
                        ? 'text-on-surface-muted/70'
                        : 'text-amber-600 dark:text-amber-400'}"
                    >{c.claim_type}</span>
                    <span class="text-sm text-on-surface-secondary leading-relaxed max-w-[76ch]"
                      >{c.content}</span
                    >
                  </li>
                {/each}
              </ul>
            </section>
          {:else}
            <p class="text-sm font-ui text-on-surface-muted">Nothing matches.</p>
          {/each}
        </div>
      {:else if loadingDetail && !selected}
        <p class="text-on-surface-muted text-sm p-6 font-ui">Loading...</p>
      {:else if selected}
        <!-- Reading left, index right: forty connection chips stacked above the
             claims pushed the actual reading off the screen. -->
        <div class="flex gap-8 px-6 py-5 items-start">
          <div class="flex-1 min-w-0 max-w-[72ch]">
            <div class="flex items-baseline gap-3 flex-wrap">
              <h2 class="text-xl text-on-surface">{selected.name}</h2>
              <span class="text-xs font-ui uppercase tracking-wide text-primary"
                >{KIND_LABEL[selected.kind] ?? selected.kind}</span
              >
            </div>
            {#if selected.kind === "document"}
              <p class="text-xs font-ui mt-1 {selected.held ? 'text-success' : 'text-amber-600 dark:text-amber-400'}">
                {selected.held
                  ? "In the corpus - this work has been ingested."
                  : "Not in the corpus - named by the material, not held."}
              </p>
            {/if}
            {#if selected.aliases.length}
              <p class="text-xs font-ui text-on-surface-muted mt-1">
                Also written as {selected.aliases.join(", ")}
              </p>
            {/if}

            <h3 class="text-xs font-ui font-medium text-on-surface-secondary mt-6 mb-2">
              What the corpus says about it
            </h3>
            <ul class="space-y-3">
              {#each selected.claims as c}
                <li>
                  <p class="text-sm text-on-surface leading-relaxed">{c.content}</p>
                  <p class="text-[11px] font-ui text-on-surface-muted mt-0.5 flex items-center gap-2">
                    <span
                      class="uppercase tracking-wide {c.claim_type === 'administrative'
                        ? ''
                        : 'text-amber-600 dark:text-amber-400'}">{c.claim_type}</span
                    >
                    {#if c.record_title}
                      <span>·</span>
                      <button
                        onclick={() => openRecord(c.record_hash)}
                        class="hover:text-primary hover:underline cursor-pointer text-left"
                        title="Open this record in the workbench"
                      >{c.record_title}</button>
                    {/if}
                  </p>
                </li>
              {/each}
            </ul>
          </div>

          {#if selected.connected.length}
            <!-- The extraction never labels the relationship, so this is an
                 index rather than a statement: a work's people are its author
                 and whoever cited it, and the claims say which is which. -->
            <aside class="w-64 flex-none">
              <h3 class="text-xs font-ui font-medium text-on-surface-secondary mb-1.5">
                Named alongside
              </h3>
              <div class="flex flex-col items-start gap-1">
                {#each connections as c}
                  <button
                    onclick={() => follow(c.id, c.kind)}
                    class="text-left text-xs font-ui text-on-surface-secondary
                      hover:text-primary cursor-pointer transition-colors w-full"
                    title={`${c.shared} claim${c.shared === 1 ? "" : "s"} name both`}
                  >
                    <span class="line-clamp-2">{c.name}</span>
                    <span class="text-on-surface-muted/70">{KIND_LABEL[c.kind] ?? c.kind}</span>
                  </button>
                {/each}
              </div>
              {#if selected.connected.length > CONNECTIONS_SHOWN}
                <button
                  onclick={() => (allConnections = !allConnections)}
                  class="text-[11px] font-ui text-primary hover:underline cursor-pointer mt-2"
                >
                  {allConnections
                    ? "Show fewer"
                    : `${selected.connected.length - CONNECTIONS_SHOWN} more`}
                </button>
              {/if}
            </aside>
          {/if}
        </div>
      {:else}
        <!-- Nothing selected. Rather than an empty half-screen, say what is in
             the database and where it came from - nobody has seen this data
             before, so that is the first useful thing the tab can do. -->
        <div class="px-6 py-6 flex gap-10 items-start flex-wrap">
          <div class="max-w-xl space-y-3">
            <p class="text-sm font-ui text-on-surface-secondary leading-relaxed">
              {TABS.find((t) => t.id === tab)?.blurb}. Choose one to read what the corpus
              says about it.
            </p>
            {#if summary}
              <p class="text-sm font-ui text-on-surface-secondary leading-relaxed">
                Of the {summary.works_named} works named across the material, {summary.works_held}
                are ones we hold. The rest is a reading list the corpus assembled about
                itself.
              </p>
              <h3 class="text-xs font-ui font-medium text-on-surface-secondary pt-2">
                What was extracted
              </h3>
              <ul class="space-y-1">
                {#each summary.by_type as t}
                  <li class="flex items-center gap-2">
                    <span class="text-[11px] font-ui w-24 flex-none text-right
                      {t.type === 'administrative' ? 'text-on-surface-muted' : 'text-amber-600 dark:text-amber-400'}"
                      >{t.type}</span
                    >
                    <span
                      class="h-2 rounded-sm {t.type === 'administrative'
                        ? 'bg-on-surface-muted/30'
                        : 'bg-amber-400/70'}"
                      style="width: {Math.max(2, (t.count / summary.claims) * 240)}px"
                    ></span>
                    <span class="text-[11px] font-ui text-on-surface-muted tabular-nums"
                      >{t.count}</span
                    >
                  </li>
                {/each}
              </ul>
              <p class="text-[11px] font-ui text-on-surface-muted leading-relaxed">
                <span class="text-on-surface-secondary">administrative</span> is what a
                bibliography is made of. The other {summary.suspect} were typed as things
                the extraction usually reserves for the domain half - worth a look, not a
                fault list.
              </p>
            {/if}
          </div>

          {#if sourceRecords.length}
            <div class="min-w-72">
              <h3 class="text-xs font-ui font-medium text-on-surface-secondary mb-1.5">
                Where it comes from
              </h3>
              <p class="text-[11px] font-ui text-on-surface-muted mb-2 max-w-md leading-relaxed">
                All {sourceRecords.length} records that have been digested. A book with a
                bibliography yields hundreds of these; a press conference yields none.
              </p>
              <ul class="space-y-0.5">
                {#each sourceRecords as r}
                  <li class="flex items-baseline gap-3">
                    <span class="text-[11px] font-ui text-on-surface-muted tabular-nums w-8 text-right flex-none"
                      >{r.claims}</span
                    >
                    <button
                      onclick={() => openRecord(r.hash)}
                      class="text-xs font-ui text-on-surface-secondary hover:text-primary
                        cursor-pointer text-left truncate max-w-xs"
                      title={r.title}
                    >{r.title}</button>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}
