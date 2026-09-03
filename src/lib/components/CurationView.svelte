<script lang="ts">
  import { onMount } from "svelte";
  import { suggestedCanonical } from "$lib/merge-canonical";
  import {
    fetchMergeCandidates,
    fetchActiveMerges,
    applyMerge,
    undoMerge,
    rejectCandidate,
    type MergeCandidate,
    type ActiveMerge,
  } from "$lib/api";

  type Tab = "candidates" | "merged";

  let candidates = $state<MergeCandidate[]>([]);
  let merges = $state<ActiveMerge[]>([]);
  let unconfirmedOnly = $state(false);
  /** A merge a PERSON confirmed carries their login through the workbench.
   *  Anything else - an operator script, an assimilator pass, no actor at all -
   *  was applied without anyone agreeing to it. */
  const confirmedByPerson = (m: ActiveMerge) => (m.created_by ?? "").startsWith("workbench/");
  const unconfirmedCount = $derived(merges.filter((m) => !confirmedByPerson(m)).length);
  const shownMerges = $derived(
    unconfirmedOnly ? merges.filter((m) => !confirmedByPerson(m)) : merges,
  );
  let tab = $state<Tab>("candidates");
  let index = $state(0);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let note = $state<string | null>(null);

  // Per-candidate working state, reset when the current candidate changes.
  let selected = $state(new Set<string>());
  let canonicalChoice = $state<string>("__suggested__");
  let newName = $state("");
  let lastKey = $state("");

  let current = $derived(candidates[index] ?? null);

  // Keep the working state in sync with the current candidate (members default
  // checked; canonical defaults to the suggestion).
  $effect(() => {
    const key = current ? current.node_ids.join(",") : "";
    if (key !== lastKey) {
      lastKey = key;
      selected = new Set(current?.members.map((m) => m.id) ?? []);
      canonicalChoice = "__suggested__";
      newName = suggestedName;
      note = null;
      error = null;
    }
  });

  let selectedMembers = $derived(current ? current.members.filter((m) => selected.has(m.id)) : []);
  const suggestedName = $derived(
    current ? suggestedCanonical(current.suggested_canonical, current.members) : "",
  );

  let canonicalName = $derived.by(() => {
    if (!current) return "";
    if (canonicalChoice === "__suggested__") return suggestedName;
    if (canonicalChoice === "__new__") return newName.trim();
    return current.members.find((m) => m.id === canonicalChoice)?.name ?? suggestedName;
  });

  function toggle(id: string) {
    const s = new Set(selected);
    s.has(id) ? s.delete(id) : s.add(id);
    selected = s;
  }

  function syncUrl() {
    const p = new URLSearchParams();
    if (tab !== "candidates") p.set("tab", tab);
    if (tab === "candidates" && index > 0) p.set("c", String(index));
    const qs = p.toString();
    history.replaceState(null, "", "/curate" + (qs ? `?${qs}` : ""));
  }

  function go(i: number) {
    index = Math.max(0, Math.min(candidates.length - 1, i));
    syncUrl();
  }
  function setTab(t: Tab) {
    tab = t;
    syncUrl();
  }

  async function load() {
    loading = true;
    try {
      const [cs, ms] = await Promise.all([fetchMergeCandidates(), fetchActiveMerges()]);
      candidates = byBand(cs);
      merges = ms;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function doMerge() {
    if (!current || selectedMembers.length < 2 || !canonicalName) return;
    // The survivor is the most-referenced selected node (fewest refs to move);
    // the rest retire into it.
    const survivor = selectedMembers.reduce((a, b) => (b.claims > a.claims ? b : a));
    const victims = selectedMembers.filter((m) => m.id !== survivor.id);
    busy = true;
    error = null;
    try {
      await applyMerge(survivor, victims, canonicalName);
      note = `Merged ${selectedMembers.length} nodes into "${canonicalName}".`;
      // Drop the just-merged candidate locally (the file refreshes on the next
      // propose run), refresh the merged list, and move to the next candidate.
      candidates = candidates.filter((_, i) => i !== index);
      if (index >= candidates.length) index = Math.max(0, candidates.length - 1);
      merges = await fetchActiveMerges();
      syncUrl();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function doReject() {
    if (!current) return;
    busy = true;
    error = null;
    try {
      await rejectCandidate(current.members);
      note = "Recorded as not a duplicate - it won't be proposed again.";
      candidates = candidates.filter((_, i) => i !== index);
      if (index >= candidates.length) index = Math.max(0, candidates.length - 1);
      syncUrl();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function doUndo(merge_id: string) {
    busy = true;
    error = null;
    try {
      await undoMerge(merge_id);
      merges = await fetchActiveMerges();
      // The un-merged nodes may re-propose, so re-band the queue as well.
      candidates = byBand(await fetchMergeCandidates());
      note = "Merge reversed.";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  const REASON_LABEL: Record<string, string> = {
    "name-equiv": "identical after normalisation",
    "name-equiv-crosstype": "same name, different types",
    fuzzy: "near-identical names",
    embedding: "same entity, different wording",
  };

  /** Whether a cluster spans node types, from the MEMBERS rather than from the
   *  reason label: a cross-type pair can arrive from fuzzy matching or an
   *  embedding as easily as from the name-equivalence pass, and the reason only
   *  named one of those routes.
   *
   *  It is the strongest signal there is about whether a proposal is any good.
   *  Over 500 judged pairs, same-type proposals were right about 70% of the
   *  time and cross-type ones about 11% - so the queue puts every same-type
   *  proposal first and this marks where the bad band starts, rather than
   *  hiding it. Nothing is filtered out: an event and the matter for it is a
   *  real cross-type merge. */
  const crossType = (c: MergeCandidate) =>
    new Set((c.members ?? []).map((m) => m.node_type)).size > 1;
  /** Stable, so the score order the passes produced survives inside each band. */
  const byBand = (list: MergeCandidate[]) =>
    [...list].sort((a, b) => Number(crossType(a)) - Number(crossType(b)));
  const sameTypeCount = $derived(candidates.filter((c) => !crossType(c)).length);

  let isCrossType = $derived(current ? crossType(current) : false);

  onMount(() => {
    const p = new URLSearchParams(window.location.search);
    const t = p.get("tab");
    if (t === "merged") tab = "merged";
    const c = Number(p.get("c"));
    if (Number.isInteger(c) && c > 0) index = c;
    load();
  });
</script>

<div class="flex-1 flex flex-col min-h-0">
  <!-- Tabs -->
  <div class="px-6 py-2 border-b border-border bg-surface-alt flex items-center gap-1 flex-none">
    <button
      onclick={() => setTab("candidates")}
      class="text-sm font-ui px-3 py-1 rounded cursor-pointer transition-colors
        {tab === 'candidates' ? 'bg-primary text-on-primary' : 'text-on-surface-secondary hover:bg-surface'}"
    >Candidates{#if candidates.length} ({candidates.length}){/if}</button>
    <button
      onclick={() => setTab("merged")}
      class="text-sm font-ui px-3 py-1 rounded cursor-pointer transition-colors
        {tab === 'merged' ? 'bg-primary text-on-primary' : 'text-on-surface-secondary hover:bg-surface'}"
    >Merged{#if merges.length} ({merges.length}){/if}</button>
    <span class="flex-1"></span>
    {#if error}<span class="text-xs font-ui text-error">{error}</span>{/if}
    {#if note && !error}<span class="text-xs font-ui text-success">{note}</span>{/if}
  </div>

  <div class="flex-1 overflow-auto">
    {#if loading}
      <p class="px-6 py-6 text-sm text-on-surface-muted">Loading...</p>
    {:else if tab === "candidates"}
      {#if candidates.length === 0}
        <div class="max-w-3xl mx-auto px-6 py-10 text-center text-on-surface-muted">
          <p class="text-sm">No merge candidates. Run <code class="font-mono">assimilator propose_merges</code> to propose clusters, or the queue is clear.</p>
        </div>
      {:else if current}
        <div class="max-w-3xl mx-auto px-6 py-6 space-y-4">
          <div class="flex items-baseline justify-between">
            <h2 class="text-lg font-medium text-on-surface">Merge candidates</h2>
            <div class="flex items-center gap-2 text-sm font-ui">
              <button onclick={() => go(index - 1)} disabled={index === 0} class="px-2 py-0.5 rounded border border-border disabled:opacity-40 cursor-pointer hover:bg-surface-alt">&larr;</button>
              <span class="text-on-surface-muted tabular-nums">{index + 1} of {candidates.length}</span>
              {#if sameTypeCount < candidates.length}
                <!-- Where the good band ends. Working past it is a choice, and
                     it should be a visible one rather than a surprise. -->
                <span class="text-xs text-on-surface-muted">
                  {sameTypeCount} same type, then {candidates.length - sameTypeCount} mixed
                </span>
              {/if}
              <button onclick={() => go(index + 1)} disabled={index >= candidates.length - 1} class="px-2 py-0.5 rounded border border-border disabled:opacity-40 cursor-pointer hover:bg-surface-alt">&rarr;</button>
            </div>
          </div>
          <p class="text-sm text-on-surface-secondary">
            Proposed duplicate clusters to review. Confirm the members (uncheck any that aren't the
            same entity), pick the canonical name, and merge - or skip. Click a claim count to
            inspect an entity's claims before merging. Fuzzy matches are by name similarity, so check
            them - near names aren't always the same thing.
          </p>

          <div class="rounded-lg border border-border bg-surface p-4 space-y-4">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-xs font-ui px-2 py-0.5 rounded bg-primary/10 text-primary uppercase tracking-wide">
                {isCrossType ? "mixed types" : current.node_type}
              </span>
              <span class="text-xs font-ui text-on-surface-secondary">
                {Math.round(current.score * 100)}%{#if current.rule_score != null}
                  <span title="The rules' own score for this pair, before any model judgement">
                    · rules {Math.round(current.rule_score * 100)}%</span
                  >{/if} · {REASON_LABEL[current.reason] ?? current.reason}
              </span>
              <span class="flex-1"></span>
              <span class="text-xs font-ui text-on-surface-muted tabular-nums">{selectedMembers.length} selected</span>
            </div>
            {#if isCrossType}
              <p class="text-xs font-ui text-warning border border-warning/40 bg-warning/5 rounded px-2.5 py-1.5">
                Spans node types, and these are the weak band: across 500 judged
                pairs, proposals within one type were right about 70% of the time
                and these about 11%. Check each member's type below and merge only
                if they are genuinely the same thing - an event and the matter for
                it - rather than merely same-named.
              </p>
            {/if}

            <div class="space-y-1.5">
              {#each current.members as m (m.id)}
                <div class="flex items-baseline gap-2.5 px-2.5 py-1.5 rounded border border-border bg-surface-alt">
                  <input type="checkbox" checked={selected.has(m.id)} onchange={() => toggle(m.id)} class="mt-0.5 accent-primary cursor-pointer" />
                  <span class="text-sm text-on-surface flex-1 min-w-0">{m.name}</span>
                  <span class="text-[10px] font-ui px-1.5 py-0.5 rounded bg-primary/10 text-primary flex-none">{m.node_type}</span>
                  <a href={`/graph/${m.id}`} class="text-xs font-ui text-primary hover:underline tabular-nums flex-none w-20 text-right" title="inspect this entity's claims">{m.claims} claims</a>
                </div>
              {/each}
            </div>

            <div class="space-y-1.5 border-t border-border pt-3">
              <p class="text-xs font-ui font-medium text-on-surface-secondary">Canonical name</p>
              <label class="flex items-center gap-2 text-sm text-on-surface cursor-pointer">
                <input type="radio" name="canon" checked={canonicalChoice === "__suggested__"} onchange={() => (canonicalChoice = "__suggested__")} class="accent-primary" />
                <span>{suggestedName}</span>
                <span class="text-[10px] font-ui px-1.5 py-0.5 rounded bg-success/15 text-success">suggested</span>
              </label>
              {#each selectedMembers as m (m.id)}
                <label class="flex items-center gap-2 text-sm text-on-surface-secondary cursor-pointer">
                  <input type="radio" name="canon" checked={canonicalChoice === m.id} onchange={() => (canonicalChoice = m.id)} class="accent-primary" />
                  <span class="truncate">{m.name}</span>
                </label>
              {/each}
              <label class="flex items-center gap-2 text-sm cursor-pointer">
                <input type="radio" name="canon" checked={canonicalChoice === "__new__"} onchange={() => (canonicalChoice = "__new__")} class="accent-primary" />
                <input type="text" bind:value={newName} onfocus={() => (canonicalChoice = "__new__")} placeholder="write a new name (follow the naming convention)" class="flex-1 px-2 py-1 rounded border border-border bg-surface text-on-surface text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
              </label>
            </div>

            <div class="flex items-center gap-2 border-t border-border pt-3">
              <button onclick={doMerge} disabled={busy || selectedMembers.length < 2 || !canonicalName} class="px-3 py-1.5 rounded bg-primary text-on-primary text-sm font-medium cursor-pointer disabled:opacity-40 hover:opacity-90">
                {busy ? "Merging..." : `Merge ${selectedMembers.length} nodes`}
              </button>
              <button onclick={doReject} disabled={busy} class="px-3 py-1.5 rounded border border-border text-on-surface-secondary text-sm cursor-pointer hover:bg-surface-alt" title="Confirmed distinct - record durably; never proposed again">Not a duplicate</button>
              <button onclick={() => go(index + 1)} disabled={busy} class="px-3 py-1.5 rounded text-on-surface-muted text-sm cursor-pointer hover:bg-surface-alt" title="Not now - may reappear in a future run">Skip</button>
            </div>
          </div>
        </div>
      {/if}
    {:else}
      <!-- Merged -->
      <div class="max-w-3xl mx-auto px-6 py-6 space-y-3">
        <h2 class="text-lg font-medium text-on-surface">Merged entities</h2>
        <!-- Every merge in the graph is reversible, and most were not confirmed
             by anybody: they were applied by sessions before a merge needed a
             person's confirmation. That is what this filter is for - it is the
             list to read through, not a status badge. -->
        <div class="flex flex-wrap items-center gap-2 text-xs font-ui">
          <button
            onclick={() => (unconfirmedOnly = !unconfirmedOnly)}
            class="rounded px-2 py-1 {unconfirmedOnly
              ? 'bg-primary-container text-on-surface'
              : 'text-on-surface-muted hover:bg-surface-alt'}"
          >Applied without a person confirming <span class="tabular-nums">{unconfirmedCount}</span></button>
          <span class="text-on-surface-muted">of {merges.length}</span>
        </div>
        {#if merges.length === 0}
          <p class="text-sm text-on-surface-muted">No merges yet. Confirmed merges appear here, each reversible.</p>
        {:else}
          {#each shownMerges as m (m.merge_id)}
            <div class="rounded-lg border border-border bg-surface p-4 space-y-2">
              <div class="flex items-baseline gap-2 flex-wrap">
                <a href={`/graph/${m.survivor_id}`} class="text-on-surface font-medium hover:underline">{m.canonical_name || m.survivor_name}</a>
                <span class="text-xs font-ui text-on-surface-muted">survivor · {m.victims.length} folded in</span>
                <span
                  class="text-xs font-ui {confirmedByPerson(m) ? 'text-on-surface-muted' : 'text-warning'}"
                  title={m.created_by ?? "no actor recorded"}
                >{confirmedByPerson(m) ? `confirmed by ${m.created_by?.split("/")[1]}` : "applied by a session"}</span>
                <span class="flex-1"></span>
                <button onclick={() => doUndo(m.merge_id)} disabled={busy} class="text-xs font-ui px-2 py-0.5 rounded border border-border text-on-surface-secondary cursor-pointer hover:bg-surface-alt disabled:opacity-40">Un-merge</button>
              </div>
              <div class="flex flex-wrap gap-1.5">
                {#each m.victims as v}
                  <span class="text-xs font-ui px-2 py-0.5 rounded border border-border/70 bg-surface-alt text-on-surface-secondary line-through decoration-on-surface-muted/50">{v.prior_name}</span>
                {/each}
              </div>
            </div>
          {/each}
        {/if}
      </div>
    {/if}
  </div>
</div>
