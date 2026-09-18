<script lang="ts">
  import {
    fetchGoldReview,
    saveGoldBatch,
    type GoldDecision,
    type GoldReviewView,
    type GoldUnit,
    type IngestDetail,
    type User,
  } from "$lib/api";

  let {
    ingest,
    user,
    onback,
  }: {
    ingest: IngestDetail;
    user: User | null;
    onback: () => void;
  } = $props();

  type Draft = { decision: GoldDecision["decision"]; facts: string };

  let view = $state<GoldReviewView | null>(null);
  let drafts = $state<Record<string, Draft>>({});
  let rangeStart = $state(0);
  let rangeEnd = $state(0);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    void load(ingest.content_hash);
  });

  function install(next: GoldReviewView) {
    view = next;
    rangeStart = next.range.start;
    rangeEnd = next.range.end;
    drafts = {};
  }

  async function load(hash: string, range?: { start: number; end: number }) {
    loading = true;
    error = null;
    try {
      install(await fetchGoldReview(hash, range));
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      loading = false;
    }
  }

  function setDecision(unit: GoldUnit, decision: GoldDecision["decision"], fact = "") {
    drafts = {
      ...drafts,
      [unit.highlight_id]: {
        decision,
        facts: fact || drafts[unit.highlight_id]?.facts || "",
      },
    };
  }

  function setFacts(highlightId: string, facts: string) {
    const current = drafts[highlightId] ?? { decision: "adjust" as const, facts: "" };
    drafts = { ...drafts, [highlightId]: { ...current, facts } };
  }

  function factsOf(draft: Draft): string[] {
    return draft.facts
      .split("\n")
      .map((fact) => fact.trim())
      .filter(Boolean);
  }

  function draftValid(unit: GoldUnit): boolean {
    const draft = drafts[unit.highlight_id];
    if (!draft) return false;
    const facts = factsOf(draft);
    if (draft.decision === "accept") {
      return facts.length === 1 && unit.proposals.some((proposal) => proposal.text === facts[0]);
    }
    if (draft.decision === "adjust") return facts.length >= 1;
    if (draft.decision === "split") return facts.length >= 2;
    return facts.length === 0;
  }

  let batchReady = $derived(
    Boolean(view?.batch.length) && view!.batch.every((unit) => draftValid(unit)),
  );

  async function saveBatch(complete = false, replaceStale = false) {
    if (!view || !user || saving) return;
    saving = true;
    error = null;
    try {
      const decisions: GoldDecision[] = view.batch.map((unit) => {
        const draft = drafts[unit.highlight_id];
        const facts = factsOf(draft);
        return {
          highlight_id: unit.highlight_id,
          decision: draft.decision,
          ...(facts.length ? { facts } : {}),
        };
      });
      install(
        await saveGoldBatch(ingest.content_hash, {
          body_sha256: view.body_sha256,
          range: {
            id: view.range.id,
            start: replaceStale ? rangeStart : view.range.start,
            end: replaceStale ? rangeEnd : view.range.end,
          },
          decisions,
          complete,
          replace_stale: replaceStale,
        }),
      );
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      saving = false;
    }
  }

  function partText(parts: { text: string }[]): string {
    return parts.map((part) => part.text).join(" [...] ");
  }
</script>

