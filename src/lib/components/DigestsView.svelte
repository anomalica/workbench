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
  import { variantLabels } from "$lib/variant-label";
  import {
    claimKey,
    coverageRuns,
    findQuote,
    indexRenderedText,
    rangeFor,
    type CoverageRun,
  } from "$lib/quote-locate";
  import AuditView from "./AuditView.svelte";

  let comparable = $state<ComparableIngest[]>([]);
  // Loading is its own state. comparable starts [] while the fetch runs, and
  // rendering that as "0 records" + the empty-state hint told the reviewer the
  // corpus had no comparisons when it had ten - a loading screen lying as fact.
  let loadingList = $state(true);
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
  let loading = $state(false);
  let error = $state<string | null>(null);

  let chosen = $state<string | null>(null);
  // A model name is not unique - a record can hold two opus variants at
  // different prompts. Labels disambiguate only where it is needed.
  let labels = $derived(
    variantLabels(
      (comparison?.per_model ?? []).map((v) => ({
        id: v.variant,
        model: v.model,
        prompt_fingerprint: v.prompt_fingerprint,
      })),
    ),
  );
  let notes = $state("");
  let saving = $state(false);
  let saveNote = $state<string | null>(null);

  let renderedBody = $derived(predigest ? marked.parse(predigest.body) : "");

  // --- linking a claim to the source it came from -----------------------------
  // Without this the source pane is decoration: you cannot check a claim against
  // its evidence by scrolling two panes by hand. Every claim carries a verbatim
  // quote and this pane holds the text it was taken from, so the quote IS the
  // link. Misses are reported, never silently ignored - a quote that is not in
  // the source is a claim whose evidence is not there (mangled or fabricated),
  // which is worth more to a reviewer than a scroll that quietly does nothing.
  let sourceEl = $state<HTMLElement | undefined>();
  let locateNote = $state<{ kind: "exact" | "prefix" | "miss"; label: string } | null>(null);

  function showSourceFor(quote: string, label: string, scroll = true) {
    if (!sourceEl) return;
    const indexed = indexRenderedText(sourceEl);
    const hit = findQuote(indexed.text, quote);
    if (!hit) {
      locateNote = { kind: "miss", label };
      clearHighlight();
      return;
    }
    const range = rangeFor(indexed, hit.start, hit.end);
    if (!range) {
      locateNote = { kind: "miss", label };
      return;
    }
    locateNote = { kind: hit.kind, label };
    paint(range);
    // A hover PREVIEWS - it must not move the reader's place. Only a click,
    // which is a deliberate "take me there", scrolls.
    if (!scroll) return;
    const rect = range.getBoundingClientRect();
    const box = sourceEl.getBoundingClientRect();
    sourceEl.scrollTop += rect.top - box.top - box.height / 3;
  }

  // The CSS Custom Highlight API paints without touching the DOM, so Svelte's
  // {@html} render is never fought over. Where it is unavailable the pane still
  // scrolls - the position is most of the value.
  function paint(range: Range) {
    const CSSns = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS;
    if (!CSSns?.highlights) return;
    const Ctor = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    if (!Ctor) return;
    CSSns.highlights.set("claim-source", new Ctor(range));
  }

  /** Shade the source by how many models drew a claim from each stretch, so the
   *  pane answers "what did they use, and what did nothing touch?" at a glance.
   *  Runs after the render, and again whenever the comparison changes. */
  let coverageSummary = $state<{ runs: number; claimed: number; total: number } | null>(null);

  /** The painted stretches, kept so a click can be resolved back to its claims. */
  let painted = $state<{ run: CoverageRun; range: Range }[]>([]);
  /** How many colours the extraction bands rotate through. Adjacent extractions
   *  differ, which is the readable property - a colour per claim is impossible
   *  (there are thousands) and a colour per model answers a question the chips
   *  above already answer. */
  const BANDS = 5;

  function paintCoverage() {
    const CSSns = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS;
    const Ctor = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    if (!sourceEl || !comparison || !CSSns?.highlights || !Ctor) return;
    for (let n = 0; n < BANDS; n++) CSSns.highlights.delete(`claim-cover-${n}`);

    const indexed = indexRenderedText(sourceEl);
    const claims = comparison.per_model.flatMap((m) =>
      (m.claims ?? []).map((c) => ({ quote: c.quote, variant: m.variant, id: c.id })),
    );
    const runs = coverageRuns(indexed.text, claims);
    const buckets: Range[][] = Array.from({ length: BANDS }, () => []);
    const kept: { run: CoverageRun; range: Range }[] = [];
    let claimed = 0;
    runs.forEach((r, i) => {
      const range = rangeFor(indexed, r.start, r.end);
      if (!range) return;
      claimed += r.end - r.start;
      buckets[i % BANDS].push(range);
      kept.push({ run: r, range });
    });
    const store = CSSns.highlights;
    buckets.forEach((ranges, n) => {
      if (ranges.length) store.set(`claim-cover-${n}`, new Ctor(...ranges));
    });
    painted = kept;
    coverageSummary = { runs: runs.length, claimed, total: indexed.text.length };
  }

  /** Clicking a shaded stretch asks "what did the models make of THIS?" - the
   *  reverse of clicking a claim to find its source, and the direction that
   *  makes the source pane a way IN rather than a reference. */
  let focusedClaims = $state<string[]>([]);
  function onSourceClick(e: MouseEvent) {
    if (!sourceEl || !painted.length) return;
    const doc = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const caret = doc.caretPositionFromPoint?.(e.clientX, e.clientY);
    const node = caret?.offsetNode ?? doc.caretRangeFromPoint?.(e.clientX, e.clientY)?.startContainer;
    const offset = caret?.offset ?? doc.caretRangeFromPoint?.(e.clientX, e.clientY)?.startOffset ?? 0;
    if (!node) return;
    const hit = painted.find((p) => {
      try {
        return p.range.isPointInRange(node, offset);
      } catch {
        return false;
      }
    });
    if (!hit) {
      focusedClaims = [];
      return;
    }
    focusedClaims = hit.run.claims;
    locateNote = null;
    paint(hit.range);
  }

  // Repaint when the rendered body or the comparison changes.
  $effect(() => {
    void renderedBody;
    void comparison;
    if (!sourceEl) return;
    const id = requestAnimationFrame(() => paintCoverage());
    return () => cancelAnimationFrame(id);
  });

  function clearHighlight() {
    const CSSns = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS;
    CSSns?.highlights?.delete("claim-source");
  }
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
    saveNote = null;
    locateNote = null;
    clearHighlight();
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
      judgment = await saveJudgment(comparison.content_hash, comparison.variants ?? comparison.models, chosen, notes);
      saveNote = `Saved: ${labels.get(chosen) ?? chosen} marked better.`;
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
    } finally {
      loadingList = false;
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
        {#if loadingList}
          Finding records digested by more than one model...
        {:else}
          {comparable.length} record{comparable.length === 1 ? "" : "s"} digested by more than one model.
          Open one to read the ingest against what each model pulled out of it.
        {/if}
      </p>
    </div>
    {#if error}<p class="px-6 py-3 text-sm text-error">{error}</p>{/if}
    <div class="flex-1 overflow-auto">
      {#if loadingList}
        <p class="text-sm text-on-surface-muted p-6">Loading...</p>
      {:else if comparable.length === 0 && !error}
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
        {#each comparison.per_model as v (v.variant)}
          <button
            onclick={() => { chosen = v.variant; }}
            class="text-xs font-medium rounded px-2 py-1 cursor-pointer transition-colors
              {chosen === v.variant
                ? 'bg-success text-on-success'
                : 'text-on-surface-secondary hover:bg-surface-alt border border-border'}"
            title={labels.get(v.variant)}
          >
            {labels.get(v.variant) ?? v.model}
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
          {#if coverageSummary && coverageSummary.total}
            <span
              class="flex items-center gap-1.5 text-[10px] text-on-surface-muted"
              title="Each shaded stretch is one extraction - source a claim was drawn from. Colours only separate neighbouring extractions; they do not mean a model. UNSHADED text is source nothing extracted from. Click any shaded stretch to see what the models made of it."
            >
              <span class="cover-key cover-key-0"></span>
              <span class="cover-key cover-key-1"></span>
              <span class="cover-key cover-key-2"></span>
              extractions - click one
              <span class="tabular-nums ml-1">· {coverageSummary.runs} spans, {Math.round((100 * coverageSummary.claimed) / coverageSummary.total)}% of source used</span>
            </span>
          {/if}
          <span class="flex-1"></span>
          {#if locateNote}
            <span
              class="text-[10px] font-medium rounded px-1.5 py-0.5 {locateNote.kind === 'miss'
                ? 'bg-error/80 text-on-error'
                : locateNote.kind === 'prefix'
                  ? 'bg-warning-container/70 text-on-warning-container'
                  : 'bg-primary/15 text-primary'}"
              title={locateNote.kind === "miss"
                ? "This quote is not in the source text. The claim's evidence cannot be checked against what the model read - the quote is mangled (a speaker label folded in, an exchange stitched together) or invented."
                : locateNote.kind === "prefix"
                  ? "Only the opening of the quote matches the source - the rest diverges from what the model read."
                  : "Found verbatim in the source"}
            >
              {locateNote.kind === "miss"
                ? `${locateNote.label}: quote NOT in source`
                : locateNote.kind === "prefix"
                  ? `${locateNote.label}: opening matches, tail differs`
                  : `${locateNote.label}: found`}
            </span>
          {/if}
          {#if predigest?.stored_matches === false}
            <span
              class="text-[10px] font-medium text-on-warning-container bg-warning-container/60 rounded px-1.5 py-0.5"
              title="The record has changed since it was digested - these models read an older input than the one shown"
            >input has changed since digest</span>
          {/if}
        </div>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          bind:this={sourceEl}
          onclick={onSourceClick}
          class="flex-1 overflow-auto px-5 py-4 source-pane"
        >
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
          <AuditView hash={selected} onquote={showSourceFor} focus={focusedClaims} />
        {/key}
      </div>
    </div>
  </div>
{/if}

<style>
  /* The located source span. Painted through the CSS Custom Highlight API, so
     the pane's rendered markdown is never mutated - Svelte re-renders {@html}
     freely and the highlight simply re-applies on the next click. ::highlight
     only accepts a few properties; background and colour are enough to make the
     span unmissable after the scroll. */
  /* EXTRACTION BANDS. Each shaded stretch is one extraction - a run of source
     that some claim was drawn from - and the colours rotate so that ADJACENT
     extractions are told apart. They deliberately do not encode which model:
     the chips above already answer that, and the question here is "where does
     one extraction end and the next begin, and what is left over?".

     Kept low-saturation. This is a backdrop the eye scans; the UNSHADED gaps
     are what should stand out, because they are source no model extracted
     from. */
  :global(::highlight(claim-cover-0)) {
    background-color: color-mix(in srgb, #0ea5e9 18%, transparent);
  }
  :global(::highlight(claim-cover-1)) {
    background-color: color-mix(in srgb, #22c55e 18%, transparent);
  }
  :global(::highlight(claim-cover-2)) {
    background-color: color-mix(in srgb, #f59e0b 20%, transparent);
  }
  :global(::highlight(claim-cover-3)) {
    background-color: color-mix(in srgb, #8b5cf6 18%, transparent);
  }
  :global(::highlight(claim-cover-4)) {
    background-color: color-mix(in srgb, #ec4899 16%, transparent);
  }

  /* Shaded source is clickable - it asks the models what they made of it. */
  .source-pane {
    cursor: default;
  }
  /* Shaded source responds to the pointer, so it reads as something you can
     interrogate rather than as decoration. */
  .source-pane :global(::highlight(claim-hover)) {
    background-color: color-mix(in srgb, var(--color-primary, #0d9488) 34%, transparent);
  }

  .cover-key {
    display: inline-block;
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 0.1rem;
    vertical-align: -1px;
  }
  .cover-key-0 {
    background: color-mix(in srgb, #0ea5e9 30%, transparent);
  }
  .cover-key-1 {
    background: color-mix(in srgb, #22c55e 30%, transparent);
  }
  .cover-key-2 {
    background: color-mix(in srgb, #f59e0b 32%, transparent);
  }

  /* The span a clicked claim was drawn from - stronger than the bands, since it
     is a direct answer to a direct question. */
  :global(::highlight(claim-source)) {
    background-color: color-mix(in srgb, var(--color-primary, #0d9488) 32%, transparent);
    color: inherit;
  }
</style>
