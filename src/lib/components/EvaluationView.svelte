<script lang="ts">
  import {
    AuditAccessError,
    fetchEvaluation,
    fetchEvaluations,
    saveSearchEvaluationJudgements,
    type AccountEvaluationDetail,
    type EvaluationEntry,
    type SearchEvaluationDetail,
  } from "$lib/api";
  import AccountChronologyView from "./AccountChronologyView.svelte";

  const SEARCH_ID = "search-reranker-minilm-vs-granite";
  const ACCOUNT_ID = "account-chronology";

  let entries = $state<EvaluationEntry[]>([]);
  let selectedId = $state(
    new URLSearchParams(window.location.search).get("evaluation") ?? ACCOUNT_ID,
  );
  let searchDetail = $state<SearchEvaluationDetail | null>(null);
  let accountDetail = $state<AccountEvaluationDetail | null>(null);
  let selectedQuery = $state(0);
  let judgements = $state<Record<string, { decision: string; note: string }>>({});
  let judgementsSha = $state<string | null>(null);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state("");
  let accessStatus = $state<number | null>(null);
  let saved = $state(false);

  let selectedEntry = $derived(entries.find((entry) => entry.id === selectedId) ?? null);
  let query = $derived(searchDetail?.queries[selectedQuery] ?? null);

  fetchEvaluations()
    .then((registry) => {
      entries = registry.evaluations;
      if (!entries.some((entry) => entry.id === selectedId)) selectedId = entries[0]?.id ?? "";
    })
    .catch(handleError);

  $effect(() => {
    const evaluationId = selectedId;
    if (!evaluationId || !entries.some((entry) => entry.id === evaluationId)) return;
    history.replaceState(null, "", `/evaluations?evaluation=${encodeURIComponent(evaluationId)}`);
    loading = true;
    error = "";
    saved = false;
    searchDetail = null;
    accountDetail = null;
    if (evaluationId === SEARCH_ID) {
      fetchEvaluation<SearchEvaluationDetail>(evaluationId)
        .then((detail) => {
          if (selectedId !== evaluationId) return;
          searchDetail = detail;
          judgements = structuredClone(detail.judgements);
          judgementsSha = detail.judgements_sha256;
          selectedQuery = 0;
          loading = false;
        })
        .catch((reason) => {
          if (selectedId === evaluationId) handleError(reason);
        });
    } else if (evaluationId === ACCOUNT_ID) {
      fetchEvaluation<AccountEvaluationDetail>(evaluationId)
        .then((detail) => {
          if (selectedId !== evaluationId) return;
          accountDetail = detail;
          loading = false;
        })
        .catch((reason) => {
          if (selectedId === evaluationId) handleError(reason);
        });
    } else {
      loading = false;
    }
  });

  function handleError(reason: unknown) {
    if (reason instanceof AuditAccessError) accessStatus = reason.status;
    else error = reason instanceof Error ? reason.message : String(reason);
    loading = false;
  }

  function judgement(queryId: string) {
    return judgements[queryId] ?? { decision: "defer", note: "" };
  }

  function setDecision(queryId: string, decision: string) {
    judgements[queryId] = { ...judgement(queryId), decision };
    saved = false;
  }

  function setNote(queryId: string, note: string) {
    judgements[queryId] = { ...judgement(queryId), note };
    saved = false;
  }

  async function saveJudgements() {
    const viewed = searchDetail;
    if (saving || !viewed) return;
    saving = true;
    error = "";
    saved = false;
    try {
      const detail = await saveSearchEvaluationJudgements({
        base_sha256: judgementsSha,
        fixture_sha256: viewed.fixture.sha256,
        judgements,
      });
      searchDetail = detail;
      judgements = structuredClone(detail.judgements);
      judgementsSha = detail.judgements_sha256;
      saved = true;
    } catch (reason) {
      handleError(reason);
    } finally {
      saving = false;
    }
  }

  function statusLabel(status: string) {
    return status.replaceAll("-", " ");
  }
</script>

