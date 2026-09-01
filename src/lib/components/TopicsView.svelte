<script lang="ts">
  // Topics: what earns a page, and what goes into it.
  //
  // Two lists that look similar and are not. PROPOSED topics are what the graph
  // found, and they arrive with their evidence because the decision is about the
  // numbers, not the name - 259 claims from 2 sources is a different proposition
  // from 259 claims from 40. SEEDED topics are named by a human before any
  // material exists, and fill up; that inverts the reading, showing where the
  // corpus is thin against what we care about.
  //
  // The brief is readable in full. A page is written from the brief and nothing
  // else, so this is the only place to see what a page would actually be made of
  // before spending a model call on it.
  import {
    fetchTopics,
    fetchTopicBrief,
    seedTopic,
    unseedTopic,
    vetoTopic,
    type PublishedPage,
    type SeededTopic,
    type Topic,
  } from "$lib/api";
  import { STATIC_READS } from "$lib/api";

  let { canDecide = false }: { canDecide?: boolean } = $props();

  /** Vetoing and seeding shell out to the assimilator, which the deployed
   *  build has no way to reach - the controls would fail rather than do
   *  nothing. Reading is fine: the snapshot carries the list and the briefs. */
  const canWrite = $derived(canDecide && !STATIC_READS);

  let topics = $state<Topic[]>([]);
  let seeded = $state<SeededTopic[]>([]);
  let published = $state<PublishedPage[]>([]);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let openSlug = $state<string | null>(null);
  let brief = $state<Record<string, unknown> | null>(null);
  let briefLoading = $state(false);
  let newTopic = $state("");
  let newNote = $state("");
  let filter = $state<"all" | "single" | "nobrief">("all");

  /** Everything still awaiting a page. Every count comes off THIS, so a filter
   *  chip reports the same number whether or not it is the active one - the
   *  counts used to be read off the filtered list, so "All" showed the size of
   *  whatever filter was on and changed each time one was clicked. */
  const pending = $derived(topics.filter((t) => !publishedSlugs.has(t.slug)));
  const shown = $derived(
    pending.filter((t) =>
      filter === "single" ? t.single_source : filter === "nobrief" ? !t.has_brief : true,
    ),
  );
  const counts = $derived({
    all: pending.length,
    single: pending.filter((t) => t.single_source).length,
    nobrief: pending.filter((t) => !t.has_brief).length,
  });
  /** Where a written page lives on the site: /en/<kind>/<slug>/. The kind is
   *  the node type pluralised and it is not optional - without it every link
   *  404s, which is what shipping `/en/<slug>/` did. */
  const pageUrl = (page: PublishedPage) =>
    `https://anomalica.is/en/${page.kind}/${page.slug}/`;
  let showPublished = $state(false);
  let confirmVeto = $state<string | null>(null);
  const trailing = $derived(published.filter((p) => p.stale === true));
  /** A proposal that already has a page is not a proposal - it is the same
   *  subject in its finished state, and showing it in both lists reads as work
   *  outstanding. */
  const publishedSlugs = $derived(new Set(published.map((p) => p.slug)));

  async function load() {
    try {
      const d = await fetchTopics();
      topics = d.topics;
      seeded = d.seeded;
      published = d.published ?? [];
    } catch (e) {
      error = String(e);
    }
  }
  $effect(() => {
    load();
  });

  async function openBrief(t: Topic) {
    if (openSlug === t.slug) {
      openSlug = null;
      brief = null;
      return;
    }
    openSlug = t.slug;
    brief = null;
    briefLoading = true;
    try {
      brief = await fetchTopicBrief(t.slug);
    } catch (e) {
      error = String(e);
    } finally {
      briefLoading = false;
    }
  }

  async function doVeto(t: Topic) {
    const reason = prompt(`Never make a page for "${t.name}"? Reason (recorded):`);
    if (reason === null) return;
    busy = true;
    error = null;
    try {
      await vetoTopic([t.node_id], reason);
      await load();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  async function addSeed() {
    if (!newTopic.trim()) return;
    busy = true;
    error = null;
    try {
      await seedTopic(newTopic, newNote);
      newTopic = "";
      newNote = "";
      await load();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  async function dropSeed(name: string) {
    busy = true;
    try {
      await unseedTopic(name);
      await load();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  function claimsList(b: Record<string, unknown> | null): any[] {
    return (b?.claims as any[]) ?? [];
  }
  function page(b: Record<string, unknown> | null): any {
    return (b?.page as any) ?? {};
  }
  /** The brief's own account of what it left out and why. */
  function belonging(b: Record<string, unknown> | null): {
    verified?: number;
    suspect_excluded?: number;
    unreviewed?: number;
  } {
    return (b?.belonging as any) ?? {};
  }
</script>

<div class="flex-1 overflow-y-auto">
  <div class="mx-auto max-w-6xl px-6 py-6">
    <h2 class="font-ui text-lg text-on-surface">Topics</h2>
    <p class="mt-1 max-w-prose text-sm text-on-surface-muted">
      Every subject and the state it is in: written, requested, or proposed on the
      evidence the graph holds.
    </p>

    {#if error}
      <p class="mt-4 rounded border border-error/40 px-3 py-2 text-sm text-error">{error}</p>
    {/if}

    <!-- Written pages are the finished state, so they belong here - but as a
         line, not a list. 275 names at the top is a wall, and it buried the
         proposals the tab exists to work through. -->
    <div class="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <button
        onclick={() => (showPublished = !showPublished)}
        class="flex items-center gap-1.5 text-on-surface hover:text-primary"
      >
        <svg class="h-3.5 w-3.5 transition-transform {showPublished ? 'rotate-90' : ''}"
             fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <span><span class="font-medium tabular-nums">{published.length}</span> written</span>
      </button>
      {#if trailing.length}
        <!-- Not a warning. A page is stale the moment its brief changes, so a
             busy graph restales pages by the hundred and the count says the
             pipeline is working, not failing. What WOULD be a warning is a
             number that never falls after a rebuild - which this badge cannot
             show, so it does not pretend to. -->
        <span
          class="text-xs text-on-surface-muted"
          title="Their brief changed after the page was written. Normal while the graph is moving - each rebuild restates them."
        >{trailing.length} behind their brief</span>
      {/if}
    </div>

    {#if showPublished}
      <ul class="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
        {#each published as page (page.slug)}
          <li class="flex items-baseline gap-1.5 text-sm">
            {#if page.kind}
              <a
                href={pageUrl(page)}
                target="_blank"
                rel="noopener"
                class="truncate text-on-surface hover:text-primary hover:underline"
              >{page.name}</a>
            {:else}
              <!-- No kind means no path to build, and a link that 404s is worse
                   than none: it reads as the page being broken rather than
                   unlocatable from here. -->
              <span class="truncate text-on-surface">{page.name}</span>
            {/if}
            {#if page.stale}
              <span class="shrink-0 text-[11px] text-warning" title="Written from a brief that has since changed.">behind</span>
            {:else if page.stale === null}
              <span class="shrink-0 text-[11px] text-on-surface-muted" title="The brief this page was written from is gone.">no brief</span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    <section class="mt-6 rounded border border-border bg-surface-alt px-4 py-4">
      <h3 class="font-ui text-sm text-on-surface">Requested</h3>
      <p class="mt-0.5 text-xs text-on-surface-muted">
        Named before the material exists, so a thin one shows what to ingest next.
      </p>

      {#if seeded.length}
        <ul class="mt-3 flex flex-col gap-1.5">
          {#each seeded as s (s.name)}
            <li class="flex items-baseline gap-3 text-sm">
              <span class="font-medium text-on-surface">{s.name}</span>
              {#if s.note}<span class="text-xs text-on-surface-muted">{s.note}</span>{/if}
              {#if canWrite}
                <button
                  onclick={() => dropSeed(s.name)}
                  disabled={busy}
                  class="ml-auto text-xs text-on-surface-muted underline hover:text-error"
                >remove</button>
              {/if}
            </li>
          {/each}
        </ul>
      {:else}
        <p class="mt-3 text-sm text-on-surface-muted">None yet.</p>
      {/if}

      {#if canWrite}
        <div class="mt-4 flex flex-wrap items-center gap-2">
          <input
            bind:value={newTopic}
            placeholder="Topic name, e.g. Summoning"
            class="flex-1 min-w-48 rounded border border-border bg-surface px-2.5 py-1.5 text-sm text-on-surface"
          />
          <input
            bind:value={newNote}
            placeholder="Why (optional)"
            class="flex-1 min-w-48 rounded border border-border bg-surface px-2.5 py-1.5 text-sm text-on-surface"
          />
          <button
            onclick={addSeed}
            disabled={busy || !newTopic.trim()}
            class="rounded bg-primary px-3 py-1.5 text-sm text-surface disabled:opacity-50"
          >Add topic</button>
        </div>
      {/if}
    </section>

    <div class="mt-6 flex flex-wrap items-center gap-3">
      <h3 class="font-ui text-sm text-on-surface">Proposed</h3>
      <div class="flex gap-1 text-xs">
        {#each [["all", `All ${counts.all}`], ["single", `One source ${counts.single}`], ["nobrief", `No brief ${counts.nobrief}`]] as [key, label]}
          <button
            onclick={() => (filter = key as any)}
            class="rounded px-2 py-1 {filter === key
              ? 'bg-primary-container text-on-surface'
              : 'text-on-surface-muted hover:bg-surface-alt'}"
          >{label}</button>
        {/each}
      </div>
    </div>

    <ul class="mt-3 flex flex-col gap-1.5">
      {#each shown as t (t.node_id)}
        <li class="rounded border border-border bg-surface-alt">
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5">
            <span class="font-medium text-on-surface">{t.name}</span>
            <span class="text-xs uppercase text-on-surface-muted">{t.node_type}</span>

            <span class="text-xs tabular-nums text-on-surface-secondary">
              {t.claims} claims / {t.sources} sources
            </span>

            {#if t.single_source}
              <!-- The gate's own test: a second work contributing under three
                   claims means one voice is carrying the page. -->
              <span class="rounded-full bg-warning-container px-1.5 text-xs text-on-warning-container">
                one source
              </span>
            {/if}
            {#if t.status === "vetoed"}
              <span class="rounded-full bg-error/15 px-1.5 text-xs text-error">vetoed</span>
            {/if}
            {#if !t.has_brief}
              <span class="text-xs text-on-surface-muted">no brief yet</span>
            {/if}

            <div class="ml-auto flex items-center gap-1">
              <!-- Icons, with the word in the tooltip: the row is dense and
                   three labelled links across it read as a sentence. -->
              <button
                onclick={() => openBrief(t)}
                title={openSlug === t.slug ? "Hide the brief" : "Brief - everything a page would be written from"}
                aria-label="Brief"
                class="rounded p-1 {openSlug === t.slug ? 'bg-primary-container text-on-surface' : 'text-on-surface-muted hover:bg-surface hover:text-primary'}"
              >
                <svg
                  class="h-4 w-4 transition-transform {openSlug === t.slug ? 'rotate-180' : ''}"
                  fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"
                >
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6" />
                </svg>
              </button>

              {#if canDecide && t.status !== "vetoed"}
                <button
                  onclick={() => (confirmVeto = confirmVeto === t.node_id ? null : t.node_id)}
                  title="Never write a page for this"
                  aria-label="Never a page"
                  class="rounded p-1 {confirmVeto === t.node_id ? 'bg-error/15 text-error' : 'text-on-surface-muted hover:bg-surface hover:text-error'}"
                >
                  <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.75" viewBox="0 0 24 24" aria-hidden="true">
                    <path stroke-linecap="round" d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              {/if}
            </div>
          </div>

          {#if confirmVeto === t.node_id}
            <div class="flex flex-wrap items-center gap-2 border-t border-error/30 bg-error/5 px-4 py-2 text-xs">
              <span class="text-on-surface">Never write a page for <strong>{t.name}</strong>?</span>
              <span class="text-on-surface-muted">It stays in the graph; it stops being proposed.</span>
              <button
                onclick={() => { confirmVeto = null; doVeto(t); }}
                disabled={busy}
                class="ml-auto rounded bg-error px-2 py-1 text-on-error disabled:opacity-50"
              >Never a page</button>
              <button
                onclick={() => (confirmVeto = null)}
                class="rounded px-2 py-1 text-on-surface-muted hover:text-on-surface"
              >Cancel</button>
            </div>
          {/if}

          {#if openSlug === t.slug}
            <div class="border-t border-border px-4 py-3">
              {#if briefLoading}
                <p class="text-sm text-on-surface-muted">Loading the brief…</p>
              {:else if !brief}
                <p class="text-sm text-on-surface-muted">
                  No brief on disk for this topic yet. Briefs are generated from the
                  graph and cost nothing; this one has not been produced.
                </p>
              {:else}
                <p class="text-xs text-on-surface-muted">
                  {claimsList(brief).length} claims, oldest source first - the whole of
                  what a page would be written from.
                  <!-- Where the shortfall against claim_count_total comes from,
                       taken from the brief's own belonging block rather than
                       guessed. The dominant reason is exclusion, not the cap:
                       the Nimitz brief drops 630 of 1,033 as read-and-does-not-
                       belong, which is a fact about the graph worth seeing. -->
                  {#if belonging(brief).suspect_excluded}
                    <span class="text-on-surface-secondary">
                      {belonging(brief).suspect_excluded} more were attached to this
                      subject and read as not belonging to it.
                    </span>
                  {/if}
                  {#if belonging(brief).unreviewed}
                    <span>{belonging(brief).unreviewed} not yet read.</span>
                  {/if}
                </p>
                <ol class="mt-2 flex max-h-[32rem] flex-col gap-2 overflow-y-auto pr-2">
                  {#each claimsList(brief) as c (c.id ?? c.content)}
                    <li class="border-l-2 border-border pl-3 text-sm text-on-surface-secondary">
                      <span>{c.content ?? c.text}</span>
                      {#if c.source || c.attestation}
                        <span class="block text-xs text-on-surface-muted">
                          {c.source ?? ""}{c.attestation ? ` · ${c.attestation}` : ""}
                        </span>
                      {/if}
                    </li>
                  {/each}
                </ol>

              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
</div>
