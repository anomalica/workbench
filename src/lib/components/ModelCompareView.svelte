<script lang="ts">
  import { onMount } from "svelte";
  import {
    fetchComparable,
    fetchComparison,
    saveJudgment,
    type ComparableIngest,
    type ModelComparison,
    type ModelJudgment,
    type ModelVariant,
  } from "$lib/api";

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

  function modelLabel(m: { model: string; prompt_variant?: string | null }): string {
    return m.prompt_variant ? `${m.model} (${m.prompt_variant})` : m.model;
  }

  function syncUrl() {
    history.replaceState(null, "", "/models" + (selected ? `?h=${selected}` : ""));
  }

  async function select(hash: string) {
    selected = hash;
    loading = true;
    error = null;
    comparison = null;
    judgment = null;
    saveNote = null;
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

  function fmtWall(s?: number | null): string {
    if (s == null) return "";
    return s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  }

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

<div class="flex-1 flex min-h-0">
  <!-- Comparable ingests -->
  <div class="w-72 flex-none border-r border-border flex flex-col min-h-0">
    <div class="px-4 py-2 border-b border-border flex-none text-xs font-ui text-on-surface-secondary">
      {comparable.length} ingest{comparable.length === 1 ? "" : "s"} with multiple models
    </div>
    <div class="flex-1 overflow-auto">
      {#if comparable.length === 0}
        <p class="text-sm text-on-surface-muted p-4">
          No multi-model ingests yet. They appear once a record is digested by more than one model
          (the digester writes them under <code class="font-mono">digests/variants/</code>).
        </p>
      {:else}
        {#each comparable as c (c.content_hash)}
          <button
            onclick={() => select(c.content_hash)}
            class="w-full text-left px-4 py-2.5 border-b border-border/40 cursor-pointer transition-colors
              {selected === c.content_hash ? 'bg-primary/10' : 'hover:bg-surface-alt'}"
          >
            <div class="text-sm text-on-surface truncate">{c.title}</div>
            <div class="mt-0.5 text-[11px] font-ui text-on-surface-muted">{c.models.join(" vs ")}</div>
          </button>
        {/each}
      {/if}
    </div>
  </div>

  <!-- Comparison -->
  <div class="flex-1 overflow-auto">
    {#if error}<p class="px-6 py-4 text-sm text-error">{error}</p>{/if}
    {#if loading}
      <p class="px-6 py-6 text-sm text-on-surface-muted">Loading comparison...</p>
    {:else if !comparison}
      <p class="px-6 py-6 text-sm text-on-surface-muted">Select an ingest to compare its models.</p>
    {:else}
      {@const cmp = comparison}
      <div class="px-6 py-5 space-y-5 max-w-6xl">
        <h2 class="text-lg font-medium text-on-surface">{cmp.title}</h2>

        <!-- Judge -->
        <div class="rounded-lg border border-border bg-surface-alt px-4 py-3 space-y-2">
          <div class="flex items-baseline gap-2 flex-wrap">
            <span class="text-sm font-medium text-on-surface">Which model is better?</span>
            {#each cmp.per_model as m}
              <button
                onclick={() => (chosen = m.model)}
                class="text-xs font-ui px-2.5 py-1 rounded border cursor-pointer transition-colors
                  {chosen === m.model ? 'bg-success text-on-success border-success' : 'bg-surface border-border text-on-surface-secondary hover:bg-surface-alt'}"
              >{modelLabel(m)}</button>
            {/each}
          </div>
          <div class="flex items-center gap-2 flex-wrap">
            <input
              type="text"
              bind:value={notes}
              placeholder="why? (optional notes)"
              class="flex-1 min-w-[240px] px-2 py-1 rounded border border-border bg-surface text-on-surface text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <button
              onclick={save}
              disabled={saving || !chosen}
              class="px-3 py-1 rounded bg-primary text-on-primary text-sm font-medium cursor-pointer disabled:opacity-40 hover:opacity-90"
            >{saving ? "Saving..." : "Save judgment"}</button>
          </div>
          {#if saveNote}<p class="text-xs text-success">{saveNote}</p>{/if}
          {#if judgment && !saveNote}
            <p class="text-xs text-on-surface-muted">
              Current: <span class="text-on-surface">{judgment.chosen_model}</span>
              {#if judgment.judged_by} by {judgment.judged_by}{/if}
              {#if judgment.notes} - "{judgment.notes}"{/if}
            </p>
          {/if}
        </div>

        <!-- Per-model summary -->
        <div class="grid gap-3" style="grid-template-columns: repeat({cmp.per_model.length}, minmax(0, 1fr));">
          {#each cmp.per_model as m}
            <div class="rounded-lg border border-border bg-surface px-3 py-2.5">
              <div class="text-sm font-medium text-on-surface">{modelLabel(m)}</div>
              <div class="mt-1.5 grid grid-cols-2 gap-y-1 text-xs font-ui text-on-surface-secondary tabular-nums">
                <span>{m.claim_count} claims</span><span class="text-right">{m.node_count} entities</span>
                <span class="text-success">{m.unique_count} unique</span><span class="text-right text-on-surface-muted">{m.shared_count} shared</span>
                {#if m.wall_seconds != null}<span>{fmtWall(m.wall_seconds)}</span><span></span>{/if}
              </div>
            </div>
          {/each}
        </div>

        <!-- Claims side by side; unique (only this model) highlighted -->
        <div>
          <h3 class="text-sm font-medium text-on-surface mb-2">Claims <span class="text-xs font-ui text-on-surface-muted">- unique to a model highlighted; shared dimmed</span></h3>
          <div class="grid gap-3 items-start" style="grid-template-columns: repeat({cmp.per_model.length}, minmax(0, 1fr));">
            {#each cmp.per_model as m}
              {@render claimColumn(m)}
            {/each}
          </div>
        </div>

        <!-- Entity alignment -->
        <div>
          <h3 class="text-sm font-medium text-on-surface mb-2">Entities <span class="text-xs font-ui text-on-surface-muted">- {cmp.entities.filter((e) => e.models.length > 1).length} in both, {cmp.entities.filter((e) => e.models.length === 1).length} unique</span></h3>
          <div class="flex flex-wrap gap-1.5">
            {#each cmp.entities as e}
              <span
                class="text-xs font-ui px-2 py-0.5 rounded border
                  {e.models.length > 1 ? 'border-border bg-surface-alt text-on-surface-secondary' : 'border-success/40 bg-success/5 text-on-surface'}"
                title={e.models.length > 1 ? "both models" : `only ${e.models[0]}`}
              >{e.name}{#if e.models.length === 1}<span class="text-success"> *</span>{/if}</span>
            {/each}
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>

{#snippet claimColumn(m: ModelVariant)}
  <div class="space-y-1.5">
    <div class="text-xs font-ui font-medium text-on-surface-secondary sticky top-0 bg-surface py-1">{modelLabel(m)}</div>
    {#each m.claims as c}
      <div class="rounded border px-2.5 py-1.5 text-xs leading-relaxed
        {c.shared ? 'border-border/50 bg-surface-alt/30 opacity-70' : 'border-success/40 bg-success/5'}">
        <div class="flex items-center gap-1.5 mb-0.5 text-[10px] font-ui text-on-surface-muted">
          {#if c.type}<span class="px-1 py-0.5 rounded bg-primary/10 text-primary uppercase">{c.type}</span>{/if}
          {#if c.location}<span>{c.location}</span>{/if}
          {#if !c.shared}<span class="ml-auto text-success">unique</span>{/if}
        </div>
        <span class="text-on-surface">{c.text}</span>
      </div>
    {/each}
  </div>
{/snippet}
