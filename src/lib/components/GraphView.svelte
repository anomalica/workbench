<script lang="ts">
  import { onMount } from "svelte";
  import {
    fetchGraphStats,
    fetchGraphNodes,
    fetchGraphNode,
    applyMerge,
    type GraphStats,
    type GraphNodeSummary,
    type GraphNodeDetail as GraphNodeDetailT,
    type MergeMember,
  } from "$lib/api";
  import GraphNodeDetail from "./GraphNodeDetail.svelte";
  import GraphCanvas from "./GraphCanvas.svelte";

  // Deprecated node types (node-types.md): no longer emitted by extraction, they
  // linger only in stale pre-re-digestion data. Hidden from the type filter so it
  // offers only the live taxonomy (person/organisation/event/place/document/object/
  // topic/project); the dead-type nodes themselves clear on the next re-digestion +
  // rebuild. Blocklist (not allow-list) so any live/new type still shows.
  const DEAD_TYPES = new Set([
    "matter",
    "concept",
    "programme",
    "investigation",
    "classification",
  ]);

  // Optional node to open on mount (deep link: /graph/<node_id>), so the
  // curation card / any link can jump straight to a node's claims in context.
  let {
    initialNodeId,
    canRename = false,
  }: { initialNodeId?: string; canRename?: boolean } = $props();

  let stats = $state<GraphStats | null>(null);
  let unavailable = $state(false);
  let booted = $state(false);
  let nodes = $state<GraphNodeSummary[]>([]);
  let loadingList = $state(false);
  let selectedType = $state("");
  let query = $state("");
  let mergedOnly = $state(false);
  let selectedId = $state<string | null>(null);
  let selectedNode = $state<GraphNodeDetailT | null>(null);
  let renameNotice = $state<string | null>(null);
  let loadingNode = $state(false);
  let detailView = $state<"claims" | "graph">("claims");
  let graphRefresh = $state(0);

  // Multi-select merge: propose merging several BROWSED nodes as one entity - for
  // links the assimilator's matcher missed (it only auto-proposes connected/similar
  // pairs, and the ego-graph merge only spans one node's neighbours). Same
  // applyMerge path as the candidate queue. In select mode a click toggles a node
  // into the set instead of opening its detail.
  let selectMode = $state(false);
  let selectedForMerge = $state<GraphNodeSummary[]>([]);
  let mergeCanonical = $state("");
  let merging = $state(false);
  let mergeError = $state<string | null>(null);
  let mergeSurvivor = $derived(
    selectedForMerge.length
      ? selectedForMerge.reduce((a, b) => (b.claim_count > a.claim_count ? b : a))
      : null,
  );
  // Default the canonical name to the survivor's (most-claimed) name.
  $effect(() => {
    mergeCanonical = mergeSurvivor?.name ?? "";
  });

  function toggleSelectMode() {
    selectMode = !selectMode;
    selectedForMerge = [];
    mergeError = null;
  }

  function toggleNodeSelection(node: GraphNodeSummary) {
    selectedForMerge = selectedForMerge.some((n) => n.id === node.id)
      ? selectedForMerge.filter((n) => n.id !== node.id)
      : [...selectedForMerge, node];
  }

  const asMember = (n: GraphNodeSummary): MergeMember => ({
    id: n.id,
    name: n.name,
    node_type: n.node_type,
    claims: n.claim_count,
    aliases: [],
  });

  async function doMergeSelected() {
    if (!mergeSurvivor || selectedForMerge.length < 2 || !mergeCanonical.trim()) return;
    merging = true;
    mergeError = null;
    try {
      const survivorId = mergeSurvivor.id;
      const victims = selectedForMerge.filter((n) => n.id !== survivorId);
      await applyMerge(asMember(mergeSurvivor), victims.map(asMember), mergeCanonical.trim());
      selectMode = false;
      selectedForMerge = [];
      await loadNodes();
      selectNode(survivorId); // open the survivor so the result is visible
    } catch (e) {
      mergeError = e instanceof Error ? e.message : String(e);
    } finally {
      merging = false;
    }
  }

  function setDetailView(v: "claims" | "graph") {
    detailView = v;
    // ?view=graph makes a scoped graph view bookmarkable; claims is the default.
    const p = new URLSearchParams(window.location.search);
    if (v === "graph") p.set("view", "graph");
    else p.delete("view");
    const qs = p.toString();
    history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
  }

  /** A rename leaves the node where it is; a merge retires it, so the view has
   *  to follow the survivor or it sits on a node that no longer exists. */
  function afterRename(message: string, survivorId?: string) {
    renameNotice = message;
    if (survivorId) onMerged(survivorId);
    else {
      if (selectedId) selectNode(selectedId);
      loadNodes();
    }
  }

  function onMerged(survivorId: string) {
    // After a merge the victims are gone: recentre on the survivor + refresh the
    // graph (even if it was already the centre) and the browse list.
    graphRefresh += 1;
    selectNode(survivorId);
    loadNodes();
  }

  // The merge toggle filters client-side: merges are few (a handful of nodes),
  // and the list is already loaded, so no need for a server round-trip.
  let displayed = $derived(mergedOnly ? nodes.filter((n) => n.alias_count > 0) : nodes);

  async function loadNodes() {
    loadingList = true;
    try {
      nodes = await fetchGraphNodes(selectedType || undefined, query.trim() || undefined);
    } finally {
      loadingList = false;
    }
  }

  async function selectNode(id: string) {
    selectedId = id;
    loadingNode = true;
    try {
      selectedNode = await fetchGraphNode(id);
    } finally {
      loadingNode = false;
    }
  }

  onMount(async () => {
    stats = await fetchGraphStats();
    if (!stats) {
      unavailable = true;
      booted = true;
      return;
    }
    await loadNodes();
    booted = true;
    if (new URLSearchParams(window.location.search).get("view") === "graph") {
      detailView = "graph";
    }
    if (initialNodeId) selectNode(initialNodeId);
  });

  // Debounced re-query when the type filter or search text changes.
  let debounce: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const _t = selectedType;
    const _q = query;
    if (!booted) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => loadNodes(), 180);
  });
