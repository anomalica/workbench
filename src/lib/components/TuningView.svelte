<script lang="ts">
  import {
    fetchGrading,
    fetchHighlights,
    fetchRawBody,
    saveHighlights,
    type GradingResults,
    type IngestDetail,
    type User,
  } from "$lib/api";
  import {
    addSpan,
    buildDisplay,
    cleanExcerpt,
    displayToRaw,
    loadSpans,
    overlapFraction,
    reanchorSpans,
    saveSpans,
    segmentChunks,
    trimSpan,
    type UiSpan,
  } from "$lib/highlights";
  import { speakerColour } from "$lib/transcript";

  let {
    ingest,
    user,
    onback,
  }: {
    ingest: IngestDetail;
    user: User | null;
    onback: () => void;
  } = $props();

  let body = $state("");
  let bodySha = $state("");
  let spans = $state<UiSpan[]>([]);
  let rejected = $state<UiSpan[]>([]);
  let complete = $state(false);
  let dirty = $state(false);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let saving = $state(false);
  let saveError = $state<string | null>(null);
  let lastReviewed = $state<{ by: string; at: string | null } | null>(null);
  // Set when the sidecar was made against an older body and spans had to be
  // re-anchored by text search. `lost` spans could not be re-found.
  let reanchorNotice = $state<{ moved: number; lost: UiSpan[] } | null>(null);
  let grading = $state<GradingResults | null>(null);
  let selectedSpan = $state<number>(-1);
  let showRejected = $state(false);

  let bodyEl: HTMLElement | undefined = $state();

  let segments = $derived(buildDisplay(body));

  $effect(() => {
    void load(ingest.content_hash);
  });

  async function load(hash: string) {
    loading = true;
    loadError = null;
    try {
      const [raw, hl, grades] = await Promise.all([
        fetchRawBody(hash),
        fetchHighlights(hash),
        fetchGrading(hash),
      ]);
      body = raw.body;
      bodySha = raw.body_sha256;
      grading = grades;
      const sidecar = hl.highlights;
      if (sidecar) {
        complete = sidecar.complete;
        lastReviewed = { by: sidecar.reviewed_by, at: sidecar.reviewed_at };
        if (sidecar.body_sha256 === raw.body_sha256) {
          spans = loadSpans(body, sidecar.spans ?? []);
          rejected = loadSpans(body, sidecar.rejected ?? []);
          reanchorNotice = null;
          dirty = false;
        } else {
          // Sidecar predates a body edit: offsets are unreliable, re-anchor
          // every span by its text and flag what was lost. Saving rewrites
          // the sidecar against the current body.
          const spanResult = reanchorSpans(body, sidecar.spans ?? []);
          const rejectedResult = reanchorSpans(body, sidecar.rejected ?? []);
          spans = spanResult.anchored;
          rejected = rejectedResult.anchored;
          reanchorNotice = {
            moved: spanResult.anchored.length,
            lost: [...spanResult.lost, ...rejectedResult.lost],
          };
          dirty = true;
        }
      } else {
        spans = [];
        rejected = [];
        complete = false;
        lastReviewed = null;
        reanchorNotice = null;
        dirty = false;
      }
      selectedSpan = -1;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  /** Map a DOM selection boundary to (segment index, display offset).
   *  Selectable chunks carry data-seg + data-d; speaker labels do not and
   *  are user-select:none, so boundaries only land on prose. */
  function pointToPos(node: Node, offset: number): { seg: number; d: number } | null {
    if (node.nodeType === Node.TEXT_NODE) {
      const el = node.parentElement?.closest("[data-seg]") as HTMLElement | null;
      if (!el) return null;
      return { seg: Number(el.dataset.seg), d: Number(el.dataset.d) + offset };
    }
    // Element boundary (e.g. triple-click): resolve to the next chunk.
    const el = node as HTMLElement;
    const children = Array.from(el.childNodes);
    for (let i = offset; i < children.length; i++) {
      const child = children[i] as HTMLElement;
      const marked =
        child?.dataset?.seg != null
          ? child
          : (child?.querySelector?.("[data-seg]") as HTMLElement | null);
      if (marked?.dataset?.seg != null) {
        return { seg: Number(marked.dataset.seg), d: Number(marked.dataset.d) };
      }
    }
    // Past the last chunk: end of the final text segment.
    for (let i = segments.length - 1; i >= 0; i--) {
      if (segments[i].kind === "text") {
        return { seg: i, d: segments[i].text.length };
      }
    }
    return null;
  }

  function handleMouseUp() {
    if (!user) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!bodyEl || !bodyEl.contains(range.commonAncestorContainer)) return;
    let a = pointToPos(range.startContainer, range.startOffset);
    let b = pointToPos(range.endContainer, range.endOffset);
    if (!a || !b || (a.seg === b.seg && a.d === b.d)) return;
    if (a.seg > b.seg || (a.seg === b.seg && a.d > b.d)) [a, b] = [b, a];
    const start = displayToRaw(segments[a.seg], a.d, "start");
    const end = displayToRaw(segments[b.seg], b.d, "end");
    const span = trimSpan(body, start, end);
    if (!span) return;
    spans = addSpan(body, spans, span);
    dirty = true;
    selectedSpan = spans.findIndex((s) => s.start <= span.start && s.end >= span.end);
    sel.removeAllRanges();
  }

  function removeSpan(index: number) {
    spans = spans.filter((_, i) => i !== index);
    selectedSpan = -1;
    dirty = true;
  }

  function setNote(index: number, note: string) {
    spans = spans.map((s, i) => (i === index ? { ...s, note } : s));
    dirty = true;
  }

  function scrollToSpan(index: number) {
    selectedSpan = index;
    bodyEl
      ?.querySelector(`[data-span="${index}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  async function save() {
    if (!user || saving) return;
    saving = true;
    saveError = null;
    try {
      const res = await saveHighlights(ingest.content_hash, {
        complete,
        spans: saveSpans(body, spans),
        rejected: saveSpans(body, rejected),
      });
      bodySha = res.body_sha256;
      dirty = false;
      reanchorNotice = null;
      lastReviewed = { by: user.email, at: new Date().toISOString() };
    } catch (e) {
      saveError = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  function handleBack() {
    if (dirty && !confirm("Unsaved highlight changes will be lost. Leave anyway?")) return;
    onback();
  }

  // --- grading: accept/reject loop ---

  /** An off-target item the re-aligner could not map to a source span has
   *  null offsets - it can be shown but not accepted/rejected (there is no
   *  span triple to record). */
  function locatable(item: { start: number | null; end: number | null }): boolean {
    return (
      Number.isInteger(item.start) &&
      Number.isInteger(item.end) &&
      (item.end as number) > (item.start as number)
    );
  }

  type GradingSpan = { start: number | null; end: number | null; text: string };

  /** Grading item offsets are code points; convert to a UI span. Callers
   *  must check locatable() first. */
  function toUiSpan(item: GradingSpan): UiSpan {
    return loadSpans(body, [{ start: item.start ?? 0, end: item.end ?? 0, text: item.text }])[0];
  }

  function isAdjudicated(item: GradingSpan): boolean {
    if (!locatable(item)) return false;
    const span = toUiSpan(item);
    if (overlapFraction(span, spans) >= 0.8) return true;
    return rejected.some((r) => r.start === span.start && r.end === span.end);
  }

  function accept(item: GradingSpan) {
    if (!locatable(item)) return;
    const span = toUiSpan(item);
    spans = addSpan(body, spans, { start: span.start, end: span.end, text: span.text });
    dirty = true;
  }

  function reject(item: GradingSpan) {
    if (!locatable(item)) return;
    const span = toUiSpan(item);
    rejected = [...rejected, { start: span.start, end: span.end, text: span.text }];
    dirty = true;
  }

  function unreject(index: number) {
    rejected = rejected.filter((_, i) => i !== index);
    dirty = true;
  }

  const excerpt = cleanExcerpt;

  function pct(n: number): string {
    return `${Math.round(n * 100)}%`;
  }
</script>

<div class="flex-1 flex flex-col min-h-0">
  <!-- Title bar -->
  <div class="px-4 py-3 border-b border-border bg-surface-alt flex items-center gap-3 flex-none">
    <button
      onclick={handleBack}
      class="p-2 rounded text-on-surface-muted hover:text-on-surface hover:bg-surface transition-colors cursor-pointer flex-none"
      title="Back to review mode"
    >
      <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
      </svg>
    </button>
    <div class="flex-1 min-w-0">
      <h2 class="font-ui font-semibold text-on-surface truncate">
        {ingest.frontmatter.title ?? "Untitled"}
      </h2>
      <p class="text-xs text-on-surface-muted font-ui">
        Relevance tuning - highlight every span relevant to the subject
      </p>
    </div>
    {#if dirty}
      <span class="text-xs font-ui font-medium text-warning flex-none">unsaved changes</span>
    {/if}
    <button
      onclick={save}
      disabled={!user || !dirty || saving}
      class="px-3 py-1.5 rounded text-sm font-ui font-medium transition-colors flex-none
        {user && dirty && !saving
          ? 'bg-primary text-on-primary hover:opacity-90 cursor-pointer'
          : 'bg-surface text-on-surface-muted cursor-default'}"
    >
      {saving ? "Saving..." : "Save highlights"}
    </button>
  </div>

  {#if loading}
    <p class="text-on-surface-muted text-sm p-6">Loading body...</p>
  {:else if loadError}
    <p class="text-error text-sm p-6">{loadError}</p>
  {:else}
    <div class="flex-1 flex min-h-0">
      <!-- Left: the readable view. Prose only - annotations are hidden or
           rendered as non-selectable speaker labels; offsets map back to the
           raw body underneath. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        bind:this={bodyEl}
        onmouseup={handleMouseUp}
        class="flex-1 overflow-y-auto px-8 py-6 font-serif text-[15px] leading-7 text-on-surface selection:bg-primary/30 min-w-0"
      >
        {#each segments as segment (segment.index)}
          {#if segment.kind === "label"}
            <div class="select-none mt-5 mb-1 flex items-center gap-2 font-ui text-xs font-semibold">
              <span
                class="w-2 h-2 rounded-full flex-none"
                style="background: {speakerColour(segment.label ?? '')}"
              ></span>
              <span class="text-on-surface-secondary">{segment.label}</span>
            </div>
          {:else}
            <div class="whitespace-pre-wrap">
              {#each segmentChunks(segment, spans) as chunk}
                {#if chunk.spanIndex >= 0}
                  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                  <span
                    data-seg={segment.index}
                    data-d={chunk.d}
                    data-span={chunk.spanIndex}
                    onclick={() => (selectedSpan = chunk.spanIndex)}
                    class="bg-primary/20 cursor-pointer
                      {selectedSpan === chunk.spanIndex ? 'bg-primary/35 outline outline-1 outline-primary/60' : ''}"
                  >{chunk.text}</span>
                {:else}
                  <span data-seg={segment.index} data-d={chunk.d}>{chunk.text}</span>
                {/if}
              {/each}
            </div>
          {/if}
        {/each}
      </div>

      <!-- Right: controls + results -->
      <div class="w-96 flex-none border-l border-border overflow-y-auto bg-surface-alt">
        <div class="p-4 flex flex-col gap-4">
          {#if !user}
            <p class="text-xs font-ui text-on-surface-muted">
              View only - <a href="/api/auth/login" class="underline hover:text-on-surface">log in</a> to annotate.
            </p>
          {/if}

          {#if reanchorNotice}
            <div class="text-xs font-ui rounded border border-warning/40 bg-warning-container/30 text-on-warning-container p-3 flex flex-col gap-1">
              <span class="font-semibold">The record body changed since these highlights were saved.</span>
              <span>{reanchorNotice.moved} spans were re-anchored by text search{reanchorNotice.lost.length
                ? `; ${reanchorNotice.lost.length} could not be re-found and were dropped:`
                : "."} Save to confirm the new offsets.</span>
              {#each reanchorNotice.lost as lostSpan}
                <span class="italic">"{excerpt(lostSpan.text, 60)}"</span>
              {/each}
            </div>
          {/if}

          {#if saveError}
            <div class="text-xs font-ui rounded border border-error/40 bg-error/10 text-error p-3">
              Save failed: {saveError}
            </div>
          {/if}

          <!-- Reviewed in full: what makes precision measurable -->
          <label class="flex items-start gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              bind:checked={complete}
              onchange={() => (dirty = true)}
              disabled={!user}
              class="mt-0.5 accent-[var(--color-primary)] w-4 h-4"
            />
            <span class="text-sm font-ui text-on-surface">
              Reviewed in full
              <span class="block text-xs text-on-surface-muted mt-0.5">
                Every relevant span in the whole document is highlighted. Only
                then can extractions outside the highlights be graded as
                over-extraction.
              </span>
            </span>
          </label>

          {#if lastReviewed}
            <p class="text-xs font-ui text-on-surface-muted">
              {#if lastReviewed.at}
                Last saved {lastReviewed.at.slice(0, 16).replace("T", " ")} by {lastReviewed.by}
              {:else}
                Unconfirmed draft by {lastReviewed.by} - correct it and save.
              {/if}
            </p>
          {/if}

          <!-- Highlight list -->
          <div class="flex flex-col gap-1.5">
            <h3 class="text-xs font-ui font-semibold text-on-surface-muted uppercase tracking-wide">
              Highlights ({spans.length})
            </h3>
            {#if spans.length === 0}
              <p class="text-xs font-ui text-on-surface-muted">
                Select text in the document to add a highlight.
              </p>
            {/if}
            {#each spans as span, i}
              <div
                class="rounded border p-2 flex flex-col gap-1.5 bg-surface
                  {selectedSpan === i ? 'border-primary' : 'border-border'}"
              >
                <div class="flex items-start gap-2">
                  <button
                    onclick={() => scrollToSpan(i)}
                    class="flex-1 text-left text-xs text-on-surface cursor-pointer hover:text-primary min-w-0"
                    title="Scroll to this span"
                  >{excerpt(span.text)}</button>
                  {#if user}
                    <button
                      onclick={() => removeSpan(i)}
                      class="flex-none p-0.5 rounded text-on-surface-muted hover:text-error hover:bg-surface-alt cursor-pointer"
                      title="Remove highlight"
                      aria-label="Remove highlight"
                    >
                      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  {/if}
                </div>
                {#if selectedSpan === i && user}
                  <input
                    type="text"
                    placeholder="Note (optional)"
                    value={span.note ?? ""}
                    oninput={(e) => setNote(i, (e.target as HTMLInputElement).value)}
                    class="text-xs bg-surface-alt border border-border rounded px-2 py-1
                      text-on-surface outline-none focus:border-primary placeholder:text-on-surface-muted/50"
                  />
                {:else if span.note}
                  <p class="text-xs text-on-surface-muted italic">{span.note}</p>
                {/if}
              </div>
            {/each}
          </div>

          <!-- Dismissed unmarked extractions (recorded so they stay dismissed) -->
          {#if rejected.length > 0}
            <div class="flex flex-col gap-1.5">
              <button
                onclick={() => (showRejected = !showRejected)}
                class="text-xs font-ui font-semibold text-on-surface-muted uppercase tracking-wide text-left cursor-pointer hover:text-on-surface"
              >
                Dismissed ({rejected.length}) {showRejected ? "▴" : "▾"}
              </button>
              {#if showRejected}
                {#each rejected as r, i}
                  <div class="rounded border border-border bg-surface p-2 flex items-start gap-2">
                    <span class="flex-1 text-xs text-on-surface-muted line-through min-w-0">{excerpt(r.text)}</span>
                    {#if user}
                      <button
                        onclick={() => unreject(i)}
                        class="flex-none text-xs font-ui text-on-surface-muted hover:text-on-surface underline cursor-pointer"
                        title="Remove from rejected list"
                      >undo</button>
                    {/if}
                  </div>
                {/each}
              {/if}
            </div>
          {/if}

          <!-- Grading results -->
          <div class="flex flex-col gap-2">
            <h3 class="text-xs font-ui font-semibold text-on-surface-muted uppercase tracking-wide">
              Model grading
            </h3>
            {#if !grading}
              <p class="text-xs font-ui text-on-surface-muted">
                No grading results for this body yet. The digester writes them
                after a model run.
              </p>
            {:else}
              {#each grading.models as m}
                {@const pending = m.unmarked.filter((item) => !isAdjudicated(item))}
                <div class="rounded border border-border bg-surface p-2.5 flex flex-col gap-2">
                  <div class="flex items-baseline gap-2">
                    <span class="text-xs font-ui font-medium text-on-surface flex-1 truncate">{m.model}</span>
                    <span
                      class="text-xs font-mono text-on-surface-muted tabular-nums"
                      title="Fraction of your highlighted spans that survived into this model's output. Partial highlights cannot grade precision - unmarked extractions are informational, not wrong."
                    >
                      coverage {pct(m.coverage)}
                    </span>
                  </div>
                  {#if m.missed.length > 0}
                    <details class="text-xs">
                      <summary class="font-ui text-on-surface-muted cursor-pointer">
                        Missed highlights ({m.missed.length})
                      </summary>
                      <ul class="mt-1 flex flex-col gap-1">
                        {#each m.missed as miss}
                          <li class="text-on-surface-muted italic">"{excerpt(miss.text)}"</li>
                        {/each}
                      </ul>
                    </details>
                  {/if}
                  {#if pending.length > 0}
                    <div class="flex flex-col gap-1.5">
                      <span class="text-xs font-ui text-on-surface-muted">
                        Unmarked extractions ({pending.length}) - informational, not errors.
                        Accept the ones you'd have highlighted:
                      </span>
                      {#each pending as item}
                        <div class="rounded bg-surface-alt border border-border p-2 flex flex-col gap-1.5">
                          {#if item.summary}
                            <span class="text-xs font-ui text-on-surface">{item.summary}</span>
                          {/if}
                          <span class="text-xs text-on-surface-muted italic">"{excerpt(item.text)}"</span>
                          {#if !locatable(item)}
                            <span class="text-xs font-ui text-on-surface-muted">
                              Could not be located in the source - no span to adjudicate.
                            </span>
                          {:else if user}
                            <div class="flex gap-1.5">
                              <button
                                onclick={() => accept(item)}
                                class="px-2 py-0.5 rounded text-xs font-ui font-medium bg-success/15 text-success hover:bg-success/25 cursor-pointer"
                                title="A genuine miss - add to highlights"
                              >Accept</button>
                              <button
                                onclick={() => reject(item)}
                                class="px-2 py-0.5 rounded text-xs font-ui text-on-surface-muted hover:text-on-surface hover:bg-surface cursor-pointer"
                                title="Not something you'd highlight - dismiss from this list (recorded so it stays dismissed)"
                              >Dismiss</button>
                              {#if item.kind}
                                <span class="ml-auto text-[10px] font-ui text-on-surface-muted self-center uppercase">{item.kind}</span>
                              {/if}
                            </div>
                          {/if}
                        </div>
                      {/each}
                    </div>
                  {:else if m.unmarked.length > 0}
                    <span class="text-xs font-ui text-on-surface-muted">
                      All {m.unmarked.length} unmarked extractions adjudicated.
                    </span>
                  {/if}
                </div>
              {/each}
            {/if}
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>
