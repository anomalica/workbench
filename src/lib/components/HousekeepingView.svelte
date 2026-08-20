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
    type HousekeepingSidecar,
  } from "$lib/api";

  let { canDecide = false }: { canDecide?: boolean } = $props();

  let queue = $state<HousekeepingRow[]>([]);
  let selected = $state<string | null>(null);
  let sidecar = $state<HousekeepingSidecar | null>(null);
  let error = $state<string | null>(null);
  let saving = $state(false);
  // Staged in the browser; nothing is written until Save, so a mis-click is free.
  let staged = $state<Record<string, "approved" | "rejected">>({});

  const open = $derived(queue.filter((r) => r.proposed > 0));
  const proposals = $derived(
    (sidecar?.items ?? []).filter((i) => i.status === "proposed"),
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

  async function select(hash: string) {
    selected = hash;
    sidecar = null;
    staged = {};
    error = null;
    try {
      sidecar = await fetchHousekeeping(hash);
    } catch (e) {
      error = String(e);
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
    if (!selected || !pending) return;
    saving = true;
    error = null;
    try {
      await decideHousekeeping(
        selected,
        Object.entries(staged).map(([item_id, status]) => ({ item_id, status })),
      );
      await select(selected);
      queue = await fetchHousekeepingQueue();
    } catch (e) {
      error = String(e);
    } finally {
      saving = false;
    }
  }

  function target(item: HousekeepingItem): string {
    return item.operation === "move" ? `${item.field} → ${item.to_field}` : item.field;
  }
</script>

<div class="flex-1 overflow-y-auto">
  <div class="mx-auto max-w-6xl px-6 py-6">
    <h2 class="font-ui text-lg text-on-surface">Housekeeping</h2>
    <p class="mt-1 max-w-prose text-sm text-on-surface-muted">
      Proposed metadata corrections. Nothing here has been applied — approve the ones
      you want and save. Body text is never changed.
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
        {:else if !sidecar}
          <p class="text-sm text-on-surface-muted">Loading…</p>
        {:else}
          {#if sidecar.gated}
            <p
              class="mb-4 rounded border border-border bg-warning-container px-3 py-2
                text-sm text-on-warning-container"
            >
              Copyright-gated record: proposals touching fields that are not public
              are withheld from this view.
            </p>
          {/if}

          {#if canDecide && proposals.length > 1}
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

          {#each sidecar.items as item (item.id)}
            {@const decided = item.status !== "proposed"}
            <article
              class="mb-3 rounded border border-border bg-surface-alt px-4 py-3
                {decided ? 'opacity-60' : ''}"
            >
              <div class="flex items-start gap-3">
                {#if canDecide && !decided}
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
                    {#if item.preview}
                      {#each item.preview.removed as line (line)}
                        <div class="bg-error/10 px-2 py-0.5 text-error">- {line}</div>
                      {/each}
                      {#each item.preview.added as line (line)}
                        <div class="bg-primary/10 px-2 py-0.5 text-primary">
                          + {line}
                        </div>
                      {/each}
                    {/if}
                  </div>

                  {#if item.depends_on?.length}
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
                  {:else if canDecide}
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

          {#if canDecide && pending}
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
