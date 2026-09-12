<script lang="ts">
  // Housekeeping: proposed frontmatter corrections, decided per item.
  //
  // Selection is a checkbox column rather than a pair of buttons on every row.
  // A reviewer works down a list of near-identical proposals and mostly agrees
  // with them, so the common path should be "select all, save" - per-row buttons
  // made the common case the slowest one. Rejecting stays available per row
  // because a rejection is durable: it stops the check re-proposing the same
  // change forever.
  //
  // See anomalica/architecture/housekeeping.md.
  import {
    decideHousekeeping,
    fetchHousekeeping,
    fetchHousekeepingQueue,
    type HousekeepingItem,
    type HousekeepingRow,
    type HousekeepingView,
  } from "$lib/api";

  let {
    canDecide = false,
    initialHash = null,
    initialView = null,
  }: {
    canDecide?: boolean;
    initialHash?: string | null;
    initialView?: HousekeepingView | null;
  } = $props();

  let queue = $state<HousekeepingRow[]>([]);
  let selected = $state<string | null>(null);
  let view = $state<HousekeepingView | null>(null);
  let loadingSidecar = $state(false);
  let error = $state<string | null>(null);
  let saving = $state(false);
  // Staged in the browser; nothing is written until Save, so a mis-click is free.
  let staged = $state<Record<string, "approved" | "rejected">>({});
  let selectionGeneration = 0;

  const open = $derived(queue.filter((r) => r.proposed > 0));
  const proposals = $derived(
    view?.access === "full" && view.state === "current"
      ? (view.sidecar?.items ?? []).filter((i) => i.status === "proposed")
      : [],
  );
  const canAct = $derived(
    canDecide &&
      view?.access === "full" &&
      view.state === "current" &&
      view.viewed_sidecar_sha !== null,
  );
  const pending = $derived(Object.keys(staged).length);
  const allApproved = $derived(
    proposals.length > 0 && proposals.every((i) => staged[i.id] === "approved"),
  );

  $effect(() => {
    fetchHousekeepingQueue()
      .then((q) => (queue = q))
      .catch((e) => (error = String(e)));
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
      staged = {};
      error = null;
      return;
    }
    select(initialHash);
  });

  async function select(hash: string) {
    const generation = ++selectionGeneration;
    selected = hash;
    view = null;
    loadingSidecar = true;
    staged = {};
    error = null;
    try {
      const response = await fetchHousekeeping(hash);
      if (generation !== selectionGeneration) return;
      view = response;
    } catch (e) {
      if (generation !== selectionGeneration) return;
      error = String(e);
    } finally {
      if (generation === selectionGeneration) loadingSidecar = false;
    }
  }

  function setStatus(id: string, status: "approved" | "rejected" | null) {
    if (status === null) {
      const { [id]: _drop, ...rest } = staged;
      staged = rest;
    } else {
      staged = { ...staged, [id]: status };
    }
  }

  function toggleApprove(item: HousekeepingItem) {
    setStatus(item.id, staged[item.id] === "approved" ? null : "approved");
  }

  function approveAll() {
    staged = allApproved
      ? {}
      : Object.fromEntries(proposals.map((i) => [i.id, "approved" as const]));
  }

  async function save() {
    if (!selected || !pending || view?.access !== "full" || !canAct) return;
    const selectedHash = selected;
    const viewed = view;
    saving = true;
    error = null;
    try {
      await decideHousekeeping(
        selectedHash,
        viewed,
        Object.entries(staged).map(([item_id, status]) => ({ item_id, status })),
      );
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
    if (item.operation === "replace-token") {
      return `${item.old_token} → ${item.new_token}`;
    }
    return item.operation === "move" ? `${item.field} → ${item.to_field}` : item.field;
  }
</script>

<div class="flex-1 overflow-y-auto">
  <div class="mx-auto max-w-6xl px-6 py-6">
    <h2 class="font-ui text-lg text-on-surface">Housekeeping</h2>
    <p class="mt-1 max-w-prose text-sm text-on-surface-muted">
      Proposed metadata and body corrections. Nothing here has been applied — approve
      the ones you want and save.
    </p>

    {#if error}
      <p class="mt-4 rounded border border-error/40 px-3 py-2 text-sm text-error">
        {error}
      </p>
    {/if}

    <div class="mt-6 grid gap-8 lg:grid-cols-[20rem_1fr]">
      <aside>
        <h3
          class="mb-2 font-ui text-xs uppercase tracking-wide text-on-surface-muted"
        >
          {open.length} record{open.length === 1 ? "" : "s"} to review
        </h3>
        {#if !queue.length}
          <p class="text-sm text-on-surface-muted">
            No proposals yet. Run <code class="text-xs">housekeeping propose</code>.
          </p>
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
                <span class="truncate"
                  >{row.title ?? row.content_hash.slice(0, 12)}</span
                >
                <span
                  class="flex-none rounded-full bg-warning-container px-1.5 text-xs
                    tabular-nums text-on-warning-container"
                >
                  {row.proposed}
                </span>
              </button>
            </li>
          {/each}
        </ul>
      </aside>

      <section>
        {#if !selected}
          <p class="text-sm text-on-surface-muted">Choose a record.</p>
        {:else if loadingSidecar}
          <p class="text-sm text-on-surface-muted">Loading…</p>
        {:else if !view}
          <p class="rounded border border-border bg-warning-container px-3 py-2 text-sm text-on-warning-container">
            No housekeeping pass exists for this record yet. Editing can continue
            while a pass is prepared.
          </p>
        {:else}
          {#if view.state === "due"}
            <p
              class="mb-4 rounded border border-border bg-warning-container px-3 py-2
                text-sm text-on-warning-container"
            >
              This housekeeping check is absent, stale, or from the older format.
              Its proposals cannot be applied until a fresh pass is available.
            </p>
          {/if}
          {#if view.access === "summary"}
            <p
              class="mb-4 rounded border border-border bg-warning-container px-3 py-2
                text-sm text-on-warning-container"
            >
              Copyright-gated record: proposals are withheld until you prove possession
              of the source.
            </p>
          {/if}

          {#if canAct && proposals.length > 1}
            <label
              class="mb-3 flex w-fit cursor-pointer items-center gap-2 text-sm
                text-on-surface-secondary"
            >
              <input
                type="checkbox"
                class="accent-primary"
                checked={allApproved}
                onchange={approveAll}
              />
              Approve all {proposals.length}
            </label>
          {/if}

          {#each view.access === "full" ? (view.sidecar?.items ?? []) : [] as item (item.id)}
            {@const decided = item.status !== "proposed"}
            <article
              class="mb-3 rounded border border-border bg-surface-alt px-4 py-3
                {decided ? 'opacity-60' : ''}"
            >
              <div class="flex items-start gap-3">
                {#if canAct && !decided}
                  <input
                    type="checkbox"
                    class="mt-1 accent-primary"
                    checked={staged[item.id] === "approved"}
                    onchange={() => toggleApprove(item)}
                    aria-label="Approve {target(item)}"
                  />
                {/if}

                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <code class="font-medium text-on-surface">{target(item)}</code>
                    <span class="text-xs uppercase text-on-surface-muted"
                      >{item.confidence}</span
                    >
                    <span class="text-xs text-on-surface-muted">{item.check}</span>
                  </div>

                  <!-- The real frontmatter lines, so this reads as the git diff
                       it produces rather than a value beside an arrow. -->
                  <div class="my-2 overflow-x-auto rounded font-mono text-xs">
                    {#if view.access === "full" && view.previews[item.id]}
                      {#each view.previews[item.id].removed as line (line)}
                        <div class="bg-error/10 px-2 py-0.5 text-error">- {line}</div>
                      {/each}
                      {#each view.previews[item.id].added as line (line)}
                        <div class="bg-primary/10 px-2 py-0.5 text-primary">
                          + {line}
                        </div>
                      {/each}
                    {/if}
                  </div>

                  {#if item.operation !== "replace-token" && item.depends_on?.length}
                    <p class="mb-1 text-xs text-on-warning-container">
                      Needs the item it depends on approved too — alone this would
                      overwrite the value rather than move it.
                    </p>
                  {/if}

                  <p class="text-sm text-on-surface-secondary">
                    {item.evidence.reasoning}
                  </p>
                  {#if item.evidence.sources.length}
                    <ul class="mt-1 text-xs">
                      {#each item.evidence.sources as src (src)}
                        <li class="truncate">
                          <a
                            href={src}
                            target="_blank"
                            rel="noopener noreferrer"
                            class="text-primary hover:underline">{src}</a
                          >
                        </li>
                      {/each}
                    </ul>
                  {/if}

                  {#if decided}
                    <p class="mt-1 text-xs text-on-surface-muted">
                      Already {item.status}.
                    </p>
                  {:else if canAct}
                    <button
                      onclick={() =>
                        setStatus(
                          item.id,
                          staged[item.id] === "rejected" ? null : "rejected",
                        )}
                      class="mt-1 text-xs underline
                        {staged[item.id] === 'rejected'
                        ? 'text-error'
                        : 'text-on-surface-muted hover:text-on-surface-secondary'}"
                    >
                      {staged[item.id] === "rejected" ? "Marked rejected" : "Reject"}
                    </button>
                  {/if}
                </div>
              </div>
            </article>
          {:else}
            <p class="text-sm text-on-surface-muted">Checked, nothing to propose.</p>
          {/each}

          {#if canAct && pending}
            <div
              class="sticky bottom-0 flex items-center gap-4 border-t border-border
                bg-surface py-3"
            >
              <button
                onclick={save}
                disabled={saving}
                class="rounded bg-primary px-4 py-1.5 text-sm text-surface
                  disabled:opacity-50"
              >
                {saving ? "Saving…" : `Save ${pending} decision${pending === 1 ? "" : "s"}`}
              </button>
              <button
                onclick={() => (staged = {})}
                disabled={saving}
                class="text-sm text-on-surface-muted underline hover:text-on-surface"
              >
                Clear
              </button>
            </div>
          {/if}
        {/if}
      </section>
    </div>
  </div>
</div>
