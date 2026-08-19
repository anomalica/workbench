<script lang="ts">
  // Housekeeping: proposed frontmatter corrections, decided ONE ITEM AT A TIME.
  //
  // The per-item granularity is the point, not a nicety. A record's proposals are
  // not equally certain - moving a known redistributor out of `publisher` is
  // safe, reading the work's year off a title is a judgement - so an all-or-
  // nothing patch would force a reviewer to accept the guess to get the safe fix.
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
  // Decisions staged in the browser, keyed by item id. Nothing is written until
  // the reviewer commits, so a mis-click is free.
  let staged = $state<Record<string, "approved" | "rejected">>({});

  const open = $derived(queue.filter((r) => r.proposed > 0));
  const pending = $derived(Object.keys(staged).length);

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

  function stage(item: HousekeepingItem, status: "approved" | "rejected") {
    staged = staged[item.id] === status
      ? Object.fromEntries(Object.entries(staged).filter(([k]) => k !== item.id))
      : { ...staged, [item.id]: status };
  }

  async function commit() {
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

  function show(v: unknown): string {
    if (v === null || v === undefined || v === "") return "(absent)";
    return String(v);
  }

  function target(item: HousekeepingItem): string {
    return item.operation === "move" ? `${item.field} → ${item.to_field}` : item.field;
  }
</script>

<div class="housekeeping">
  <header>
    <h2>Housekeeping</h2>
    <p class="lede">
      Proposed frontmatter corrections. Nothing here has been applied — each item is
      approved or rejected on its own, and only approved items ever reach a record.
      Body text is never touched.
    </p>
  </header>

  {#if error}
    <p class="error">{error}</p>
  {/if}

  <div class="split">
    <aside class="queue">
      <h3>{open.length} record{open.length === 1 ? "" : "s"} awaiting review</h3>
      {#if !queue.length}
        <p class="empty">
          No proposals yet. Run <code>housekeeping propose</code> in the scheduler.
        </p>
      {/if}
      <ul>
        {#each open as row (row.content_hash)}
          <li>
            <button
              class:active={selected === row.content_hash}
              onclick={() => select(row.content_hash)}
            >
              <span class="title">{row.title ?? row.content_hash.slice(0, 12)}</span>
              <span class="counts">
                <span class="badge proposed">{row.proposed}</span>
                {#if row.approved}<span class="badge approved">{row.approved}</span>{/if}
                {#if row.rejected}<span class="badge rejected">{row.rejected}</span>{/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    </aside>

    <section class="detail">
      {#if !selected}
        <p class="empty">Choose a record.</p>
      {:else if !sidecar}
        <p class="empty">Loading…</p>
      {:else}
        {#if sidecar.gated}
          <p class="note">
            This record is copyright-gated. Proposals touching fields that are not
            public for gated records are withheld from this view.
          </p>
        {/if}

        {#each sidecar.items as item (item.id)}
          <article class="item" class:decided={item.status !== "proposed"}>
            <div class="row">
              <code class="field">{target(item)}</code>
              <span class="conf conf-{item.confidence}">{item.confidence}</span>
              <span class="check">{item.check}</span>
            </div>

            <div class="diff">
              <div class="before"><span>−</span> {show(item.current)}</div>
              <div class="after"><span>+</span> {show(item.proposed)}</div>
            </div>

            <p class="why">{item.evidence.reasoning}</p>
            {#if item.evidence.sources.length}
              <ul class="sources">
                {#each item.evidence.sources as src (src)}
                  <li><a href={src} target="_blank" rel="noopener noreferrer">{src}</a></li>
                {/each}
              </ul>
            {/if}

            {#if item.status !== "proposed"}
              <p class="already">Already {item.status}.</p>
            {:else if canDecide}
              <div class="actions">
                <button
                  class="approve"
                  class:staged={staged[item.id] === "approved"}
                  onclick={() => stage(item, "approved")}
                >
                  Approve
                </button>
                <button
                  class="reject"
                  class:staged={staged[item.id] === "rejected"}
                  onclick={() => stage(item, "rejected")}
                >
                  Reject
                </button>
              </div>
            {/if}
          </article>
        {:else}
          <p class="empty">Checked, nothing to propose.</p>
        {/each}

        {#if canDecide && pending}
          <div class="commit">
            <button onclick={commit} disabled={saving}>
              {saving ? "Saving…" : `Commit ${pending} decision${pending === 1 ? "" : "s"}`}
            </button>
            <button class="link" onclick={() => (staged = {})} disabled={saving}>
              Clear
            </button>
          </div>
        {/if}
      {/if}
    </section>
  </div>
</div>

<style>
  .housekeeping {
    padding: 1.5rem 2rem 3rem;
    max-width: 1200px;
  }
  h2 {
    margin: 0 0 0.25rem;
  }
  .lede {
    margin: 0 0 1.5rem;
    max-width: 62ch;
    color: var(--text-muted, #666);
    line-height: 1.5;
  }
  .split {
    display: grid;
    grid-template-columns: minmax(240px, 22rem) 1fr;
    gap: 2rem;
    align-items: start;
  }
  .queue h3 {
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted, #666);
    margin: 0 0 0.75rem;
  }
  .queue ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .queue button {
    width: 100%;
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    align-items: center;
    padding: 0.6rem 0.75rem;
    text-align: left;
    background: none;
    border: 1px solid transparent;
    border-radius: 6px;
    cursor: pointer;
    font: inherit;
  }
  .queue button:hover {
    background: var(--surface-hover, #f4f4f5);
  }
  .queue button.active {
    background: var(--surface-active, #eef2ff);
    border-color: var(--accent, #6366f1);
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .counts {
    display: flex;
    gap: 0.25rem;
    flex: none;
  }
  .badge {
    min-width: 1.5rem;
    text-align: center;
    padding: 0.1rem 0.35rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }
  .badge.proposed {
    background: #fde68a;
    color: #78350f;
  }
  .badge.approved {
    background: #bbf7d0;
    color: #14532d;
  }
  .badge.rejected {
    background: #e5e7eb;
    color: #374151;
  }
  .item {
    border: 1px solid var(--border, #e5e7eb);
    border-radius: 8px;
    padding: 1rem 1.15rem;
    margin-bottom: 1rem;
  }
  .item.decided {
    opacity: 0.6;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    margin-bottom: 0.6rem;
    flex-wrap: wrap;
  }
  .field {
    font-weight: 600;
  }
  .conf {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
  }
  .conf-high {
    background: #bbf7d0;
    color: #14532d;
  }
  .conf-medium {
    background: #fde68a;
    color: #78350f;
  }
  .conf-low {
    background: #fecaca;
    color: #7f1d1d;
  }
  .check {
    font-size: 0.75rem;
    color: var(--text-muted, #666);
  }
  .diff {
    font-family: ui-monospace, monospace;
    font-size: 0.85rem;
    border-radius: 6px;
    overflow: hidden;
    margin-bottom: 0.6rem;
  }
  .diff > div {
    padding: 0.3rem 0.6rem;
  }
  .diff span {
    display: inline-block;
    width: 1rem;
    opacity: 0.6;
  }
  .before {
    background: #fef2f2;
    color: #7f1d1d;
  }
  .after {
    background: #f0fdf4;
    color: #14532d;
  }
  .why {
    margin: 0 0 0.5rem;
    line-height: 1.5;
  }
  .sources {
    margin: 0 0 0.5rem;
    padding-left: 1.1rem;
    font-size: 0.85rem;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
  }
  .actions button {
    padding: 0.35rem 0.9rem;
    border-radius: 6px;
    border: 1px solid var(--border, #d4d4d8);
    background: none;
    cursor: pointer;
    font: inherit;
  }
  .actions .approve.staged {
    background: #16a34a;
    border-color: #16a34a;
    color: #fff;
  }
  .actions .reject.staged {
    background: #6b7280;
    border-color: #6b7280;
    color: #fff;
  }
  .commit {
    position: sticky;
    bottom: 0;
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.9rem 0;
    background: var(--surface, #fff);
    border-top: 1px solid var(--border, #e5e7eb);
  }
  .commit button:first-child {
    padding: 0.5rem 1.1rem;
    border-radius: 6px;
    border: none;
    background: var(--accent, #6366f1);
    color: #fff;
    cursor: pointer;
    font: inherit;
  }
  .commit .link {
    background: none;
    border: none;
    color: var(--text-muted, #666);
    cursor: pointer;
    text-decoration: underline;
    font: inherit;
  }
  .note {
    background: #fffbeb;
    border: 1px solid #fcd34d;
    border-radius: 6px;
    padding: 0.6rem 0.85rem;
    margin: 0 0 1rem;
  }
  .already {
    margin: 0;
    font-size: 0.85rem;
    color: var(--text-muted, #666);
  }
  .empty {
    color: var(--text-muted, #666);
  }
  .error {
    background: #fef2f2;
    border: 1px solid #fca5a5;
    color: #7f1d1d;
    padding: 0.6rem 0.85rem;
    border-radius: 6px;
  }
</style>
