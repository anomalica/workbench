<script lang="ts">
  import {
    AuditAccessError,
    fetchEvaluation,
    fetchEvaluations,
    saveSearchEvaluationJudgements,
    type AccountEvaluationDetail,
    type AudioEvaluationDetail,
    type DigestEvaluationDetail,
    type EvaluationEntry,
    type EvaluationState,
    type PdfEvaluationDetail,
    type SearchEvaluationDetail,
  } from "$lib/api";
  import AccountChronologyView from "./AccountChronologyView.svelte";

  const AUDIO_ID = "audio-community1-exclusive";
  const PDF_ID = "pdf-native-text-extraction";
  const SEARCH_ID = "search-reranker-minilm-vs-granite";
  const DIGEST_ID = "digest-evaluation-corpus";
  const ACCOUNT_ID = "account-chronology";

  let entries = $state<EvaluationEntry[]>([]);
  let selectedId = $state(
    new URLSearchParams(window.location.search).get("evaluation") ?? ACCOUNT_ID,
  );
  let audioDetail = $state<AudioEvaluationDetail | null>(null);
  let pdfDetail = $state<PdfEvaluationDetail | null>(null);
  let searchDetail = $state<SearchEvaluationDetail | null>(null);
  let digestDetail = $state<DigestEvaluationDetail | null>(null);
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
  let detailState = $derived.by((): EvaluationState | null => {
    if (audioDetail) return audioDetail.state;
    if (pdfDetail) return pdfDetail.state;
    if (searchDetail) return searchDetail.state;
    if (digestDetail) return digestDetail.state;
    if (accountDetail) return accountDetail.state;
    return null;
  });

  fetchEvaluations()
    .then((registry) => {
      entries = registry.evaluations;
      if (!entries.some((entry) => entry.id === selectedId)) selectedId = entries[0]?.id ?? "";
    })
    .catch(handleError);

  $effect(() => {
    const evaluationId = selectedId;
    const entry = entries.find((candidate) => candidate.id === evaluationId);
    if (!evaluationId || !entry) return;
    history.replaceState(null, "", `/evaluations?evaluation=${encodeURIComponent(evaluationId)}`);
    loading = true;
    error = "";
    accessStatus = null;
    saved = false;
    audioDetail = null;
    pdfDetail = null;
    searchDetail = null;
    digestDetail = null;
    accountDetail = null;

    if (entry.sync_error || !entry.detail_available) {
      loading = false;
      return;
    }

    if (evaluationId === AUDIO_ID) loadDetail(evaluationId, "audio");
    else if (evaluationId === PDF_ID) loadDetail(evaluationId, "pdf");
    else if (evaluationId === SEARCH_ID) loadDetail(evaluationId, "search");
    else if (evaluationId === DIGEST_ID) loadDetail(evaluationId, "digest");
    else if (evaluationId === ACCOUNT_ID) loadDetail(evaluationId, "account");
    else loading = false;
  });

  async function loadDetail(
    evaluationId: string,
    kind: "audio" | "pdf" | "search" | "digest" | "account",
  ) {
    try {
      if (kind === "audio") {
        const detail = await fetchEvaluation<AudioEvaluationDetail>(evaluationId);
        if (selectedId !== evaluationId) return;
        audioDetail = detail;
      } else if (kind === "pdf") {
        const detail = await fetchEvaluation<PdfEvaluationDetail>(evaluationId);
        if (selectedId !== evaluationId) return;
        pdfDetail = detail;
      } else if (kind === "search") {
        const detail = await fetchEvaluation<SearchEvaluationDetail>(evaluationId);
        if (selectedId !== evaluationId) return;
        searchDetail = detail;
        judgements = structuredClone(detail.judgements);
        judgementsSha = detail.judgements_sha256;
        selectedQuery = 0;
      } else if (kind === "digest") {
        const detail = await fetchEvaluation<DigestEvaluationDetail>(evaluationId);
        if (selectedId !== evaluationId) return;
        digestDetail = detail;
      } else {
        const detail = await fetchEvaluation<AccountEvaluationDetail>(evaluationId);
        if (selectedId !== evaluationId) return;
        accountDetail = detail;
      }
      loading = false;
    } catch (reason) {
      if (selectedId === evaluationId) handleError(reason);
    }
  }

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

  function metricLabel(metric: string) {
    return metric.replaceAll("_", " ");
  }

  function metricValue(metric: string, value: number) {
    if (metric.endsWith("_pct")) return `${value.toFixed(1)}%`;
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }

  function goldProgress(state: EvaluationState) {
    const { reviewed, total, unit } = state.gold;
    return `${reviewed} of ${total} ${unit}`;
  }

  function digestRoute(recordId: string) {
    return `/${recordId.replace(/^sha256:/, "").slice(0, 56)}#gold`;
  }