<div class="flex-1 min-h-0 overflow-y-auto bg-surface-alt">
  <header class="sticky top-0 z-10 border-b border-border bg-surface/95 backdrop-blur">
    <div class="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3 sm:px-6">
      <button
        onclick={onback}
        class="rounded p-2 text-on-surface-muted hover:bg-surface-alt hover:text-on-surface cursor-pointer"
        aria-label="Back to record"
      >
        <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <div class="min-w-0 flex-1">
        <h2 class="truncate font-ui font-semibold text-on-surface">
          {ingest.frontmatter.title ?? "Untitled"}
        </h2>
        <p class="text-xs font-ui text-on-surface-muted">Human-gold review from existing highlights</p>
      </div>
      {#if view}
        <span class="hidden text-xs font-mono tabular-nums text-on-surface-muted sm:inline">
          {view.progress.resolved}/{view.progress.total} resolved
        </span>
      {/if}
    </div>
  </header>

  <main class="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-5 sm:px-6">
    {#if loading}
      <p class="py-12 text-center text-sm text-on-surface-muted">Loading review batch...</p>
    {:else if !user}
      <p class="rounded border border-border bg-surface p-4 text-sm text-on-surface">
        <a class="underline" href="/api/auth/login">Log in with GitHub</a> to review gold units.
      </p>
    {:else if !view}
      <p class="rounded border border-error/40 bg-error/10 p-4 text-sm text-error">{error}</p>
    {:else}
      <section class="rounded-lg border border-border bg-surface p-4 shadow-sm">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div class="flex-1">
            <h3 class="text-sm font-ui font-semibold text-on-surface">Review range</h3>
            <p class="mt-1 text-xs text-on-surface-muted">
              Half-open Unicode offsets. Crossing highlights are excluded and listed below.
            </p>
          </div>
          <label class="text-xs font-ui text-on-surface-muted">
            Start
            <input
              type="number"
              min="0"
              max={view.body_length}
              bind:value={rangeStart}
              class="mt-1 block w-28 rounded border border-border bg-surface-alt px-2 py-1.5 font-mono text-on-surface"
            />
          </label>
          <label class="text-xs font-ui text-on-surface-muted">
            End
            <input
              type="number"
              min="1"
              max={view.body_length}
              bind:value={rangeEnd}
              class="mt-1 block w-28 rounded border border-border bg-surface-alt px-2 py-1.5 font-mono text-on-surface"
            />
          </label>
          <button
            onclick={() => load(ingest.content_hash, { start: rangeStart, end: rangeEnd })}
            disabled={saving || rangeStart < 0 || rangeStart >= rangeEnd || rangeEnd > view.body_length}
            class="rounded border border-border px-3 py-1.5 text-xs font-ui font-medium text-on-surface hover:bg-surface-alt disabled:opacity-40 cursor-pointer"
          >Open range</button>
        </div>
        <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs font-ui text-on-surface-muted">
          <span>{view.progress.total} units</span>
          <span>{view.progress.resolved} resolved</span>
          <span>{view.progress.deferred} deferred</span>
          <span>{view.progress.boundary_count} boundary cases</span>
          <span>reviewer: {view.range.reviewer.name}</span>
        </div>
      </section>

      {#if error}
        <p class="rounded border border-error/40 bg-error/10 p-3 text-sm text-error">{error}</p>
      {/if}

      {#if view.stale}
        <section class="rounded-lg border border-warning/50 bg-warning-container/20 p-4">
          <h3 class="font-ui text-sm font-semibold text-on-warning-container">The record body changed</h3>
          <p class="mt-1 text-xs text-on-surface-muted">
            Saved offsets and inline markers are not re-anchored. Reopen this range against the current body to replace the stale sidecar.
          </p>
          <button
            onclick={() => saveBatch(false, true)}
            disabled={saving || rangeStart < 0 || rangeStart >= rangeEnd || rangeEnd > view.body_length}
            class="mt-3 rounded bg-primary px-3 py-1.5 text-xs font-ui font-medium text-on-primary disabled:opacity-50 cursor-pointer"
          >Reopen against current body</button>
        </section>
      {:else if view.range.complete}
        <section class="rounded-lg border border-success/40 bg-success/10 p-5 text-center">
          <h3 class="font-ui font-semibold text-success">Range attested complete</h3>
          <p class="mt-1 text-xs text-on-surface-muted">Attested {view.range.attested_at}</p>
        </section>
      {:else if view.batch.length}
        <div class="flex flex-col gap-3">
          {#each view.batch as unit, index (unit.highlight_id)}
            {@const draft = drafts[unit.highlight_id]}
            <article class="rounded-lg border border-border bg-surface p-4 shadow-sm">
              <div class="mb-3 flex items-center justify-between gap-3">
                <span class="font-ui text-[11px] font-semibold uppercase tracking-widest text-primary">
                  Unit {index + 1} · {unit.highlight_id}
                </span>
                {#if unit.parts.length > 1}
                  <span class="text-[11px] font-ui text-on-surface-muted">{unit.parts.length} parts</span>
                {/if}
              </div>

              <blockquote class="border-l-2 border-primary/50 pl-3 font-serif text-[15px] leading-6 text-on-surface">
                {#each unit.parts as part, partIndex}
                  {#if partIndex}<span class="mx-1 text-on-surface-muted">[...]</span>{/if}
                  <mark class="bg-primary/15 text-inherit">{part.text}</mark>
                {/each}
              </blockquote>

              {#if unit.context.length}
                <div class="mt-3 rounded border border-border bg-surface-alt p-3">
                  <p class="mb-1 text-[11px] font-ui font-semibold uppercase tracking-wide text-on-surface-muted">
                    Ancestor context
                  </p>
                  {#each unit.context as context}
                    <p class="text-sm leading-5 text-on-surface-secondary">
                      <span class="mr-2 font-mono text-[10px] text-on-surface-muted">{context.highlight_id}</span>
                      {partText(context.parts)}
                    </p>
                  {/each}
                </div>
              {/if}

              {#if unit.context_issue}
                <p class="mt-3 rounded bg-warning-container/30 p-2 text-xs text-on-warning-container">
                  {unit.context_issue}. This unit must be deferred until the inline context is fixed.
                </p>
              {:else if unit.proposals.length}
                <div class="mt-3 flex flex-col gap-2">
                  <p class="text-[11px] font-ui font-semibold uppercase tracking-wide text-on-surface-muted">
                    Optional overlapping facts
                  </p>
                  {#each unit.proposals as proposal}
                    <button
                      onclick={() => setDecision(unit, "accept", proposal.text)}
                      class="rounded border px-3 py-2 text-left text-sm transition-colors cursor-pointer
                        {draft?.decision === 'accept' && draft.facts === proposal.text
                          ? 'border-success bg-success/10 text-on-surface'
                          : 'border-border bg-surface-alt text-on-surface hover:border-primary/50'}"
                    >
                      <span>{proposal.text}</span>
                      <span class="mt-1 block text-[11px] text-on-surface-muted">Evidence: “{proposal.quote}”</span>
                    </button>
                  {/each}
                </div>
              {:else}
                <p class="mt-3 text-xs text-on-surface-muted">No overlapping digest claim is proposed. Write the fact directly or reject the unit.</p>
              {/if}

              <div class="mt-4 flex flex-wrap gap-1.5">
                {#if !unit.context_issue}
                  <button
                    onclick={() => setDecision(unit, "adjust", unit.proposals[0]?.text ?? "")}
                    class="rounded px-2.5 py-1 text-xs font-ui {draft?.decision === 'adjust' ? 'bg-primary text-on-primary' : 'bg-surface-alt text-on-surface-secondary hover:bg-primary/10'} cursor-pointer"
                  >Adjust/write</button>
                  <button
                    onclick={() => setDecision(unit, "split", unit.proposals[0]?.text ?? "")}
                    class="rounded px-2.5 py-1 text-xs font-ui {draft?.decision === 'split' ? 'bg-primary text-on-primary' : 'bg-surface-alt text-on-surface-secondary hover:bg-primary/10'} cursor-pointer"
                  >Split</button>
                  <button
                    onclick={() => setDecision(unit, "reject")}
                    class="rounded px-2.5 py-1 text-xs font-ui {draft?.decision === 'reject' ? 'bg-error text-white' : 'bg-surface-alt text-on-surface-secondary hover:bg-error/10'} cursor-pointer"
                  >Reject</button>
                {/if}
                <button
                  onclick={() => setDecision(unit, "defer")}
                  class="rounded px-2.5 py-1 text-xs font-ui {draft?.decision === 'defer' ? 'bg-warning text-black' : 'bg-surface-alt text-on-surface-secondary hover:bg-warning/10'} cursor-pointer"
                >Defer</button>
              </div>

              {#if draft?.decision === "adjust" || draft?.decision === "split"}
                <label class="mt-3 block text-xs font-ui text-on-surface-muted">
                  {draft.decision === "split" ? "One atomic fact per line (at least two)" : "Accepted wording (one or more lines)"}
                  <textarea
                    value={draft.facts}
                    oninput={(event) => setFacts(unit.highlight_id, event.currentTarget.value)}
                    rows={draft.decision === "split" ? 3 : 2}
                    class="mt-1 block w-full resize-y rounded border border-border bg-surface-alt px-3 py-2 text-sm leading-5 text-on-surface outline-none focus:border-primary"
                  ></textarea>
                </label>
              {/if}
            </article>
          {/each}
        </div>

        <button
          onclick={() => saveBatch()}
          disabled={!batchReady || saving}
          class="self-end rounded bg-primary px-4 py-2 text-sm font-ui font-semibold text-on-primary disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
        >{saving ? "Saving batch..." : `Save batch (${view.batch.length})`}</button>
      {:else}
        <section class="rounded-lg border border-border bg-surface p-5">
          <h3 class="font-ui font-semibold text-on-surface">All contained units are resolved</h3>
          <p class="mt-1 text-sm text-on-surface-muted">
            Attest only after reading the full bounded range and adding any missing inline highlights needed for relevant facts.
          </p>
          <button
            onclick={() => saveBatch(true)}
            disabled={saving || view.progress.deferred > 0}
            class="mt-4 rounded bg-success px-4 py-2 text-sm font-ui font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
          >{saving ? "Saving attestation..." : "Attest range complete"}</button>
        </section>
      {/if}

      {#if view.boundary_cases.length}
        <details class="rounded-lg border border-warning/40 bg-surface p-4">
          <summary class="cursor-pointer text-sm font-ui font-medium text-on-surface">
            {view.boundary_cases.length} excluded boundary {view.boundary_cases.length === 1 ? "case" : "cases"}
          </summary>
          <div class="mt-3 flex flex-col gap-2">
            {#each view.boundary_cases as boundary}
              <p class="text-xs text-on-surface-muted">
                <span class="mr-2 font-mono">{boundary.highlight_id}</span>{partText(boundary.parts)}
              </p>
            {/each}
          </div>
        </details>
      {/if}
    {/if}
  </main>
</div>
