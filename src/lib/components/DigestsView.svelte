<script lang="ts">
  // Digests: what each model made of a record, judged against the record itself.
  //
  // Two shapes, both deliberate.
  //
  // LIST FIRST, then drill in - the same rhythm as Ingests. A permanent rail
  // stole width from the thing being read, and the reading is the work here.
  //
  // Inside, the INGEST sits on the left and the models' output on the right. The
  // pipeline reads left to right across the app: Ingests shows source | ingest,
  // Digests shows ingest | digest. Each view drops the stage behind it and adds
  // the next.
  //
  // The ingest pane is not decoration - it is the control. The audit's passages
  // are built FROM the claims, so source that produced no claim cannot appear
  // there; without the ingest beside it, "what did the models miss?" is
  // unanswerable, and that is the question this view exists to answer.
  import { onMount } from "svelte";
  import { marked } from "marked";
  import {
    fetchComparable,
    fetchComparison,
    fetchPredigest,
    saveJudgment,
    type ComparableIngest,
    type ModelComparison,
    type ModelJudgment,
    type Predigest,
  } from "$lib/api";
  import { bodyWordCount } from "$lib/ingest-plain";
  import AuditView from "./AuditView.svelte";

  let comparable = $state<ComparableIngest[]>([]);
  let selected = $state<string | null>(null);
  let comparison = $state<ModelComparison | null>(null);
  let judgment = $state<ModelJudgment | null>(null);
  // The PRE-DIGEST, not the ingest: it is the materialised, deterministic model
  // input - the precise bytes the model read, with irrelevant regions stripped
  // and timestamps removed. That distinction decides blame. Judging recall
  // against the ingest would fault a model for missing text the pre-digest never
  // showed it. It is also already clean markdown, so it renders as prose without
  // the ingest viewer's annotation pipeline. (ADR 0042; computed by the same
  // materialise() the digester runs, so preview == digest input byte-for-byte.)
  let predigest = $state<Predigest | null>(null);
  /** Models to show. Empty = all: with twenty models the reviewer narrows to the
   *  few being compared, but the default must never hide a model silently. */
  let hidden = $state<Set<string>>(new Set());
  let loading = $state(false);
  let error = $state<string | null>(null);

  let chosen = $state<string | null>(null);
  let notes = $state("");
  let saving = $state(false);
  let saveNote = $state<string | null>(null);

  let renderedBody = $derived(predigest ? marked.parse(predigest.body) : "");
  let words = $derived(predigest ? bodyWordCount(predigest.body) : 0);
  let title = $derived(comparable.find((c) => c.content_hash === selected)?.title ?? "");

  function syncUrl() {
    history.replaceState(null, "", "/digests" + (selected ? `?h=${selected}` : ""));
  }

  async function open(hash: string) {
    selected = hash;
    loading = true;
    error = null;
    comparison = null;
    judgment = null;
    predigest = null;
    hidden = new Set();
    saveNote = null;
    chosen = null;
    notes = "";
    syncUrl();
    try {
      const [r, pre] = await Promise.all([fetchComparison(hash), fetchPredigest(hash)]);
      comparison = r.comparison;
      judgment = r.judgment;
      chosen = r.judgment?.chosen_model ?? null;
      notes = r.judgment?.notes ?? "";
      predigest = pre;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  function backToList() {
    selected = null;
    comparison = null;
    predigest = null;
    error = null;
    history.replaceState(null, "", "/digests");
  }

  async function save() {
    if (!comparison || !chosen) return;
    saving = true;
    saveNote = null;
    error = null;
    try {
      judgment = await saveJudgment(comparison.content_hash, comparison.models, chosen, notes);
      saveNote = `Saved: ${chosen} marked better.`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  onMount(async () => {
    try {
      comparable = await fetchComparable();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const h = new URLSearchParams(window.location.search).get("h");
    if (h) open(h);
  });
</script>

{#if !selected}
  <!-- The list. -->
  <div class="flex-1 flex flex-col min-h-0 font-ui bg-surface">
    <div class="flex-none px-6 py-3 border-b border-border">
      <h1 class="text-sm font-semibold text-on-surface">Digests</h1>
      <p class="text-xs text-on-surface-muted mt-0.5">
        {comparable.length} record{comparable.length === 1 ? "" : "s"} digested by more than one model.
        Open one to read the ingest against what each model pulled out of it.
      </p>
    </div>
    {#if error}<p class="px-6 py-3 text-sm text-error">{error}</p>{/if}
    <div class="flex-1 overflow-auto">
      {#if comparable.length === 0}
        <p class="text-sm text-on-surface-muted p-6 max-w-prose leading-relaxed">
          No multi-model records yet. They appear once a record has been digested by
          more than one model (the digester writes them under
          <code class="font-mono text-xs">digests/variants/</code>).
        </p>
      {:else}
        {#each comparable as c (c.content_hash)}
          <button
            onclick={() => open(c.content_hash)}
            class="w-full text-left px-6 py-3 border-b border-border/50 cursor-pointer transition-colors hover:bg-surface-alt flex items-center gap-4"
          >
            <span class="min-w-0 flex-1">
              <span class="block text-sm text-on-surface leading-snug">{c.title}</span>
              <span class="block mt-0.5 text-[11px] text-on-surface-muted">
                {c.models.join(" · ")}
              </span>
            </span>
            <span class="flex-none text-[11px] text-on-surface-muted tabular-nums">
              {c.variant_count} model{c.variant_count === 1 ? "" : "s"}
            </span>
          </button>
        {/each}
      {/if}
    </div>
  </div>
{:else}
  <!-- Drilled in: ingest on the left, what the models made of it on the right. -->
  <div class="flex-1 flex flex-col min-h-0 font-ui">
    <header class="flex-none px-4 py-2.5 border-b border-border bg-surface-alt/60 flex flex-wrap items-center gap-x-3 gap-y-2">
      <button
        onclick={backToList}
        class="flex-none text-xs text-on-surface-secondary hover:text-on-surface cursor-pointer transition-colors flex items-center gap-1"
        title="Back to the digest list"
      >
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Digests
      </button>
      <span class="text-sm font-medium text-on-surface truncate max-w-sm">{title}</span>
      <span class="flex-1"></span>
      {#if loading}
        <span class="text-xs text-on-surface-muted">Loading…</span>
      {:else if comparison}
        <span class="text-xs text-on-surface-secondary">Which model did better?</span>
        {#each comparison.models as m (m)}
          <button
            onclick={() => { chosen = m; }}
            class="text-xs font-medium rounded px-2 py-1 cursor-pointer transition-colors
              {chosen === m
                ? 'bg-success text-on-success'
                : 'text-on-surface-secondary hover:bg-surface-alt border border-border'}"
          >
            {m}
          </button>
        {/each}
        <input
          bind:value={notes}
          placeholder="Why? (optional)"
          class="text-xs px-2 py-1 rounded border border-border bg-surface text-on-surface w-40"
        />
        <button
          onclick={save}
          disabled={!chosen || saving}
          class="text-xs font-medium rounded px-2.5 py-1 transition-colors
            {chosen && !saving
              ? 'bg-primary text-on-primary cursor-pointer hover:opacity-90'
              : 'bg-surface-alt text-on-surface-muted cursor-not-allowed'}"
        >
          {saving ? "Saving…" : judgment ? "Update" : "Save"}
        </button>
        {#if saveNote}
          <span class="text-xs text-success">{saveNote}</span>
        {:else if judgment?.chosen_model}
          <span class="text-xs text-on-surface-muted">was: {judgment.chosen_model}</span>
        {/if}
      {/if}
    </header>

    {#if error}<p class="flex-none px-6 py-2 text-sm text-error">{error}</p>{/if}

    <div class="flex-1 flex min-h-0">
      <!-- THE MODEL'S INPUT. The control for "what got missed?": read it and see
           what nothing pulled out of it. -->
      <div class="w-1/2 flex-none border-r border-border flex flex-col min-h-0 bg-surface">
        <div class="flex-none px-4 py-1.5 border-b border-border bg-surface-alt/40 flex items-center gap-2">
          <span class="text-[10px] font-semibold uppercase tracking-wide text-on-surface-muted">Pre-digest</span>
          <span class="text-[11px] text-on-surface-muted">exactly what the models read</span>
          {#if words}
            <span class="text-[11px] text-on-surface-muted tabular-nums">· {words} words</span>
          {/if}
          <span class="flex-1"></span>
          {#if predigest?.stored_matches === false}
            <span
              class="text-[10px] font-medium text-on-warning-container bg-warning-container/60 rounded px-1.5 py-0.5"
              title="The record has changed since it was digested - these models read an older input than the one shown"
            >input has changed since digest</span>
          {/if}
        </div>
        <div class="flex-1 overflow-auto px-5 py-4">
          {#if loading}
            <p class="text-sm text-on-surface-muted">Loading…</p>
          {:else if !predigest}
            <p class="text-sm text-on-surface-muted italic">No pre-digest available for this record.</p>
          {:else}
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            <div class="prose-ingest max-w-prose text-sm text-on-surface leading-relaxed">
              {@html renderedBody}
            </div>
          {/if}
        </div>
      </div>

      <!-- WHAT THE MODELS MADE OF IT. -->
      <div class="flex-1 flex flex-col min-h-0 border-l border-border">
        {#key selected}
          <AuditView hash={selected} />
        {/key}
      </div>
    </div>
  </div>
{/if}