</script>

{#if accessStatus === 401}
  <p class="p-6 text-sm text-on-surface-muted">Log in as an administrator to inspect evaluations.</p>
{:else if accessStatus === 403}
  <p class="p-6 text-sm text-on-surface-muted">Evaluation data is restricted to administrators.</p>
{:else}
  <div class="flex min-h-0 flex-1 flex-col bg-surface lg:flex-row">
    <aside
      class="flex-none border-b border-border bg-surface-alt p-4 lg:w-96 lg:overflow-y-auto lg:border-r lg:border-b-0"
    >
      <div class="mb-4">
        <p class="font-ui text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">
          Reference desk
        </p>
        <h1 class="mt-1 font-serif text-2xl">Evaluations</h1>
        <p class="mt-1 text-xs text-on-surface-muted">
          Current evidence, gold progress and review work.
        </p>
      </div>
      <div class="flex gap-3 overflow-x-auto lg:grid lg:grid-cols-1 lg:overflow-visible">
        {#each entries as entry}
          <article
            class="min-w-[18rem] border p-4 lg:min-w-0 {selectedId === entry.id
              ? 'border-primary bg-surface'
              : 'border-border bg-surface-alt'}"
          >
            <h2 class="text-sm font-semibold">{entry.title}</h2>
            <p class="mt-1 text-xs leading-relaxed text-on-surface-muted">{entry.purpose}</p>
            {#if entry.sync_error}
              <p class="mt-3 border-l-2 border-error pl-2 text-xs text-error" role="alert">
                {entry.sync_error}
              </p>
            {:else if entry.state}
              <div class="mt-3 space-y-1 text-xs">
                <p class="font-semibold uppercase tracking-wide">
                  {statusLabel(entry.state.status)}
                </p>
                <p class="text-on-surface-muted">
                  Gold: {statusLabel(entry.state.gold.status)} · {goldProgress(entry.state)}
                </p>
                {#if entry.state.decision}
                  <p class="leading-relaxed">{entry.state.decision.summary}</p>
                {:else if entry.state.blocked_reason}
                  <p class="text-on-surface-muted">{entry.state.blocked_reason}</p>
                {/if}
              </div>
            {:else}
              <p class="mt-3 text-xs text-on-surface-muted">Current state unavailable.</p>
            {/if}
            <details class="mt-3 border-t border-border pt-2 text-xs text-on-surface-muted">
              <summary class="cursor-pointer font-medium text-on-surface">Rights and routes methodology</summary>
              <p class="mt-2"><span class="font-semibold">Rights:</span> {entry.limits.rights}</p>
              <p class="mt-1"><span class="font-semibold">Routes:</span> {entry.limits.routes}</p>
            </details>
            <button
              class="mt-4 w-full bg-primary px-3 py-2 text-sm font-medium text-on-primary disabled:opacity-60"
              disabled={selectedId === entry.id}
              onclick={() => (selectedId = entry.id)}
            >
              {selectedId === entry.id ? "Evaluation selected" : "Open evaluation"}
            </button>
          </article>
        {/each}
      </div>
    </aside>

    <main class="min-w-0 flex-1 overflow-y-auto">
      {#if selectedEntry}
        <header class="border-b border-border bg-surface-container-low px-5 py-5 sm:px-8">
          <p class="font-mono text-[11px] text-on-surface-muted">{selectedEntry.id}</p>
          <div class="mt-1 flex flex-wrap items-baseline justify-between gap-3">
            <h2 class="font-serif text-3xl">{selectedEntry.title}</h2>
            {#if detailState}
              <span
                class="border border-outline-variant bg-surface px-2 py-1 text-xs uppercase tracking-wide"
              >Current evidence: {statusLabel(detailState.status)}</span>
            {/if}
          </div>
          <p class="mt-3 max-w-4xl text-sm text-on-surface-muted">{selectedEntry.purpose}</p>
          {#if detailState?.decision}
            <div class="mt-4 border-l-4 border-primary bg-surface px-4 py-3">
              <p class="text-[10px] font-semibold uppercase tracking-wide text-on-surface-muted">
                Evidence-bound decision
              </p>
              <p class="mt-1 font-medium">{detailState.decision.summary}</p>
            </div>
          {/if}
        </header>
      {/if}

      {#if loading}
        <p class="p-8 text-sm text-on-surface-muted">Loading evaluation evidence...</p>
      {:else if error}
        <p class="p-8 text-sm text-error">{error}</p>
      {:else if selectedEntry?.sync_error}
        <p class="p-8 text-sm text-error">{selectedEntry.sync_error}</p>
      {:else if audioDetail}
        <div class="space-y-6 p-5 sm:p-8">
          <section class="border-l-4 border-primary bg-surface-alt p-4">
            <h3 class="font-semibold">Same-model comparison</h3>
            <p class="mt-1 text-sm text-on-surface-muted">{audioDetail.comparison_note}</p>
          </section>
          <section>
            <h3 class="font-serif text-2xl">Aggregate regular versus exclusive</h3>
            <div class="mt-3 grid gap-4 sm:grid-cols-2">
              {#each ["regular", "exclusive"] as strategy}
                <div class="border border-border p-4">
                  <h4 class="font-semibold capitalize">{strategy}</h4>
                  <dl class="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                    {#each Object.entries(audioDetail.aggregate[strategy as "regular" | "exclusive"]) as [metric, value]}
                      <dt class="text-on-surface-muted">{metricLabel(metric)}</dt>
                      <dd class="text-right font-mono">{metricValue(metric, value)}</dd>
                    {/each}
                  </dl>
                </div>
              {/each}
            </div>
          </section>
          <section>
            <h3 class="font-serif text-2xl">Per-record comparisons</h3>
            <div class="mt-3 space-y-4">
              {#each audioDetail.records as record}
                <article class="border border-border p-4">
                  <h4 class="break-all font-mono text-xs">{record.record_id}</h4>
                  <div class="mt-3 grid gap-4 sm:grid-cols-2">
                    {#each ["regular", "exclusive"] as strategy}
                      <div>
                        <p class="text-xs font-semibold uppercase tracking-wide">{strategy}</p>
                        <dl class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                          {#each Object.entries(record[strategy as "regular" | "exclusive"]) as [metric, value]}
                            <dt class="text-on-surface-muted">{metricLabel(metric)}</dt>
                            <dd class="text-right font-mono">{metricValue(metric, value)}</dd>
                          {/each}
                        </dl>
                      </div>
                    {/each}
                  </div>
                </article>
              {/each}
            </div>
          </section>
          <p class="border border-border bg-surface-alt p-4 text-sm">{audioDetail.production_note}</p>
        </div>
      {:else if pdfDetail}
        <div class="space-y-6 p-5 sm:p-8">
          <section class="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(16rem,0.45fr)]">
            <div>
              <h3 class="font-serif text-2xl">Extraction evidence</h3>
              <p class="mt-2 text-sm text-on-surface-muted">Method: {pdfDetail.method}</p>
            </div>
            <dl class="grid grid-cols-2 gap-x-4 gap-y-2 border border-border p-4 text-xs">
              {#each Object.entries(pdfDetail.aggregate) as [metric, value]}
                <dt class="text-on-surface-muted">{metricLabel(metric)}</dt>
                <dd class="text-right font-mono">{metricValue(metric, value)}</dd>
              {/each}
            </dl>
          </section>
          <section class="grid gap-5 xl:grid-cols-2">
            {#each pdfDetail.examples as example}
              <article class="border border-border">
                <header class="border-b border-border bg-surface-alt px-4 py-3">
                  <h3 class="font-semibold">
                    {example.kind === "normal-page" ? "Normal-page evidence" : "Two-column evidence"}
                  </h3>
                  <p class="text-xs text-on-surface-muted">File page {example.file_page}</p>
                </header>
                <div class="grid gap-px bg-border sm:grid-cols-2">
                  <div class="bg-surface p-4">
                    <h4 class="text-xs font-semibold uppercase tracking-wide text-on-surface-muted">Native</h4>
                    <p class="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{example.native}</p>
                  </div>
                  <div class="bg-surface p-4">
                    <h4 class="text-xs font-semibold uppercase tracking-wide text-on-surface-muted">Reviewed</h4>
                    <p class="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{example.reviewed}</p>
                  </div>
                </div>
                <dl class="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-border bg-surface-alt p-4 text-xs">
                  {#each Object.entries(example.metrics) as [metric, value]}
                    <dt class="text-on-surface-muted">{metricLabel(metric)}</dt>
                    <dd class="text-right font-mono">{metricValue(metric, value)}</dd>
                  {/each}
                </dl>
              </article>
            {/each}
          </section>
          <section class="border-l-4 border-primary bg-surface-alt p-4">
            <h3 class="font-semibold">Production note</h3>
            <p class="mt-1 text-sm text-on-surface-muted">{pdfDetail.production_note}</p>
          </section>
        </div>
      {:else if searchDetail && query}
        <div class="space-y-6 p-5 sm:p-8">
          <section class="grid gap-3 sm:grid-cols-3">
            <div class="border border-border p-3"><span class="text-xs text-on-surface-muted">Fixture</span><p class="font-mono text-xs">{searchDetail.fixture.license} · {searchDetail.fixture.sha256.slice(0, 12)}</p></div>
            <div class="border border-border p-3"><span class="text-xs text-on-surface-muted">Controlled latency</span><p class="text-sm">MiniLM {searchDetail.models.minilm.performance.query_latency_median_ms.toFixed(1)} ms · Granite {searchDetail.models.granite.performance.query_latency_median_ms.toFixed(1)} ms</p></div>
            <div class="border border-border p-3"><span class="text-xs text-on-surface-muted">Replacement gate</span><p class="font-semibold">{searchDetail.comparison.replace_minilm ? "Granite adopted" : "MiniLM retained; Granite not adopted"}</p></div>
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
            <div class="mt-3 flex flex-wrap items-center gap-3">
              <button class="bg-primary px-4 py-2 text-sm font-medium text-on-primary disabled:opacity-50" disabled={saving} onclick={saveJudgements}>{saving ? "Saving..." : "Save authenticated judgements"}</button>
              {#if saved}<span class="text-xs text-success">Saved.</span>{/if}
              {#if searchDetail.judgement_provenance}<span class="text-xs text-on-surface-muted">Last saved {searchDetail.judgement_provenance.updated_at} by {searchDetail.judgement_provenance.reviewer.name}</span>{/if}
            </div>
          </section>
        </div>
      {:else if digestDetail}
        <div class="space-y-5 p-5 sm:p-8">
          <div>
            <h3 class="font-serif text-2xl">Needs reference highlights: choose source passages a good digest must preserve</h3>
            <p class="mt-2 max-w-3xl text-sm text-on-surface-muted">
              Future digest outputs are checked against the passages selected here, so the reference set records what each output must preserve.
            </p>
          </div>
          <div class="grid gap-4 xl:grid-cols-2">
            {#each digestDetail.items as item}
              <article class="flex flex-col border border-border bg-surface-alt p-4">
                <p class="break-all font-mono text-xs text-on-surface-muted">{item.record_id}</p>
                <p class="mt-3 text-sm font-semibold">
                  {item.gold.reviewed} reference {item.gold.reviewed === 1 ? "passage" : "passages"} selected
                </p>
                <p class="mt-1 text-xs text-on-surface-muted">
                  Future outputs for this record will be checked against these passages.
                </p>
                {#if item.blocked_reason}<p class="mt-2 text-xs text-error">{item.blocked_reason}</p>{/if}
                <a class="mt-4 self-start bg-primary px-4 py-2 text-sm font-medium text-on-primary" href={digestRoute(item.record_id)}>Choose reference passages</a>
              </article>
            {/each}
          </div>
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
        <p class="p-8 text-sm text-on-surface-muted">No working detail evidence is available for this evaluation.</p>
      {/if}
    </main>
  </div>
{/if}
