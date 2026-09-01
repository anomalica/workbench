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
  import { marked, withMath } from "$lib/markdown";
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
  import { parseSourceBlocks } from "$lib/source-blocks";
  import { variantLabels } from "$lib/variant-label";
  import {
    claimKey,
    claimExtents,
    coverageRuns,
    findQuote,
    normaliseForMatch,
    sourceSegments,
    unionExtent,
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

  let renderedBody = $derived(
    predigest ? withMath(predigest.body, (text) => marked.parse(text) as string) : "",
  );

  // --- linking a claim to the source it came from -----------------------------
  // The source pane is rendered as SEGMENTS - one span per stretch of text,
  // carrying the claims drawn from it - rather than as prose with painted
  // ranges over the top. A painted range is not an element, so resolving a
  // click meant mapping a screen point back through the caret API to a Range
  // captured earlier, and those go stale on any re-render: the geometry
  // described the old layout while the browser reported the new one, so clicks
  // landed inside nothing. Spans make hover and click ordinary DOM events on
  // exactly the text they belong to.
  let sourceEl = $state<HTMLElement | undefined>();
  let locateNote = $state<{ kind: "exact" | "prefix" | "miss"; label: string } | null>(null);
  let hoverCount = $state(0);
  let focusedClaims = $state<string[]>([]);
  // The SELECTED SPAN, not a segment index. Runs split wherever the set of
  // covering claims changes, so one claim's evidence is spread over several
  // segments - two claims quoting overlapping spans leave slivers where only
  // one covers, which is how selecting a passage lit up the single word "But".
  // Selecting resolves to the union of the FULL extents of the claims involved,
  // and every segment inside that span shows as selected.
  let activeSpan = $state<{ start: number; end: number } | null>(null);
  let hoverSpan = $state<{ start: number; end: number } | null>(null);
  const BANDS = 5;

  // The body as STRUCTURE: speaker changes, page turns and notes as their own
  // elements, prose as one continuous string. Coverage is measured over the
  // prose alone, so an annotation never shifts a claim's offsets.
  let parsedSource = $derived(parseSourceBlocks(predigest?.body ?? ""));
  let normalisedSource = $derived(parsedSource.prose);
  let sourceClaims = $derived(
    (comparison?.per_model ?? []).flatMap((m) =>
      (m.claims ?? []).map((c) => ({ quote: c.quote, variant: m.variant, id: c.id })),
    ),
  );
  let sourceExtents = $derived(
    normalisedSource ? claimExtents(normalisedSource, sourceClaims) : new Map(),
  );
  let sourceRuns = $derived.by(() => {
    if (!normalisedSource || !comparison) return [];
    const claims = comparison.per_model.flatMap((m) =>
      (m.claims ?? []).map((c) => ({ quote: c.quote, variant: m.variant, id: c.id })),
    );
    return coverageRuns(normalisedSource, claims);
  });
  let segments = $derived(
    normalisedSource ? sourceSegments(normalisedSource, sourceRuns) : [],
  );
  // Derived, never assigned from inside another derived - Svelte forbids that,
  // and it threw on every render of this pane.
  let coverageSummary = $derived(
    normalisedSource
      ? {
          runs: sourceRuns.length,
          claimed: sourceRuns.reduce((n, r) => n + (r.end - r.start), 0),
          total: normalisedSource.length,
        }
      : null,
  );

  function onSegmentClick(seg: { claims: string[]; start: number; end: number }) {
    if (!seg.claims.length) {
      focusedClaims = [];
      activeSpan = null;
      return;
    }
    activeSpan = unionExtent(sourceExtents, seg.claims) ?? { start: seg.start, end: seg.end };
    focusedClaims = seg.claims;
    locateNote = null;
  }

  /** The segments falling inside one prose block, clipped to it - so a block
   *  renders its own share of an extraction that runs across several. */
  function segmentsOf(block: { start: number; end: number }) {
    return segments
      .filter((sg) => sg.start < block.end && block.start < sg.end)
      .map((sg) => ({
        ...sg,
        text: normalisedSource.slice(Math.max(sg.start, block.start), Math.min(sg.end, block.end)),
      }));
  }

  /** A CHUNK's whole span, drawn on the source so "chunk" means something the
   *  reader can see rather than a heading they must take on trust. Hovering the
   *  chunk header outlines its text; clicking scrolls to it. */
  let chunkSpan = $state<{ start: number; end: number } | null>(null);
  function showChunk(claimKeys: string[], scroll: boolean) {
    if (!claimKeys.length) {
      chunkSpan = null;
      return;
    }
    chunkSpan = unionExtent(sourceExtents, claimKeys);
    if (!scroll || !chunkSpan) return;
    requestAnimationFrame(() => {
      sourceEl?.querySelector(".in-chunk")?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  function inSpan(seg: { start: number; end: number }, span: { start: number; end: number } | null) {
    return !!span && seg.start < span.end && span.start < seg.end;
  }

  /** Show where a claim came from - the other direction of the link.
   *  A HOVER previews (marks the source, leaves the selection and the scroll
   *  position alone); a CLICK selects and scrolls. Hover writing to the
   *  selection would destroy the reader's place every time the pointer crossed
   *  a claim on its way somewhere else. */
  function showSourceFor(quote: string, label: string, scroll = true) {
    const hit = findQuote(normalisedSource, quote);
    if (!hit) {
      if (scroll) {
        locateNote = { kind: "miss", label };
        activeSpan = null;
      }
      hoverSpan = null;
      return;
    }
    if (!scroll) {
      hoverSpan = { start: hit.start, end: hit.end };
      return;
    }
    locateNote = { kind: hit.kind, label };
    activeSpan = { start: hit.start, end: hit.end };
    requestAnimationFrame(() => {
      sourceEl?.querySelector(".is-active")?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
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
    activeSpan = null;
    focusedClaims = [];
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
    <div class="flex-none px-6 py-6 border-b border-border">
      <h2 class="font-ui text-lg text-on-surface">Digests</h2>
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
    <header class="flex-none px-4 py-3 border-b border-border bg-surface-alt flex flex-wrap items-center gap-x-3 gap-y-2">
      <button
        onclick={backToList}
        class="p-2 rounded text-on-surface-muted hover:text-on-surface hover:bg-surface transition-colors cursor-pointer flex-none"
        title="Back to the digest list"
        aria-label="Back to the digest list"
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <span class="font-ui font-semibold text-on-surface truncate max-w-md">{title}</span>
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
          placeholder="Why this one? Saved with the choice"
          title="Stored with the judgment and shown here again next time this record is opened."
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
          {#if hoverCount}
            <span class="text-[10px] text-primary font-medium">
              {hoverCount} claim{hoverCount === 1 ? "" : "s"} here - click to show
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
        <div bind:this={sourceEl} class="flex-1 overflow-auto px-5 py-4 source-pane">
          {#if loading}
            <p class="text-sm text-on-surface-muted">Loading…</p>
          {:else if !predigest}
            <p class="text-sm text-on-surface-muted italic">No pre-digest available for this record.</p>
          {:else}
            <!-- Each block rendered as WHAT IT IS: a speaker change is a
                 speaker change, a page turn is a divider, and prose carries the
                 clickable extraction spans. -->
            <div class="max-w-prose text-sm text-on-surface leading-relaxed">
              {#each parsedSource.blocks as block, bi (bi)}
                {#if block.kind === "speaker"}
                  <p class="speaker-label">{block.label}</p>
                {:else if block.kind === "page" || block.kind === "chapter"}
                  <p class="structure-divider"><span>{block.label}</span></p>
                {:else if block.kind === "note"}
                  <p class="source-note">{block.label}</p>
                {:else}
                  <p class="mb-2">
                    {#each segmentsOf(block) as seg, i (i)}
                      {#if seg.count === 0}<span>{seg.text}</span>{:else}<span
                          class="extract band-{i % BANDS} {inSpan(seg, activeSpan)
                            ? 'is-active'
                            : ''} {inSpan(seg, hoverSpan) ? 'is-hovered' : ''} {inSpan(
                            seg,
                            chunkSpan,
                          )
                            ? 'in-chunk'
                            : ''}"
                          role="button"
                          tabindex="0"
                          title="{seg.count} model{seg.count === 1 ? '' : 's'} drew {seg.claims
                            .length} claim{seg.claims.length === 1
                            ? ''
                            : 's'} from this - click to show"
                          onmouseenter={() => {
                            hoverSpan = unionExtent(sourceExtents, seg.claims) ?? {
                              start: seg.start,
                              end: seg.end,
                            };
                            hoverCount = seg.claims.length;
                          }}
                          onmouseleave={() => {
                            hoverSpan = null;
                            hoverCount = 0;
                          }}
                          onclick={() => onSegmentClick(seg)}
                          onkeydown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onSegmentClick(seg);
                            }
                          }}>{seg.text}</span
                        >{/if}
                    {/each}
                  </p>
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      </div>

      <!-- WHAT THE MODELS MADE OF IT. -->
      <div class="flex-1 flex flex-col min-h-0 border-l border-border">
        {#key selected}
          <AuditView
            hash={selected}
            onquote={showSourceFor}
            onchunk={showChunk}
            focus={focusedClaims}
          />
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
  /* EXTRACTION BANDS. Each shaded span is one extraction - source a claim was
     drawn from - and the colours rotate so NEIGHBOURING extractions are told
     apart. They deliberately do not encode which model: the chips above answer
     that, and the question here is "where does one extraction end and the next
     begin, and what is left over?". The UNSHADED gaps are the finding. */
  /* Who is talking. A transcript without its speaker changes is a
     misattribution waiting to happen. */
  .speaker-label {
    margin: 0.9rem 0 0.15rem;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--color-primary, #0d9488);
  }
  .structure-divider {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin: 1.1rem 0 0.6rem;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-on-surface-muted, #6b7280);
  }
  .structure-divider::before,
  .structure-divider::after {
    content: "";
    flex: 1;
    border-top: 1px solid var(--color-border, rgba(128, 128, 128, 0.3));
  }
  .source-note {
    margin: 0.5rem 0;
    padding: 0.2rem 0.45rem;
    border-left: 2px solid var(--color-border, rgba(128, 128, 128, 0.4));
    font-size: 11px;
    font-style: italic;
    color: var(--color-on-surface-secondary, inherit);
  }

  .extract {
    border-radius: 0.15rem;
    cursor: pointer;
    transition: filter 0.1s;
  }
  .extract:hover {
    filter: brightness(1.45) saturate(1.3);
    outline: 1px solid color-mix(in srgb, currentColor 35%, transparent);
  }
  /* The whole evidence reads as ONE selection: a shared background across every
     segment of it, with the outline only on the edges, so a claim spread over
     several runs does not look like several separate selections. */
  .extract.is-hovered {
    filter: brightness(1.4) saturate(1.25);
  }
  /* The chunk the reader is pointing at, bracketed on the text. */
  .extract.in-chunk {
    box-shadow:
      0 -2px 0 var(--color-primary, #0d9488) inset,
      0 2px 0 var(--color-primary, #0d9488) inset;
  }

  .extract.is-active {
    background-color: color-mix(in srgb, var(--color-primary, #0d9488) 38%, transparent);
    box-shadow: 0 -1px 0 var(--color-primary, #0d9488) inset,
      0 1px 0 var(--color-primary, #0d9488) inset;
  }
  .band-0 {
    background-color: color-mix(in srgb, #0ea5e9 20%, transparent);
  }
  .band-1 {
    background-color: color-mix(in srgb, #22c55e 20%, transparent);
  }
  .band-2 {
    background-color: color-mix(in srgb, #f59e0b 22%, transparent);
  }
  .band-3 {
    background-color: color-mix(in srgb, #8b5cf6 20%, transparent);
  }
  .band-4 {
    background-color: color-mix(in srgb, #ec4899 18%, transparent);
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

</style>
