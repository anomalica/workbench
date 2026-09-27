<script lang="ts">
  import {
    decideHousekeeping,
    fetchHousekeeping,
    fetchHousekeepingQueue,
    waiveHousekeepingResearch,
    type HousekeepingCategory,
    type HousekeepingItem,
    type HousekeepingPass,
    type HousekeepingRow,
    type HousekeepingView,
  } from "$lib/api";

  let {
    canDecide = false,
    initialHash = null,
    initialView = null,
    onviewchange,
  }: {
    canDecide?: boolean;
    initialHash?: string | null;
    initialView?: HousekeepingView | null;
    onviewchange?: (hash: string, view: HousekeepingView) => void;
  } = $props();

  const CATEGORY_ORDER: HousekeepingCategory[] = ["person-name", "known-term", "metadata"];
  const CATEGORY_LABELS: Record<HousekeepingCategory, string> = {
    "person-name": "Person names",
    "known-term": "Known terms",
    metadata: "Metadata",
  };

  let queue = $state<HousekeepingRow[]>([]);
  let loadingQueue = $state(true);
  let selected = $state<string | null>(null);
  let view = $state<HousekeepingView | null>(null);
  let loadingSidecar = $state(false);
  let error = $state<string | null>(null);
  let saving = $state(false);
  let rejected = $state<Record<string, boolean>>({});
  let waiverReason = $state("");
  let selectionGeneration = 0;

  const open = $derived(
    queue.filter(
      (row) =>
        row.proposed > 0 ||
        (row.review_state !== undefined &&
          row.review_state !== "ready" &&
          row.review_state !== "excluded-review-state"),
    ),
  );
  const proposals = $derived.by(() => {
    if (view?.access !== "full" || view.review_state !== "needs-decisions") return [];
    const items = (view.sidecar?.items ?? []).filter((item) => item.status === "proposed");
    return items
      .map((item, index) => ({ item, index }))
      .sort(
        (a, b) =>
          CATEGORY_ORDER.indexOf(a.item.category) - CATEGORY_ORDER.indexOf(b.item.category) ||
          a.index - b.index,
      )
      .map(({ item }) => item);
  });
  const rejectedIds = $derived.by(() => {
    const ids = new Set(Object.keys(rejected).filter((id) => rejected[id]));
    // A dependent edit cannot be applied after its prerequisite is rejected.
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of proposals) {
        if (!ids.has(item.id) && item.depends_on?.some((id) => ids.has(id))) {
          ids.add(item.id);
          changed = true;
        }
      }
    }
    return ids;
  });
  const canSubmit = $derived(
    canDecide &&
      view?.access === "full" &&
      view.review_state === "needs-decisions" &&
      view.viewed_sidecar_sha !== null &&
      proposals.length > 0,
  );
  const canWaive = $derived(
    canDecide &&
      view?.access === "full" &&
      (view.review_state === "pending-research" ||
        view.review_state === "failed-research") &&
      view.viewed_sidecar_sha !== null,
  );

  $effect(() => {
    fetchHousekeepingQueue()
      .then((next) => {
        queue = next;
        if (!selected && !initialHash) {
          const first = next.find(
            (row) => row.proposed > 0 || (row.review_state && row.review_state !== "ready" && row.review_state !== "excluded-review-state"),
          );
          if (first) select(first.content_hash);
        }
      })
      .catch((e) => (error = String(e)))
      .finally(() => (loadingQueue = false));
  });

  $effect(() => {
    if (!initialHash) return;
    if (
      initialView?.access === "full" &&
      initialView.viewed_content_hash === `sha256:${initialHash.replace(/^sha256:/, "")}`
    ) {
      selectionGeneration++;
      selected = initialHash;
      view = initialView;
      loadingSidecar = false;
      resetDraft();
      error = null;
      return;
    }
    select(initialHash);
  });

  function resetDraft() {
    rejected = {};
    waiverReason = "";
  }

  async function select(hash: string) {
    const generation = ++selectionGeneration;
    selected = hash;
    view = null;
    loadingSidecar = true;
    resetDraft();
    error = null;
    try {
      const response = await fetchHousekeeping(hash);
      if (generation !== selectionGeneration) return;
      view = response;
      if (response) onviewchange?.(hash, response);
    } catch (e) {
      if (generation !== selectionGeneration) return;
      error = String(e);
    } finally {
      if (generation === selectionGeneration) loadingSidecar = false;
    }
  }

  function toggleRejected(id: string) {
    if (!canDecide || saving || view?.review_state !== "needs-decisions") return;
    rejected = { ...rejected, [id]: !rejected[id] };
  }

  async function save() {
    if (!selected || view?.access !== "full" || !canSubmit) return;
    const selectedHash = selected;
    saving = true;
    error = null;
    try {
      await decideHousekeeping(
        selectedHash,
        view,
        proposals.map((item) => ({
          item_id: item.id,
          status: rejectedIds.has(item.id) ? "rejected" : "approved",
        })),
      );
      if (selected !== selectedHash) return;
      await select(selectedHash);
      queue = await fetchHousekeepingQueue();
      const next = open.find((row) => row.content_hash !== selectedHash);
      if (next && selected === selectedHash) await select(next.content_hash);
    } catch (e) {
      error = String(e);
    } finally {
      saving = false;
    }
  }

  async function waiveResearch() {
    if (!selected || view?.access !== "full" || !canWaive || !waiverReason.trim()) return;
    const selectedHash = selected;
    saving = true;
    error = null;
    try {
      await waiveHousekeepingResearch(selectedHash, view, waiverReason);
      if (selected !== selectedHash) return;
      await select(selectedHash);
      queue = await fetchHousekeepingQueue();
    } catch (e) {
      error = String(e);
    } finally {
      saving = false;
    }
  }

  function target(item: HousekeepingItem): string {
    if (item.operation === "replace-token") return `${item.old_token} → ${item.new_token}`;
    return item.operation === "move" ? `${item.field} → ${item.to_field}` : item.field;
  }

  function passLabel(pass: HousekeepingPass | undefined): string {
    if (!pass) return "Waiting";
    if (pass.status === "waived") return "Waived";
    if (pass.status === "failed") return "Failed";
    return "Complete";
  }

  function stateLabel(state: import("$lib/api").HousekeepingState): string {
    const labels: Record<import("$lib/api").HousekeepingState, string> = {
      due: "Due",
      "pending-deterministic": "Deterministic checks pending",
      "failed-deterministic": "Deterministic checks failed",
      "pending-research": "Metadata research pending",
      "failed-research": "Metadata research failed",
      "needs-decisions": "Needs decisions",
      ready: "Ready",
      "excluded-review-state": "Existing review grandfathered",
    };
    return labels[state];
  }
