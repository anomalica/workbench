<script lang="ts">
  import { onMount } from "svelte";
  import {
    fetchProposals,
    fetchProposal,
    approveProposal,
    rejectProposal,
    type ProposalSummary,
    type ProposalDetail,
    type IngestSummary,
  } from "$lib/api";
  import DiffViewer from "./DiffViewer.svelte";

  // Records list (from the parent) so a proposal's record hash resolves to a
  // human title in the queue rather than a bare hash. `onqueuechange` lets the
  // parent refresh its pending-count badge after an approve/reject.
  let {
    ingests = [] as IngestSummary[],
    onqueuechange = () => {},
  }: { ingests?: IngestSummary[]; onqueuechange?: () => void } = $props();

  let proposals = $state<ProposalSummary[]>([]);
  let loading = $state(true);
  let selectedId = $state<string | null>(null);
  let detail = $state<ProposalDetail | null>(null);
  let detailLoading = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  let titleByHash = $derived.by(() => {
    const m = new Map<string, string>();
    for (const it of ingests) m.set(it.content_hash, it.title ?? "");
    return m;
  });

  function recordTitle(hash: string): string {
    return titleByHash.get(hash) || `${hash.slice(0, 12)}…`;
  }

  function timeAgo(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return "";
    const s = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    return `${Math.round(h / 24)} d ago`;
  }

  async function load() {
    loading = true;
    error = null;
    proposals = await fetchProposals();
    loading = false;
    // Keep the current selection if it still exists, else pick the first.
    if (!proposals.some((p) => p.id === selectedId)) {
      selectedId = proposals[0]?.id ?? null;
    }
    if (selectedId) void select(selectedId);
    else detail = null;
  }

  async function select(id: string) {
    selectedId = id;
    detailLoading = true;
    detail = null;
    detail = await fetchProposal(id);
    detailLoading = false;
  }

  async function approve() {
    if (!selectedId || busy) return;
    busy = true;
    error = null;
    const ok = await approveProposal(selectedId);
    busy = false;
    if (!ok) {
      error = "Approve failed - check you still have reviewer access.";
      return;
    }
    afterAction(selectedId);
  }

  async function reject() {
    if (!selectedId || busy) return;
    busy = true;
    error = null;
    const ok = await rejectProposal(selectedId);
    busy = false;
    if (!ok) {
      error = "Reject failed.";
      return;
    }
    afterAction(selectedId);
  }

  /** Drop the actioned proposal from the queue and advance to the next. */
  function afterAction(id: string) {
    const idx = proposals.findIndex((p) => p.id === id);
    proposals = proposals.filter((p) => p.id !== id);
    const next = proposals[idx] ?? proposals[idx - 1] ?? null;
    selectedId = next?.id ?? null;
    if (selectedId) void select(selectedId);
    else detail = null;
    onqueuechange();
  }

  onMount(load);
</script>

<div class="flex h-full min-h-0">
  <!-- Queue -->
  <aside class="w-80 flex-none border-r border-border flex flex-col min-h-0">
    <!-- Inbox, holding sections. Proposals is the only kind of item today;
         naming the section rather than the page keeps the door open for the
         others (messages, and whatever else arrives) without inventing an
         item-type abstraction against a single implementation. -->
    <div class="flex-none flex items-center justify-between px-4 py-3 border-b border-border">
      <h2 class="text-sm font-ui font-semibold text-on-surface">Inbox</h2>
      <button
        onclick={load}
        class="text-xs font-ui text-primary cursor-pointer hover:underline"
        title="Refresh the inbox"
      >Refresh</button>
    </div>
    <div class="flex-none px-4 py-1.5 border-b border-border/60 bg-surface-alt/40 flex items-center gap-1.5">
      <span class="text-[11px] font-ui font-semibold uppercase tracking-wide text-on-surface-secondary">
        Proposals
      </span>
      {#if proposals.length}
        <span class="text-[11px] font-ui text-on-surface-muted tabular-nums">({proposals.length})</span>
      {/if}
    </div>
    <div class="flex-1 overflow-auto">
      {#if loading}
        <p class="px-4 py-6 text-sm text-on-surface-muted">Loading…</p>
      {:else if proposals.length === 0}
        <p class="px-4 py-6 text-sm text-on-surface-muted">
          No proposals waiting. Contributor edits queue here for approval.
        </p>
      {:else}
        <ul>
          {#each proposals as p (p.id)}
            <li>
              <button
                onclick={() => select(p.id)}
                class="w-full text-left px-4 py-3 border-b border-border/60 cursor-pointer transition-colors
                  {selectedId === p.id ? 'bg-primary-container/25' : 'hover:bg-surface-alt'}"
              >
                <span class="block text-sm font-medium text-on-surface truncate">{recordTitle(p.record_hash)}</span>
                <span class="block text-xs text-on-surface-secondary truncate mt-0.5">
                  {p.author_name || p.author_login || "unknown"}
                  · {timeAgo(p.created_at)}
                </span>
                {#if p.notes}
                  <span class="block text-xs text-on-surface-muted truncate mt-0.5 italic">{p.notes}</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </aside>

  <!-- Detail -->
  <section class="flex-1 flex flex-col min-h-0">
    {#if !selectedId}
      <div class="flex-1 grid place-items-center text-sm text-on-surface-muted">
        {loading ? "" : "Select a proposal to review its diff."}
      </div>
    {:else if detailLoading}
      <div class="flex-1 grid place-items-center text-sm text-on-surface-muted">Loading diff…</div>
    {:else if detail}
      {@const p = detail.proposal}
      <header class="flex-none px-6 py-4 border-b border-border">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <h1 class="text-base font-semibold text-on-surface truncate">
              {detail.record_title || recordTitle(p.record_hash)}
            </h1>
            <p class="text-xs text-on-surface-secondary mt-1">
              Proposed by <span class="font-medium">{p.author_name || p.author_login}</span>
              · {timeAgo(p.created_at)}
              {#if !detail.record_exists}
                · <span class="text-warning">record no longer present</span>
              {/if}
            </p>
            {#if p.notes}
              <p class="text-sm text-on-surface mt-2 whitespace-pre-wrap">{p.notes}</p>
            {/if}
          </div>
          <div class="flex-none flex items-center gap-2">
            <button
              onclick={reject}
              disabled={busy}
              class="px-3 py-1.5 rounded text-xs font-ui font-medium border border-border text-on-surface-secondary
                hover:bg-error-container/30 hover:text-on-error-container hover:border-error/40 cursor-pointer disabled:opacity-50"
            >Reject</button>
            <button
              onclick={approve}
              disabled={busy}
              class="px-3 py-1.5 rounded text-xs font-ui font-medium bg-primary text-on-primary
                hover:bg-primary/90 cursor-pointer disabled:opacity-50"
              title="Commit this edit to the record, attributed to the contributor"
            >Approve</button>
          </div>
        </div>
        {#if error}
          <p class="text-xs text-error mt-2">{error}</p>
        {/if}
      </header>
      <div class="flex-1 overflow-auto">
        <DiffViewer original={detail.current_content} modified={p.content} />
      </div>
    {:else}
      <div class="flex-1 grid place-items-center text-sm text-error">
        Could not load this proposal.
      </div>
    {/if}
  </section>
</div>