{#if accessStatus === 401}
  <p class="p-6 text-sm text-on-surface-muted">Log in as an administrator to inspect evaluations.</p>
{:else if accessStatus === 403}
  <p class="p-6 text-sm text-on-surface-muted">Evaluation data is restricted to administrators.</p>
{:else}
  <div class="flex min-h-0 flex-1 flex-col bg-surface lg:flex-row">
    <aside class="flex-none border-b border-border bg-surface-alt p-4 lg:w-80 lg:overflow-y-auto lg:border-r lg:border-b-0">
      <div class="mb-4">
        <p class="font-ui text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">Reference desk</p>
        <h1 class="mt-1 font-serif text-2xl">Evaluations</h1>
        <p class="mt-1 text-xs text-on-surface-muted">Registry status, provenance, evidence and authenticated review.</p>
      </div>
      <div class="flex gap-2 overflow-x-auto lg:flex-col lg:overflow-visible">
        {#each entries as entry}
          <button
            class="min-w-64 border p-3 text-left transition-colors lg:min-w-0 {selectedId === entry.id ? 'border-primary bg-surface' : 'border-border bg-surface-alt hover:bg-surface'}"
            onclick={() => (selectedId = entry.id)}
          >
            <span class="block text-sm font-semibold">{entry.title}</span>
            <span class="mt-1 block text-[11px] uppercase tracking-wide text-on-surface-muted">{statusLabel(entry.status)}</span>
          </button>
        {/each}
      </div>
    </aside>

    <main class="min-w-0 flex-1 overflow-y-auto">
      {#if selectedEntry}
        <header class="border-b border-border bg-surface-container-low px-5 py-5 sm:px-8">
          <div class="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <p class="font-mono text-[11px] text-on-surface-muted">{selectedEntry.id}</p>
              <h2 class="mt-1 font-serif text-3xl">{selectedEntry.title}</h2>
            </div>
            <span class="border border-outline-variant bg-surface px-2 py-1 text-xs uppercase tracking-wide">Status: {statusLabel(selectedEntry.status)}</span>
          </div>
          <p class="mt-3 max-w-4xl text-sm text-on-surface-muted">{selectedEntry.purpose}</p>
          <div class="mt-4 border-l-4 border-primary bg-surface px-4 py-3">
            <p class="text-[10px] font-semibold uppercase tracking-wide text-on-surface-muted">Recorded decision</p>
            <p class="mt-1 font-medium">{selectedEntry.decision}</p>
          </div>
          <div class="mt-4 grid gap-3 text-xs md:grid-cols-3">
            <div><span class="font-semibold">Gold: </span>{statusLabel(selectedEntry.gold.status)}<p class="mt-1 text-on-surface-muted">{selectedEntry.gold.provenance}</p></div>
            <div><span class="font-semibold">Rights: </span><span class="text-on-surface-muted">{selectedEntry.limits.rights}</span></div>
            <div><span class="font-semibold">Routes: </span><span class="text-on-surface-muted">{selectedEntry.limits.routes}</span></div>
          </div>
        </header>
      {/if}

      {#if loading}
        <p class="p-8 text-sm text-on-surface-muted">Loading evaluation evidence...</p>
      {:else if error}
        <p class="p-8 text-sm text-error">{error}</p>
      {:else if searchDetail && query}
        <div class="space-y-6 p-5 sm:p-8">
          <section class="grid gap-3 sm:grid-cols-3">
            <div class="border border-border p-3"><span class="text-xs text-on-surface-muted">Fixture</span><p class="font-mono text-xs">{searchDetail.fixture.license} · {searchDetail.fixture.sha256.slice(0, 12)}</p></div>
            <div class="border border-border p-3"><span class="text-xs text-on-surface-muted">Controlled latency</span><p class="text-sm">MiniLM {searchDetail.models.minilm.performance.query_latency_median_ms.toFixed(1)} ms · Granite {searchDetail.models.granite.performance.query_latency_median_ms.toFixed(1)} ms</p></div>
            <div class="border border-border p-3"><span class="text-xs text-on-surface-muted">Replacement gate</span><p class="font-semibold">MiniLM retained; Granite not adopted</p></div>
          </section>

          <label class="block text-xs font-semibold uppercase tracking-wide text-on-surface-muted">
            Query
            <select class="mt-1 block w-full border border-outline-variant bg-surface px-3 py-2 text-sm normal-case" bind:value={selectedQuery}>
              {#each searchDetail.queries as item, index}<option value={index}>{item.query}</option>{/each}
            </select>
          </label>
          <div>
            <p class="text-xl font-medium">{query.query}</p>
            <p class="mt-1 text-xs text-on-surface-muted">Target: {query.target.name} · {query.target.node_type} · {query.total_graph_relevant} graph-linked claims</p>
          </div>

          <div class="grid gap-4 xl:grid-cols-2">
            {#each [["minilm", "MiniLM"], ["granite", "Granite English R2"]] as [model, label]}
              <section class="border border-border">
                <header class="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-surface-alt px-4 py-3">
                  <h3 class="font-semibold">{label}</h3>
                  <span class="text-xs text-on-surface-muted">Top 10</span>
                </header>
                {#each query.rankings[model as "minilm" | "granite"] as claim}
                  <article class="grid grid-cols-[2rem_1fr] gap-2 border-b border-border p-3 last:border-b-0">
                    <span class="font-mono text-xs text-on-surface-muted">{claim.rank}</span>
                    <div>
                      <span class="mb-1 inline-block px-1.5 py-0.5 text-[10px] font-semibold uppercase {claim.relevance ? 'bg-success/15 text-success' : 'bg-surface-container text-on-surface-muted'}">{claim.relevance ? "graph relevant" : "not graph relevant"}</span>
                      <p class="text-sm leading-relaxed">{claim.text}</p>
                    </div>
                  </article>
                {/each}
              </section>
            {/each}
          </div>

          <section class="border border-primary/40 bg-primary/5 p-4">
            <h3 class="font-semibold">Administrator judgement for this query</h3>
            <div class="mt-3 flex flex-wrap gap-2">
              {#each [["minilm", "MiniLM better"], ["granite", "Granite better"], ["tie", "Equivalent"], ["defer", "Defer"]] as [decision, label]}
                <button class="border px-3 py-1.5 text-sm {judgement(query.id).decision === decision ? 'border-primary bg-primary text-on-primary' : 'border-outline-variant bg-surface'}" onclick={() => setDecision(query.id, decision)}>{label}</button>
              {/each}
            </div>
            <label class="mt-3 block text-xs text-on-surface-muted">Reason <textarea class="mt-1 block min-h-20 w-full border border-outline-variant bg-surface p-2 text-sm text-on-surface" value={judgement(query.id).note} oninput={(event) => setNote(query.id, event.currentTarget.value)}></textarea></label>
            <div class="mt-3 flex items-center gap-3">
              <button class="bg-primary px-4 py-2 text-sm font-medium text-on-primary disabled:opacity-50" disabled={saving} onclick={saveJudgements}>{saving ? "Saving..." : "Save authenticated judgements"}</button>
              {#if saved}<span class="text-xs text-success">Saved.</span>{/if}
              {#if searchDetail.judgement_provenance}<span class="text-xs text-on-surface-muted">Last saved {searchDetail.judgement_provenance.updated_at} by {searchDetail.judgement_provenance.reviewer.name}</span>{/if}
            </div>
          </section>
        </div>
      {:else if accountDetail}
        <div class="space-y-5 p-5 sm:p-8">
          {#each accountDetail.records as record}
            <section class="border border-border bg-surface-alt p-4">
              <div class="flex flex-wrap items-center gap-2">
                <h3 class="font-semibold">{record.name}</h3>
                <span class="text-xs uppercase text-on-surface-muted">gold: {statusLabel(record.gold_status)}</span>
                <span class="text-xs uppercase text-on-surface-muted">prediction: {statusLabel(record.prediction.status)}</span>
              </div>
              {#if record.prediction.reason}<p class="mt-2 text-xs text-on-surface-muted">{record.prediction.reason}</p>{/if}
            </section>
            <AccountChronologyView hash={record.record_hash} />
          {/each}
        </div>
      {:else if selectedEntry}
        <p class="p-8 text-sm text-on-surface-muted">This registry entry has no interactive Workbench page yet. Its status, provenance, limits and decision remain inspectable above.</p>
      {/if}
    </main>
  </div>
{/if}