</script>

<div class="flex-1 overflow-y-auto">
  <div class="mx-auto max-w-6xl px-6 py-6">
    <h2 class="font-ui text-lg text-on-surface">Housekeeping</h2>
    <p class="mt-1 max-w-prose text-sm text-on-surface-muted">
      Review all proposed changes below. They are approved by default; reject anything that
      should not change, then apply the complete set in one save.
    </p>

    {#if error}
      <p class="mt-4 rounded border border-error/40 px-3 py-2 text-sm text-error">{error}</p>
    {/if}

    <div class="mt-6 grid gap-8 lg:grid-cols-[20rem_1fr]">
      <aside>
        <h3 class="mb-2 font-ui text-xs uppercase tracking-wide text-on-surface-muted">
          {open.length} record{open.length === 1 ? "" : "s"} in progress
        </h3>
        {#if loadingQueue}
          <p class="text-sm text-on-surface-muted">Loading records...</p>
        {:else if !queue.length}
          <p class="text-sm text-on-surface-muted">No housekeeping records are waiting.</p>
        {/if}
        <ul class="flex flex-col gap-0.5">
          {#each open as row (row.content_hash)}
            <li>
              <button
                onclick={() => select(row.content_hash)}
                class="flex w-full items-center justify-between gap-3 rounded px-2.5 py-2 text-left text-sm transition-colors
                  {selected === row.content_hash
                  ? 'bg-primary-container text-on-surface'
                  : 'text-on-surface-secondary hover:bg-surface-alt'}"
              >
                <span class="truncate">{row.title ?? row.content_hash.slice(0, 12)}</span>
                <span class="flex-none rounded-full bg-warning-container px-1.5 text-xs tabular-nums text-on-warning-container">
                  {row.proposed ||
                    (row.review_state ? stateLabel(row.review_state) : "Due")}
                </span>
              </button>
            </li>
          {/each}
        </ul>
      </aside>

      <section>
        {#if !selected}
          <p class="text-sm text-on-surface-muted">{loadingQueue ? "Loading records..." : "Choose a record."}</p>
        {:else if loadingSidecar}
          <p class="text-sm text-on-surface-muted">Loading...</p>
        {:else if !view}
          <p class="rounded border border-border bg-warning-container px-3 py-2 text-sm text-on-warning-container">
            Housekeeping state is unavailable. Content review remains blocked until it can be checked.
          </p>
        {:else}
          <div class="mb-5 flex flex-wrap items-center gap-2 text-xs font-ui">
            <span class="rounded bg-surface-alt px-2 py-1 text-on-surface-secondary">
              {stateLabel(view.review_state)}
            </span>
            {#if view.outstanding_count > 0}
              <span class="text-on-surface-muted">{view.outstanding_count} outstanding</span>
            {/if}
          </div>

          {#if view.review_state === "due"}
            <p class="mb-4 rounded border border-border bg-warning-container px-3 py-2 text-sm text-on-warning-container">
              A current version 3 pass is required ({view.due_reason ?? "not yet available"}).
              Older or stale proposals cannot be decided.
            </p>
          {:else if view.review_state === "excluded-review-state"}
            <p class="mb-4 rounded border border-border bg-surface-alt px-3 py-2 text-sm text-on-surface-secondary">
              Content review already started for this record. That review is grandfathered and automatic housekeeping is excluded.
            </p>
          {:else if view.review_state === "pending-deterministic"}
            <p class="mb-4 rounded border border-border bg-surface-alt px-3 py-2 text-sm text-on-surface-secondary">
              Deterministic checks have not completed yet. Content review will remain read-only while they run.
            </p>
          {:else if view.review_state === "failed-deterministic"}
            <p class="mb-4 rounded border border-error/40 bg-error/10 px-3 py-2 text-sm text-error">
              Deterministic checks failed. The pass must be retried successfully before research or review can continue.
            </p>
          {:else if view.review_state === "pending-research"}
            <p class="mb-4 rounded border border-border bg-surface-alt px-3 py-2 text-sm text-on-surface-secondary">
              Deterministic checks are complete. Metadata research is still pending.
            </p>
          {:else if view.review_state === "failed-research"}
            <p class="mb-4 rounded border border-error/40 bg-error/10 px-3 py-2 text-sm text-error">
              Metadata research failed. Retry the research pass or record an authenticated waiver with a reason.
            </p>
          {/if}

          {#if view.access === "summary"}
            <p class="mb-4 rounded border border-border bg-warning-container px-3 py-2 text-sm text-on-warning-container">
              Copyright-gated record: proposal details and identities are withheld until you prove possession of the source.
            </p>
          {:else}
            {@const deterministic = view.sidecar?.passes?.deterministic}
            {@const research = view.sidecar?.passes?.["metadata-research"]}
            <div class="mb-5 grid gap-3 sm:grid-cols-2" aria-label="Housekeeping pass progress">
              <div class="rounded border border-border bg-surface-alt px-3 py-2">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-sm font-medium text-on-surface">Deterministic</span>
                  <span class="text-xs text-on-surface-muted">{passLabel(deterministic)}</span>
                </div>
                {#if deterministic?.status === "failed"}
                  <p class="mt-1 text-xs text-error">{deterministic.error}</p>
                {/if}
              </div>
              <div class="rounded border border-border bg-surface-alt px-3 py-2">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-sm font-medium text-on-surface">Metadata research</span>
                  <span class="text-xs text-on-surface-muted">{passLabel(research)}</span>
                </div>
                {#if research?.status === "failed"}
                  <p class="mt-1 text-xs text-error">{research.error}</p>
                {/if}
                {#if research?.status === "waived"}
                  <p class="mt-1 text-xs text-on-surface-secondary">
                    Waived by {research.waiver.by} at {research.waiver.at}: {research.waiver.reason}
                  </p>
                {/if}
              </div>
            </div>

            {#if canWaive}
              <div class="mb-5 rounded border border-warning/40 bg-warning-container/40 p-3">
                <label class="block text-sm font-medium text-on-warning-container" for="waiver-reason">
                  Continue without metadata research
                </label>
                <textarea
                  id="waiver-reason"
                  bind:value={waiverReason}
                  rows="2"
                  placeholder="Audited reason for waiving research"
                  class="mt-2 w-full resize-none rounded border border-border bg-surface px-3 py-2 text-sm text-on-surface outline-none focus:border-primary"
                ></textarea>
                <button
                  onclick={waiveResearch}
                  disabled={saving || !waiverReason.trim()}
                  class="mt-2 rounded border border-warning px-3 py-1.5 text-sm font-medium text-on-warning-container disabled:opacity-40"
                >Waive research</button>
              </div>
            {/if}

            {#if proposals.length > 0}
              <div class="mb-4 grid gap-2 sm:grid-cols-3" aria-label="Proposal category progress">
                {#each CATEGORY_ORDER as category}
                  {@const categoryItems = proposals.filter((item) => item.category === category)}
                  {#if categoryItems.length > 0}
                    <div class="rounded border border-border px-3 py-2 text-xs">
                      <div class="font-medium text-on-surface">{CATEGORY_LABELS[category]}</div>
                       <div class="mt-0.5 text-on-surface-muted">
                         {categoryItems.length - categoryItems.filter((item) => rejectedIds.has(item.id)).length} approved · {categoryItems.filter((item) => rejectedIds.has(item.id)).length} rejected
                       </div>
                    </div>
                  {/if}
                {/each}
              </div>

               {#if view.review_state === "needs-decisions" && canDecide}
                 <div class="mb-4 flex flex-wrap items-center gap-3 border-y border-border py-3">
                   <span class="text-sm text-on-surface-muted">{proposals.length - rejectedIds.size} approved · {rejectedIds.size} rejected</span>
                   <button onclick={save} disabled={!canSubmit || saving} class="ml-auto rounded bg-primary px-4 py-1.5 text-sm font-medium text-on-primary disabled:opacity-40">{saving ? "Saving..." : "Apply all decisions"}</button>
                 </div>
               {/if}

               <div class="space-y-3">
               {#each proposals as item (item.id)}
                 <article class="rounded border border-border bg-surface-alt px-4 py-4">
                   <div class="flex flex-wrap items-baseline justify-between gap-2">
                     <div>
                       <span class="text-xs uppercase tracking-wide text-on-surface-muted">
                         {CATEGORY_LABELS[item.category]}
                       </span>
                       <h3 class="mt-1 font-mono font-medium text-on-surface">{target(item)}</h3>
                     </div>
                     <span class="text-xs uppercase text-on-surface-muted">{item.confidence}</span>
                   </div>

                   {#if view.previews[item.id]}
                     <div class="my-3 overflow-x-auto rounded font-mono text-xs">
                       {#each view.previews[item.id].removed as line (line)}
                         <div class="bg-error/10 px-2 py-0.5 text-error">- {line}</div>
                       {/each}
                       {#each view.previews[item.id].added as line (line)}
                         <div class="bg-primary/10 px-2 py-0.5 text-primary">+ {line}</div>
                       {/each}
                     </div>
                   {/if}

                   <p class="text-sm text-on-surface-secondary">{item.evidence.reasoning}</p>
                   {#if item.evidence.sources.length}
                     <ul class="mt-2 text-xs">
                       {#each item.evidence.sources as source (source)}
                         <li class="truncate"><a href={source} target="_blank" rel="noopener noreferrer" class="text-primary hover:underline">{source}</a></li>
                       {/each}
                     </ul>
                   {/if}
                   {#if item.depends_on?.length}
                     <p class="mt-2 text-xs text-on-warning-container">
                       Requires approval of: {item.depends_on.join(", ")}.
                     </p>
                   {/if}

                   {#if view.review_state === "needs-decisions" && canDecide}
                     <div class="mt-4 flex items-center gap-3">
                       <span class="text-xs font-medium {rejectedIds.has(item.id) ? 'text-error' : 'text-primary'}">{rejectedIds.has(item.id) ? "Rejected" : "Approved"}</span>
                       {#if item.depends_on?.some((id) => rejectedIds.has(id))}
                         <span class="text-xs text-on-surface-muted">Prerequisite rejected</span>
                       {:else}
                         <button onclick={() => toggleRejected(item.id)} disabled={saving} class="rounded border border-border px-3 py-1.5 text-sm text-on-surface hover:bg-surface disabled:opacity-40">{rejectedIds.has(item.id) ? "Restore approval" : "Reject change"}</button>
                       {/if}
                     </div>
                   {/if}
                 </article>
               {/each}
               </div>

              {#if view.review_state === "needs-decisions" && canDecide}
                <div class="sticky bottom-0 mt-4 flex items-center gap-3 border-t border-border bg-surface py-3">
                   <span class="text-sm text-on-surface-muted">{proposals.length - rejectedIds.size} approved · {rejectedIds.size} rejected</span>
                  <button
                    onclick={save}
                    disabled={!canSubmit || saving}
                    class="ml-auto rounded bg-primary px-4 py-1.5 text-sm font-medium text-on-primary disabled:opacity-40"
                  >{saving ? "Saving..." : "Apply all decisions"}</button>
                </div>
              {/if}
            {:else if view.review_state === "ready"}
              <p class="text-sm text-on-surface-muted">All passes and decisions are complete. Content review is ready.</p>
            {:else if view.review_state !== "due" && view.review_state !== "excluded-review-state"}
              <p class="text-sm text-on-surface-muted">No proposals are ready for a decision yet.</p>
            {/if}

            {#if view.sidecar?.decisions?.length || research?.status === "waived"}
              <details class="mt-6 border-t border-border pt-4">
                <summary class="cursor-pointer text-sm font-medium text-on-surface">Decision and waiver history</summary>
                {#if research?.status === "waived"}
                  <p class="mt-3 text-xs text-on-surface-secondary">
                    Research waived by {research.waiver.by} at {research.waiver.at}: {research.waiver.reason}
                  </p>
                {/if}
                {#each view.sidecar?.decisions ?? [] as decision (decision.item_id)}
                  <p class="mt-2 text-xs text-on-surface-secondary">
                    <code>{decision.item_id}</code> {decision.status} by {decision.decided_by} at {decision.decided_at}
                  </p>
                {/each}
              </details>
            {/if}
          {/if}
        {/if}
      </section>
    </div>
  </div>
</div>