</script>

{#if unavailable}
  <div class="flex-1 flex flex-col items-center justify-center gap-2 text-on-surface-muted px-6 text-center">
    <p class="text-sm font-ui">The assimilator's knowledge graph isn't available.</p>
    <p class="text-xs">No database found at the configured path (GRAPH_DB_PATH).</p>
  </div>
{:else}
  <!-- Overview: totals + per-type chips that double as the type filter -->
  {#if stats}
    <div class="px-6 py-3 border-b border-border bg-surface-alt flex items-center gap-x-5 gap-y-1 flex-wrap flex-none">
      <div class="flex items-baseline gap-1.5">
        <span class="text-lg font-medium text-on-surface tabular-nums">{stats.total_nodes}</span>
        <span class="text-xs font-ui text-on-surface-secondary">entities</span>
      </div>
      <div class="flex items-baseline gap-1.5">
        <span class="text-lg font-medium text-on-surface tabular-nums">{stats.total_claims}</span>
        <span class="text-xs font-ui text-on-surface-secondary">claims</span>
      </div>
      <button
        onclick={() => { mergedOnly = !mergedOnly; }}
        class="flex items-baseline gap-1.5 px-2 py-0.5 rounded cursor-pointer transition-colors
          {mergedOnly ? 'bg-amber-400/20 ring-1 ring-amber-500/50' : 'hover:bg-surface'}"
        title="Show only entities that had surface forms merged into them"
      >
        <span class="text-lg font-medium text-amber-600 dark:text-amber-400 tabular-nums">{stats.total_merges}</span>
        <span class="text-xs font-ui text-on-surface-secondary">merges</span>
      </button>
      {#if stats.total_corroborations > 0}
        <div class="flex items-baseline gap-1.5">
          <span class="text-lg font-medium text-on-surface tabular-nums">{stats.total_corroborations}</span>
          <span class="text-xs font-ui text-on-surface-secondary">corroborations</span>
        </div>
      {/if}
      <div class="flex-1"></div>
      <div class="flex items-center gap-1 flex-wrap">
        <button
          onclick={() => { selectedType = ""; }}
          class="text-xs font-ui px-2 py-1 rounded cursor-pointer transition-colors
            {selectedType === '' ? 'bg-primary text-on-primary' : 'text-on-surface-secondary hover:bg-surface'}"
        >All</button>
        {#each stats.by_type.filter((t) => !DEAD_TYPES.has(t.type)) as t}
          <button
            onclick={() => { selectedType = t.type; }}
            class="text-xs font-ui px-2 py-1 rounded cursor-pointer transition-colors
              {selectedType === t.type ? 'bg-primary text-on-primary' : 'text-on-surface-secondary hover:bg-surface'}"
            title={`${t.count} ${t.type}`}
          >{t.type} <span class="tabular-nums opacity-70">{t.count}</span></button>
        {/each}
      </div>
    </div>
  {/if}

  <div class="flex-1 flex min-h-0">
    <!-- Browse / search -->
    <div class="w-80 flex-none border-r border-border flex flex-col min-h-0">
      <div class="px-3 py-2 border-b border-border flex-none space-y-2">
        <input
          type="search"
          placeholder="Search entities + aliases..."
          bind:value={query}
          class="w-full text-sm bg-surface border border-border rounded px-3 py-1.5
            text-on-surface outline-none focus:border-primary placeholder:text-on-surface-muted/60"
        />
        <div class="flex items-center justify-between">
          <button
            onclick={toggleSelectMode}
            class="text-xs font-ui px-2 py-1 rounded cursor-pointer transition-colors
              {selectMode ? 'bg-primary text-on-primary' : 'text-on-surface-secondary hover:bg-surface'}"
            title="Select several entities and mark them as the same (a human-proposed merge)"
          >{selectMode ? "Selecting to merge" : "Select to merge"}</button>
          {#if selectMode}
            <span class="text-[11px] font-ui text-on-surface-muted tabular-nums"
              >{selectedForMerge.length} selected</span
            >
          {/if}
        </div>
      </div>
      <div class="flex-1 overflow-auto">
        {#if loadingList && nodes.length === 0}
          <p class="text-on-surface-muted text-sm p-4 font-ui">Loading...</p>
        {:else if displayed.length === 0}
          <p class="text-on-surface-muted text-sm p-4 font-ui">
            {mergedOnly ? "No merged entities match." : "No entities match."}
          </p>
        {:else}
          {#each displayed as node (node.id)}
            {@const picked = selectedForMerge.some((n) => n.id === node.id)}
            <button
              onclick={() => (selectMode ? toggleNodeSelection(node) : selectNode(node.id))}
              class="w-full text-left px-3 py-2 border-b border-border/40 cursor-pointer transition-colors
                {selectMode && picked
                ? 'bg-primary/20 ring-1 ring-inset ring-primary'
                : !selectMode && selectedId === node.id
                  ? 'bg-primary/10'
                  : 'hover:bg-surface-alt'}"
            >
              <div class="flex items-baseline gap-2">
                {#if selectMode}
                  <span
                    class="flex-none w-3 h-3 mt-0.5 rounded-sm border self-center
                      {picked ? 'bg-primary border-primary' : 'border-on-surface-muted/50'}"
                  ></span>
                {/if}
                <span class="text-sm text-on-surface truncate flex-1 min-w-0">{node.name}</span>
                {#if node.alias_count > 0}
                  <span
                    class="text-[10px] font-ui font-medium px-1.5 py-0.5 rounded flex-none
                      bg-amber-400/20 text-amber-700 dark:text-amber-300"
                    title={`${node.alias_count} surface forms merged into this entity`}
                  >+{node.alias_count} merged</span>
                {/if}
              </div>
              <div class="flex items-center gap-2 mt-0.5 text-[11px] font-ui text-on-surface-muted">
                <span class="text-primary uppercase tracking-wide">{node.node_type}</span>
                <span>·</span>
                <span class="tabular-nums">{node.claim_count} claims</span>
              </div>
            </button>
          {/each}
        {/if}
      </div>
      <!-- Human-proposed merge: appears in select mode with 2+ entities picked. -->
      {#if selectMode && selectedForMerge.length >= 2}
        <div class="border-t border-border p-3 flex-none bg-surface-alt/40 space-y-2">
          <div class="text-[11px] font-ui text-on-surface-secondary leading-snug">
            Merge {selectedForMerge.length} entities into one. Survivor (most claims):
            <span class="text-on-surface">{mergeSurvivor?.name}</span>
          </div>
          <input
            bind:value={mergeCanonical}
            placeholder="Canonical name"
            class="w-full text-sm bg-surface border border-border rounded px-2 py-1
              text-on-surface outline-none focus:border-primary"
          />
          {#if mergeError}
            <div class="text-[11px] text-red-500">{mergeError}</div>
          {/if}
          <div class="flex gap-2">
            <button
              onclick={doMergeSelected}
              disabled={merging || !mergeCanonical.trim()}
              class="flex-1 text-xs font-ui px-2 py-1.5 rounded bg-primary text-on-primary
                disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >{merging ? "Merging..." : "Merge as same"}</button>
            <button
              onclick={() => (selectedForMerge = [])}
              class="text-xs font-ui px-2 py-1.5 rounded text-on-surface-secondary
                hover:bg-surface cursor-pointer"
            >Clear</button>
          </div>
        </div>
      {/if}
    </div>

    <!-- Detail: a node's claims, or the scoped visual graph centred on it -->
    <div class="flex-1 flex flex-col min-h-0">
      {#if renameNotice}
        <!-- Above the detail, not inside it: after a merge the pane is showing
             the SURVIVOR, and what happened to the other one needs saying. -->
        <div class="flex items-start gap-2 border-b border-border bg-surface-alt px-4 py-2 text-xs text-on-surface">
          <span class="flex-1">{renameNotice}</span>
          <button
            onclick={() => (renameNotice = null)}
            aria-label="Dismiss"
            class="rounded px-1 text-on-surface-muted hover:text-on-surface"
          >×</button>
        </div>
      {/if}
      {#if selectedId}
        <div class="px-4 py-1.5 border-b border-border flex items-center gap-1 flex-none">
          <button
            onclick={() => setDetailView("claims")}
            class="text-xs font-ui px-2.5 py-1 rounded cursor-pointer transition-colors
              {detailView === 'claims' ? 'bg-primary text-on-primary' : 'text-on-surface-secondary hover:bg-surface-alt'}"
          >Claims</button>
          <button
            onclick={() => setDetailView("graph")}
            class="text-xs font-ui px-2.5 py-1 rounded cursor-pointer transition-colors
              {detailView === 'graph' ? 'bg-primary text-on-primary' : 'text-on-surface-secondary hover:bg-surface-alt'}"
            title="A scoped node-link graph centred on this entity"
          >Graph</button>
        </div>
      {/if}
      {#if selectedId && detailView === "graph"}
        <GraphCanvas nodeId={selectedId} refreshKey={graphRefresh} onRecenter={selectNode} {onMerged} />
      {:else}
        <GraphNodeDetail
          node={selectedNode}
          loading={loadingNode}
          {canRename}
          onchanged={afterRename}
        />
      {/if}
    </div>
  </div>
{/if}
