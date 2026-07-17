<script lang="ts">
  // Digests: choose between the models that digested a record.
  //
  // One surface, deliberately. This used to be two: a "Models" view holding the
  // verdict, and a per-record "Audit" sub-tab holding the evidence the verdict
  // should rest on - buried three levels down inside a record, where nobody
  // found it. Both were doing the same job. So the evidence and the choice live
  // together: pick a record on the left, read what each model made of the source
  // chunk by chunk, and mark which one won without leaving the page.
  import { onMount } from "svelte";
  import {
    fetchComparable,
    fetchComparison,
    saveJudgment,
    type ComparableIngest,
    type ModelComparison,
    type ModelJudgment,
  } from "$lib/api";
  import AuditView from "./AuditView.svelte";

  let comparable = $state<ComparableIngest[]>([]);
  let selected = $state<string | null>(null);
  let comparison = $state<ModelComparison | null>(null);
  let judgment = $state<ModelJudgment | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

  let chosen = $state<string | null>(null);
  let notes = $state("");
  let saving = $state(false);
  let saveNote = $state<string | null>(null);

  function syncUrl() {
    history.replaceState(null, "", "/digests" + (selected ? `?h=${selected}` : ""));
  }

  async function select(hash: string) {
    selected = hash;
    loading = true;
    error = null;
    comparison = null;
    judgment = null;
    saveNote = null;
    chosen = null;
    notes = "";
    syncUrl();
    try {
      const r = await fetchComparison(hash);
      comparison = r.comparison;
      judgment = r.judgment;
      chosen = r.judgment?.chosen_model ?? null;
      notes = r.judgment?.notes ?? "";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
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

  let title = $derived(comparable.find((c) => c.content_hash === selected)?.title ?? "");

  onMount(async () => {
    try {
      comparable = await fetchComparable();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const h = new URLSearchParams(window.location.search).get("h");
    if (h) select(h);
    else if (comparable.length === 1) select(comparable[0].content_hash);
  });
</script>

<div class="flex-1 flex min-h-0 font-ui">
  <!-- Records that have more than one model's digest to choose between. -->
  <div class="w-72 flex-none border-r border-border flex flex-col min-h-0 bg-surface">
    <div class="px-4 py-2 border-b border-border flex-none text-xs text-on-surface-secondary">
      {comparable.length} ingest{comparable.length === 1 ? "" : "s"} with multiple models
    </div>
    <div class="flex-1 overflow-auto">
      {#if comparable.length === 0}
        <p class="text-sm text-on-surface-muted p-4 leading-relaxed">
          No multi-model ingests yet. They appear once a record has been digested by
          more than one model (the digester writes them under
          <code class="font-mono text-xs">digests/variants/</code>).
        </p>
      {:else}
        {#each comparable as c (c.content_hash)}
          <button
            onclick={() => select(c.content_hash)}
            class="w-full text-left px-4 py-2.5 border-b border-border/40 cursor-pointer transition-colors
              {selected === c.content_hash ? 'bg-primary/10' : 'hover:bg-surface-alt'}"
          >
            <div class="text-sm text-on-surface leading-snug">{c.title}</div>
            <div class="mt-0.5 text-[11px] text-on-surface-muted">{c.models.join(" vs ")}</div>
          </button>
        {/each}
      {/if}
    </div>
  </div>

  <div class="flex-1 flex flex-col min-h-0">
    {#if error}
      <p class="px-6 py-3 text-sm text-error flex-none">{error}</p>
    {/if}

    {#if !selected}
      <p class="px-6 py-6 text-sm text-on-surface-muted">
        Select an ingest to see what each model made of it.
      </p>
    {:else}
      <!-- The verdict sits ABOVE the evidence, on the same surface: the whole
           point is to choose while looking at what each model produced. -->
      <header class="flex-none px-4 py-2.5 border-b border-border bg-surface-alt/60 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span class="text-sm font-medium text-on-surface truncate max-w-md" {title}>{title}</span>
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
            class="text-xs px-2 py-1 rounded border border-border bg-surface text-on-surface w-48"
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

      <!-- The evidence: source chunk by chunk, a column per model. -->
      {#key selected}
        <AuditView hash={selected} />
      {/key}
    {/if}
  </div>
</div>
