<script lang="ts">
  // Pages: what earns a page, and what goes into it.
  //
  // Called Topics until 2026-09-03, and misnamed the whole time: of the page
  // proposals it lists, 128 are people, 36 organisations and 33 topics, so
  // "topic" named the smallest slice of what is here. It is about pages.
  //
  // ONE list, not three. The three states - written, proposed, requested - used
  // to be three separate blocks, with the written ones collapsed into a line of
  // names at the top. That buried the subjects most likely to be duplicates of
  // each other, which is what this tab is now for: a page that exists and a
  // proposal for the same thing are only recognisable as one subject if they sit
  // in the same list, next to each other, sorted by weight.
  //
  // The three states are genuinely different and the row says which:
  // - WRITTEN is a page on the site. Removing it deletes something that exists.
  // - PROPOSED is what the graph found on the evidence it holds. Rejecting it
  //   deletes nothing.
  // - REQUESTED is a name a human gave before there was material, which shows
  //   where the corpus is thin against what we care about.
  //
  // The brief is readable in full on any row that has one. A page is written
  // from the brief and nothing else, so this is the only place to see what a
  // page would be made of before spending a model call on it.
  import {
    composePage,
    decomposePage,
    fetchCompositions,
    fetchNameCheck,
    fetchTopics,
    fetchTopicBrief,
    seedTopic,
    unseedTopic,
    vetoTopic,
    type NameCheck,
    type PageComposition,
    type PublishedPage,
    type RenameOutcome,
    type SeededTopic,
    type Topic,
  } from "$lib/api";
  import { STATIC_READS } from "$lib/api";
  import RenameEditor from "./RenameEditor.svelte";

  let { canDecide = false }: { canDecide?: boolean } = $props();

  /** Vetoing, seeding and renaming shell out to the assimilator, which the
   *  deployed build has no way to reach - the controls would fail rather than do
   *  nothing. Reading is fine: the snapshot carries the list and the briefs. */
  const canWrite = $derived(canDecide && !STATIC_READS);

  type State = "written" | "proposed" | "requested";

  /** One subject, whatever state it is in. Everything a row can show or act on
   *  is here, so the markup asks about `state` and never about which of the
   *  three collections a row came from. */
  type Row = {
    key: string;
    state: State;
    name: string;
    node_id: string | null;
    node_type: string | null;
    section: string | null;
    slug: string | null;
    claims: number | null;
    sources: number | null;
    subject_claims: number | null;
    single_source: boolean;
    has_brief: boolean;
    /** Written only: its brief moved after the page was written. */
    stale: boolean | null;
    vetoed: boolean;
    rename: RenameOutcome | null;
    note: string | null;
    url: string | null;
  };

  let topics = $state<Topic[]>([]);
  let seeded = $state<SeededTopic[]>([]);
  let published = $state<PublishedPage[]>([]);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let openKey = $state<string | null>(null);
  let brief = $state<Record<string, unknown> | null>(null);
  let briefLoading = $state(false);
  let newTopic = $state("");
  let filter = $state<"all" | State | "single" | "nobrief" | "behind">("all");
  let confirmRemove = $state<string | null>(null);
  /** Why a page or a proposal is being dropped. NOT optional: it is the evidence
   *  the person carrying out the retirement reads before deciding what actually
   *  happens to the page - move it to the entity the claims are really about,
   *  retire it, or fix the data behind it. The first veto placed here went in
   *  blank and stalled on exactly that question. */
  let removeReason = $state("");
  /** The row whose name is being edited. One at a time - a name is read against
   *  its evidence, not in a batch. */
  let renaming = $state<string | null>(null);
  /** What a rename or merge did, above the list rather than on the row: a merged
   *  row is gone by the time the message would show. */
  let notice = $state<string | null>(null);

  /** Covering several subjects with one page.
   *
   *  UAP and UFO are the same phenomenon under two vocabularies, and a reader
   *  cannot tell which page to read. Merging the two nodes would be the wrong
   *  fix - they share only 26 claims of 2,068, and folding them together
   *  destroys which word each source used, which is the evidence for when the
   *  terminology changed. So the nodes stay separate and one page covers both.
   *
   *  The name is free but defaults to the heaviest member's, because the name
   *  sets the slug and so decides which member's existing page survives
   *  untouched - naming it after the bigger one retires only the smaller. */
  let composing = $state(false);
  let picked = $state<string[]>([]);
  let composeName = $state("");
  let composeCheck = $state<NameCheck | null>(null);
  let compositions = $state<PageComposition[]>([]);

  /** Where a written page lives on the site: /en/<kind>/<slug>/. The kind is the
   *  node type pluralised and it is not optional - without it every link 404s,
   *  which is what shipping `/en/<slug>/` did. */
  const pageUrl = (kind: string | null, slug: string) =>
    kind ? `https://anomalica.is/en/${kind}/${slug}/` : null;

  /** A page's identity is (section, slug), never the slug alone: an event and a
   *  project of one name share a slug and are two pages. */
  const publishedKeys = $derived(new Set(published.map((p) => `${p.kind}/${p.slug}`)));

  const rows = $derived.by((): Row[] => {
    const written: Row[] = published.map((p) => ({
      key: `w:${p.kind}/${p.slug}`,
      state: "written" as State,
      name: p.name,
      node_id: p.node_id ?? null,
      // The section a page sits in IS its node type pluralised, which is the
      // nearest thing to a type a written page carries.
      node_type: p.kind,
      section: p.kind,
      slug: p.slug,
      claims: p.claims ?? null,
      sources: null,
      subject_claims: null,
      single_source: false,
      has_brief: p.stale !== null,
      stale: p.stale,
      vetoed: false,
      rename: null,
      note: null,
      url: pageUrl(p.kind, p.slug),
    }));
    const proposed: Row[] = topics
      .filter((t) => !publishedKeys.has(`${t.section}/${t.slug}`))
      .map((t) => ({
        key: `p:${t.node_id}`,
        state: "proposed" as State,
        name: t.name,
        node_id: t.node_id,
        node_type: t.node_type,
        section: t.section,
        slug: t.slug,
        claims: t.claims,
        sources: t.sources,
        subject_claims: t.subject_claims,
        single_source: t.single_source,
        has_brief: t.has_brief,
        stale: null,
        vetoed: t.status === "vetoed",
        rename: t.rename ?? null,
        note: null,
        url: null,
      }));
    const requested: Row[] = seeded.map((s) => ({
      key: `r:${s.name}`,
      state: "requested" as State,
      name: s.name,
      node_id: null,
      node_type: null,
      section: null,
      slug: null,
      claims: null,
      sources: null,
      subject_claims: null,
      single_source: false,
      has_brief: false,
      stale: null,
      vetoed: false,
      rename: null,
      note: s.note ?? null,
      url: null,
    }));
    // Weight first, whatever the state: the biggest subject is the one most
    // worth looking at, and interleaving is the point - a written page and a
    // proposal for the same thing land next to each other.
    return [...written, ...proposed, ...requested].sort(
      (a, b) => (b.claims ?? -1) - (a.claims ?? -1) || a.name.localeCompare(b.name),
    );
  });

  /** The rows currently picked for one page, in the order they were picked. */
  const pickedRows = $derived(
    picked.map((id) => rows.find((r) => r.node_id === id)).filter((r) => !!r) as Row[],
  );

  const matches = (r: Row, f: typeof filter) =>
    f === "all"
      ? true
      : f === "single"
        ? r.single_source
        : f === "nobrief"
          ? r.state !== "requested" && !r.has_brief
          : f === "behind"
            ? r.stale === true
            : r.state === f;

  const shown = $derived(rows.filter((r) => matches(r, filter)));
  /** Counted off the WHOLE set, so a chip reports the same number whether or not
   *  it is the active one. Read off the filtered list, "All" showed the size of
   *  whatever filter was on and changed each time one was clicked. */
  const chips = $derived(
    (
      [
        ["all", "All"],
        ["written", "Written"],
        ["proposed", "Proposed"],
        ["requested", "Requested"],
        ["single", "One source"],
        ["nobrief", "No brief"],
        ["behind", "Behind brief"],
      ] as const
    ).map(([key, label]) => ({
      key,
      label,
      count: rows.filter((r) => matches(r, key)).length,
    })),
  );

  async function load() {
    try {
      const [d, comps] = await Promise.all([fetchTopics(), fetchCompositions()]);
      topics = d.topics;
      seeded = d.seeded;
      published = d.published;
      compositions = comps;
      error = null;
    } catch (e) {
      error = String(e);
    }
  }

  $effect(() => {
    load();
  });

  async function openBrief(r: Row) {
    if (!r.section || !r.slug) return;
    if (openKey === r.key) {
      openKey = null;
      brief = null;
      return;
    }
    openKey = r.key;
    brief = null;
    briefLoading = true;
    try {
      brief = await fetchTopicBrief(r.section, r.slug);
    } catch (e) {
      error = String(e);
    } finally {
      briefLoading = false;
    }
  }

  function startRename(r: Row) {
    notice = null;
    renaming = renaming === r.key ? null : r.key;
  }

  async function renamed(message: string) {
    notice = message;
    renaming = null;
    await load();
  }

  /** Written and proposed take the same decision - never a page for this
   *  subject - and it lands in the curation ledger either way. What differs is
   *  what happens next: a proposal simply stops being offered, while a page that
   *  exists comes down at the next assembly. */
  async function doVeto(r: Row, reason: string) {
    if (!r.node_id) return;
    busy = true;
    error = null;
    try {
      await vetoTopic([r.node_id], reason);
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
      await seedTopic(newTopic, "");
      newTopic = "";
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

  function togglePick(r: Row) {
    if (!r.node_id) return;
    const id = r.node_id;
    picked = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
    if (picked.length === 1) {
      // Default to the first one picked; the reviewer can write anything.
      composeName = r.name;
      checkName();
    }
  }

  async function checkName() {
    composeCheck = composeName.trim() ? await fetchNameCheck(composeName) : null;
  }

  async function doCompose() {
    const name = composeName.trim();
    if (!name || picked.length < 2) return;
    busy = true;
    error = null;
    try {
      const out = await composePage(name, picked);
      notice =
        `"${out.name}" now covers ${out.members.length} subjects` +
        (out.dropped.length ? `; ${out.dropped.join(", ")} no longer resolved and was left out` : "") +
        ". They stop being proposed separately.";
      composing = false;
      picked = [];
      composeName = "";
      await load();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  async function doDecompose(c: PageComposition) {
    busy = true;
    try {
      await decomposePage(c.page_id);
      notice = `"${c.name}" is no longer one page; its subjects are proposed separately again.`;
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
  /** The brief's own account of what it left out and why. */
  function belonging(b: Record<string, unknown> | null): {
    verified?: number;
    suspect_excluded?: number;
    unreviewed?: number;
  } {
    return (b?.belonging as any) ?? {};
  }

  /** A page's section is its node type pluralised, and the type is what tells a
   *  person node from a topic of the same name - the whole point of one list.
   *  A fixed map rather than trimming an "s": "people" is not "peoples". */
  const SINGULAR: Record<string, string> = {
    people: "person",
    documents: "document",
    events: "event",
    places: "place",
    organisations: "organisation",
    objects: "object",
    projects: "project",
    topics: "topic",
    matters: "matter",
    concepts: "concept",
  };

  const STATE_CLASS: Record<State, string> = {
    written: "bg-primary/10 text-primary",
    proposed: "bg-surface text-on-surface-muted",
    requested: "bg-warning-container text-on-warning-container",
  };
</script>

<div class="flex-1 overflow-y-auto">
  <div class="mx-auto max-w-6xl px-6 py-6">
    <h2 class="font-ui text-lg text-on-surface">Pages</h2>
    <p class="mt-1 max-w-prose text-sm text-on-surface-muted">
      Every subject and the state its page is in - written, proposed on the
      evidence the graph holds, or requested before the material exists. Heaviest
      first.
    </p>

    {#if error}
      <p class="mt-4 rounded border border-error/40 px-3 py-2 text-sm text-error">{error}</p>
    {/if}

    <div class="mt-5 flex flex-wrap items-center gap-1 text-xs">
      {#each chips as c (c.key)}
        <button
          onclick={() => (filter = c.key)}
          class="rounded px-2 py-1 {filter === c.key
            ? 'bg-primary-container text-on-surface'
            : 'text-on-surface-muted hover:bg-surface-alt'}"
        >{c.label} <span class="tabular-nums">{c.count}</span></button>
      {/each}
    </div>

    {#if canWrite}
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <button
          onclick={() => {
            composing = !composing;
            picked = [];
          }}
          class="rounded px-2 py-1 text-xs {composing
            ? 'bg-primary-container text-on-surface'
            : 'border border-border text-on-surface-muted hover:bg-surface-alt'}"
          title="Cover several subjects with one page - two names for one thing"
        >{composing ? "Stop composing" : "Cover several with one page"}</button>
        <input
          bind:value={newTopic}
          placeholder="Request a topic, e.g. Summoning"
          class="min-w-48 flex-1 rounded border border-border bg-surface px-2.5 py-1.5 text-sm text-on-surface"
        />
        <button
          onclick={addSeed}
          disabled={busy || !newTopic.trim()}
          class="rounded bg-primary px-3 py-1.5 text-sm text-on-primary disabled:opacity-50"
        >Request</button>
      </div>
    {/if}

    {#if notice}
      <p class="mt-3 rounded border border-border bg-surface px-4 py-2 text-xs text-on-surface">
        {notice}
      </p>
    {/if}

    {#if composing}
      <!-- Two names for one thing: the nodes stay separate, so which word each
           source used survives, and one page covers both. -->
      <div class="mt-3 rounded border border-primary/40 bg-primary-container/20 px-4 py-3 text-xs">
        <p class="text-on-surface">
          Pick the subjects one page should cover, then name it. They stay separate
          in the graph - which word each source used is evidence - and stop being
          proposed as pages of their own.
        </p>
        {#if pickedRows.length}
          <ul class="mt-2 flex flex-wrap gap-1.5">
            {#each pickedRows as r (r.key)}
              <li class="rounded-full border border-border bg-surface px-2 py-0.5">
                {r.name} <span class="text-on-surface-muted">{r.claims ?? 0} claims</span>
              </li>
            {/each}
          </ul>
        {/if}
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <label class="text-on-surface-muted" for="compose-name">Page name</label>
          <input
            id="compose-name"
            bind:value={composeName}
            oninput={checkName}
            placeholder="What should the page be called?"
            class="min-w-64 flex-1 rounded border border-border bg-surface px-2 py-1 text-sm text-on-surface"
          />
          <button
            onclick={doCompose}
            disabled={busy || picked.length < 2 || !composeName.trim()}
            class="rounded bg-primary px-2 py-1 text-on-primary disabled:opacity-50"
          >Cover {picked.length} with one page</button>
        </div>
        {#if composeCheck && composeCheck.title !== composeName.trim()}
          <p class="mt-1.5 text-on-surface-muted">
            Its title will read <strong class="text-on-surface">{composeCheck.title}</strong>.
          </p>
        {/if}
        {#each composeCheck?.warnings ?? [] as w}
          <p class="mt-1.5 rounded border border-warning/40 bg-warning-container/30 px-2 py-1 text-on-surface">{w}</p>
        {/each}
        <p class="mt-1.5 text-on-surface-muted">
          The name sets the address, so naming it after the bigger subject leaves
          that page where it is and retires only the smaller one.
        </p>
      </div>
    {/if}

    {#if compositions.length}
      <ul class="mt-3 flex flex-col gap-1.5">
        {#each compositions as c (c.page_id)}
          <li class="rounded border border-primary/40 bg-surface-alt px-4 py-2.5">
            <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
              <span class="font-medium text-on-surface">{c.name}</span>
              <span class="rounded-full bg-primary/10 px-1.5 text-[0.65rem] uppercase tracking-wide text-primary">
                one page, {c.members.length} subjects
              </span>
              <span class="text-xs text-on-surface-muted">
                {c.members.map((m) => m.name).join(" · ")}
              </span>
              {#if canWrite}
                <button
                  onclick={() => doDecompose(c)}
                  disabled={busy}
                  class="ml-auto rounded px-2 py-1 text-xs text-on-surface-muted hover:text-error"
                >Take apart</button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}

    <ul class="mt-3 flex flex-col gap-1.5">
      {#each shown as r (r.key)}
        <li class="rounded border border-border bg-surface-alt">
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5">
            {#if composing && r.node_id}
              <input
                type="checkbox"
                checked={picked.includes(r.node_id)}
                onchange={() => togglePick(r)}
                aria-label="Cover with one page"
                class="accent-primary"
              />
            {/if}
            {#if r.url}
              <a
                href={r.url}
                target="_blank"
                rel="noopener"
                class="font-medium text-on-surface hover:text-primary hover:underline"
              >{r.name}</a>
            {:else}
              <span class="font-medium text-on-surface">{r.name}</span>
            {/if}

            <span
              class="rounded-full px-1.5 text-[0.65rem] uppercase tracking-wide {STATE_CLASS[r.state]}"
            >{r.state}</span>
            {#if r.node_type}
              <span class="text-xs uppercase text-on-surface-muted">
                {r.state === "written" ? (SINGULAR[r.node_type] ?? r.node_type) : r.node_type}
              </span>
            {/if}

            {#if r.claims != null}
              <span class="text-xs tabular-nums text-on-surface-secondary">
                {r.claims} claims{#if r.sources != null} / {r.sources} sources{/if}{#if r.subject_claims != null}
                  / {r.subject_claims} about it{/if}
              </span>
            {/if}

            {#if r.note}<span class="text-xs text-on-surface-muted">{r.note}</span>{/if}

            {#if r.single_source}
              <!-- The gate's own test: a second work contributing under three
                   claims means one voice is carrying the page. -->
              <span class="rounded-full bg-warning-container px-1.5 text-xs text-on-warning-container">
                one source
              </span>
            {/if}
            {#if r.vetoed}
              <span class="rounded-full bg-error/15 px-1.5 text-xs text-error">vetoed</span>
            {/if}
            {#if r.stale === true}
              <!-- Muted, not a warning. A page is behind the moment its brief
                   changes, so a busy graph puts 207 of 263 in this state at once
                   and an orange flag on four rows in five says the pipeline is
                   failing when it is working. -->
              <span
                class="text-xs text-on-surface-muted"
                title="Its brief changed after the page was written. Normal while the graph is moving."
              >behind its brief</span>
            {:else if r.stale === null && r.state === "written"}
              <span
                class="text-xs text-on-surface-muted"
                title="The brief this page was written from is gone."
              >no brief</span>
            {/if}
            {#if r.state === "proposed" && !r.has_brief}
              <span class="text-xs text-on-surface-muted">no brief yet</span>
            {/if}
            {#if r.rename}
              <!-- Only unlanded renames reach here; an applied one is just the
                   name. A reviewer who asked for a change is owed the answer. -->
              <span
                class="rounded-full bg-warning-container px-1.5 text-xs text-on-warning-container"
                title={r.rename.note ?? ""}
              >rename {r.rename.status}: {r.rename.proposed_name}</span>
            {/if}

            <div class="ml-auto flex items-center gap-1">
              <!-- Icons, with the word in the tooltip: the row is dense and
                   three labelled links across it read as a sentence. -->
              {#if r.section && r.slug}
                <button
                  onclick={() => openBrief(r)}
                  title={openKey === r.key
                    ? "Hide the brief"
                    : "Brief - everything the page is written from"}
                  aria-label="Brief"
                  class="rounded p-1 {openKey === r.key
                    ? 'bg-primary-container text-on-surface'
                    : 'text-on-surface-muted hover:bg-surface hover:text-primary'}"
                >
                  <svg
                    class="h-4 w-4 transition-transform {openKey === r.key ? 'rotate-180' : ''}"
                    fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"
                  >
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6" />
                  </svg>
                </button>
              {/if}

              {#if canWrite && r.node_id}
                <button
                  onclick={() => startRename(r)}
                  title="Rename - the name is the page title and its address"
                  aria-label="Rename"
                  class="rounded p-1 {renaming === r.key
                    ? 'bg-primary-container text-on-surface'
                    : 'text-on-surface-muted hover:bg-surface hover:text-primary'}"
                >
                  <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.75" viewBox="0 0 24 24" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 4.5l3 3L8 19H5v-3L16.5 4.5z" />
                  </svg>
                </button>
              {/if}

              {#if canWrite && !r.vetoed}
                <!-- A BIN where something exists to delete, an X where nothing
                     does. Removing a written topic takes a page off the site;
                     rejecting a proposal or a request removes an intention. -->
                <button
                  onclick={() => {
                    removeReason = "";
                    confirmRemove = confirmRemove === r.key ? null : r.key;
                  }}
                  title={r.state === "written" ? "Take this page down" : "Never write a page for this"}
                  aria-label={r.state === "written" ? "Delete page" : "Never a page"}
                  class="rounded p-1 {confirmRemove === r.key
                    ? 'bg-error/15 text-error'
                    : 'text-on-surface-muted hover:bg-surface hover:text-error'}"
                >
                  {#if r.state === "written"}
                    <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.75" viewBox="0 0 24 24" aria-hidden="true">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M5 7h14M10 7V5h4v2M6 7l1 12h10l1-12M10 11v5M14 11v5" />
                    </svg>
                  {:else}
                    <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.75" viewBox="0 0 24 24" aria-hidden="true">
                      <path stroke-linecap="round" d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  {/if}
                </button>
              {/if}
            </div>
          </div>

          {#if renaming === r.key && r.node_id}
            <div class="border-t border-border bg-surface px-4 py-2.5">
              <RenameEditor
                node={{
                  id: r.node_id,
                  name: r.name,
                  node_type: r.node_type ?? undefined,
                  claims: r.claims ?? 0,
                }}
                onchanged={renamed}
                oncancel={() => (renaming = null)}
              />
            </div>
          {/if}

          {#if confirmRemove === r.key}
            <div class="flex flex-wrap items-center gap-2 border-t border-error/30 bg-error/5 px-4 py-2 text-xs">
              {#if r.state === "written"}
                <span class="text-on-surface">Take <strong>{r.name}</strong> off the site?</span>
                <span class="text-on-surface-muted">
                  It is marked never-a-page now; the page itself comes down when the
                  site is next assembled. The subject stays in the graph.
                </span>
              {:else if r.state === "proposed"}
                <span class="text-on-surface">Never write a page for <strong>{r.name}</strong>?</span>
                <span class="text-on-surface-muted">It stays in the graph; it stops being proposed.</span>
              {:else}
                <span class="text-on-surface">Drop the request for <strong>{r.name}</strong>?</span>
                <span class="text-on-surface-muted">Nothing is deleted - the subject was only ever a name.</span>
              {/if}
              {#if r.state !== "requested"}
                <!-- Required. Whoever carries out the retirement reads this to
                     decide what happens to the page: a page whose claims are all
                     about somebody else wants MOVING, not deleting, and only the
                     reviewer knows which case this is. -->
                <input
                  bind:value={removeReason}
                  placeholder="Why? (recorded, and read before the page is touched)"
                  class="w-full rounded border border-border bg-surface px-2 py-1 text-on-surface"
                />
              {/if}
              <button
                onclick={() => {
                  const reason = removeReason.trim();
                  confirmRemove = null;
                  removeReason = "";
                  if (r.state === "requested") dropSeed(r.name);
                  else doVeto(r, reason);
                }}
                disabled={busy || (r.state !== "requested" && !removeReason.trim())}
                class="ml-auto rounded bg-error px-2 py-1 text-on-error disabled:opacity-50"
              >{r.state === "written"
                  ? "Take it down"
                  : r.state === "proposed"
                    ? "Never a page"
                    : "Drop it"}</button>
              <button
                onclick={() => (confirmRemove = null)}
                class="rounded px-2 py-1 text-on-surface-muted hover:text-on-surface"
              >Cancel</button>
            </div>
          {/if}

          {#if openKey === r.key}
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
