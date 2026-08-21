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

  const shown = $derived(
    topics
      .filter((t) => !publishedSlugs.has(t.slug))
      .filter((t) =>
        filter === "single" ? t.single_source : filter === "nobrief" ? !t.has_brief : true,
      ),
  );
  const singleCount = $derived(topics.filter((t) => t.single_source).length);
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
</script>

<div class="flex-1 overflow-y-auto">
  <div class="mx-auto max-w-6xl px-6 py-6">
    <h2 class="font-ui text-lg text-on-surface">Topics</h2>
    <p class="mt-1 max-w-prose text-sm text-on-surface-muted">
      Every subject in one place and which state it is in: the pages that exist,
      the topics you have asked for before the material arrived, and the ones the
      graph proposes on the evidence it holds. Open any proposal to read the brief
      a page would be written from.
    </p>

    {#if error}
      <p class="mt-4 rounded border border-error/40 px-3 py-2 text-sm text-error">{error}</p>
    {/if}

    <!-- Seeded: the half the graph cannot propose, because a proposal is derived
         from claims and so cannot exist before them. -->
    <!-- Already published. First, because it is the finished state: without it
         the tab is a queue of what to do next, with no way to see that a topic
         proposed last week went out last night. -->
    <section class="mt-6 rounded border border-border bg-surface-alt px-4 py-4">
      <div class="flex flex-wrap items-baseline gap-3">
        <h3 class="font-ui text-sm text-on-surface">Pages we already have</h3>
        {#if trailing.length}
          <span class="text-xs text-warning">
            {trailing.length} written from a brief that has since changed
          </span>
        {/if}
      </div>
      {#if published.length}
        <ul class="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
          {#each published as page (page.slug)}
            <li class="flex items-baseline gap-1.5 text-sm">
              <span class="text-on-surface">{page.name}</span>
              {#if page.stale}
                <span
                  class="text-[11px] text-warning"
                  title="The brief moved after this page was written, so the page is behind the material."
                >behind</span>
              {:else if page.stale === null}
                <span
                  class="text-[11px] text-on-surface-muted"
                  title="The brief this page was written from is no longer there."
                >no brief</span>
              {/if}
            </li>
          {/each}
        </ul>
      {:else}
        <p class="mt-3 text-sm text-on-surface-muted">None yet.</p>
      {/if}
    </section>

    <section class="mt-6 rounded border border-border bg-surface-alt px-4 py-4">
      <h3 class="font-ui text-sm text-on-surface">Topics you've asked for</h3>
      <p class="mt-0.5 text-xs text-on-surface-muted">
        Named before the material exists. Each shows what the corpus holds for it so
        far, so a thin one tells you what to ingest next.
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
      <h3 class="font-ui text-sm text-on-surface">
        {topics.length - publishedSlugs.size} proposed and not yet written
      </h3>
      <div class="flex gap-1 text-xs">
        {#each [["all", `All ${shown.length}`], ["single", `Single-source ${singleCount}`], ["nobrief", "No brief"]] as [key, label]}
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

            <button
              onclick={() => openBrief(t)}
              class="ml-auto text-xs text-primary underline"
            >{openSlug === t.slug ? "hide brief" : "read the brief"}</button>

            {#if canDecide && t.status !== "vetoed"}
              <button
                onclick={() => doVeto(t)}
                disabled={busy}
                class="text-xs text-on-surface-muted underline hover:text-error"
              >never a page</button>
            {/if}
          </div>

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
                  {claimsList(brief).length} of {page(brief).claim_count_total} claims
                  selected for the page, spread across sources. This is the whole of
                  what a page would be written from.
                </p>
                <ol class="mt-2 flex flex-col gap-2">
                  {#each claimsList(brief).slice(0, 40) as c (c.id ?? c.content)}
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
                {#if claimsList(brief).length > 40}
                  <p class="mt-2 text-xs text-on-surface-muted">
                    … and {claimsList(brief).length - 40} more in the brief.
                  </p>
                {/if}
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
</div>
