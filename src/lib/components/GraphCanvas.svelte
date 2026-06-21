<script lang="ts">
  import { onMount } from "svelte";
  import cytoscape from "cytoscape";
  import { applyMerge, STATIC_READS } from "$lib/api";

  // A SCOPED node-link graph centred on one node (its ego-graph from
  // /api/graph/ego/<id>) - never the whole graph. Explore mode: tap a node to
  // recentre. Select mode: tap to multi-select, then merge the selected entities.
  let {
    nodeId,
    refreshKey = 0,
    onRecenter,
    onMerged,
  }: {
    nodeId: string;
    refreshKey?: number;
    onRecenter?: (id: string) => void;
    onMerged?: (survivorId: string) => void;
  } = $props();

  const TYPE_COLOUR: Record<string, string> = {
    person: "#6ea8fe",
    organisation: "#f0a868",
    event: "#7bd88f",
    place: "#e06c9f",
    matter: "#c2a5f0",
    document: "#9aa0a6",
    object: "#f7d774",
    concept: "#5fd0c5",
    topic: "#d98880",
    programme: "#85c1e9",
    pattern: "#bb8fce",
    investigation: "#f8c471",
    project: "#aab7b8",
  };
  const DEFAULT_COLOUR = "#9aa0a6";

  type Sel = { id: string; name: string; node_type: string; claims: number };

  let container: HTMLDivElement;
  let cy = $state<cytoscape.Core | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let count = $state(0);
  let typesPresent = $state<string[]>([]);

  let mode = $state<"explore" | "select">("explore");
  let search = $state("");
  let selected = $state<Sel[]>([]);
  let merging = $state(false);
  let mergeError = $state<string | null>(null);
  let canonical = $state("");

  async function render(id: string) {
    loading = true;
    error = null;
    try {
      // Static mode reads the pre-rendered ego file (rendered at cap=40 to match).
      const res = await fetch(
        STATIC_READS ? `/api/graph/ego/${id}.json` : `/api/graph/ego/${id}?cap=40`,
      );
      if (!res.ok) throw new Error(`Graph fetch failed (${res.status})`);
      const g = await res.json();
      count = g.nodes.length;
      typesPresent = [
        ...new Set<string>(g.nodes.map((n: { node_type: string }) => n.node_type)),
      ].sort();
      const elements = [
        ...g.nodes.map(
          (n: { id: string; name: string; node_type: string; claims: number; center: boolean }) => ({
            data: { id: n.id, label: n.name, type: n.node_type, claims: n.claims, center: n.center ? 1 : 0 },
          }),
        ),
        ...g.edges.map((e: { source: string; target: string; weight: number }) => ({
          data: { id: `${e.source}__${e.target}`, source: e.source, target: e.target, weight: e.weight },
        })),
      ];
      if (!cy) {
        cy = cytoscape({
          container,
          elements,
          style: [
            {
              selector: "node",
              style: {
                "background-color": (n: cytoscape.NodeSingular) => TYPE_COLOUR[n.data("type")] ?? DEFAULT_COLOUR,
                label: "data(label)",
                "font-size": 9,
                color: "#c8c8c0",
                "text-wrap": "ellipsis",
                "text-max-width": "90px",
                "text-valign": "bottom",
                "text-margin-y": 2,
                width: "mapData(claims, 0, 200, 16, 64)",
                height: "mapData(claims, 0, 200, 16, 64)",
                "min-zoomed-font-size": 6,
              },
            },
            { selector: "node[center = 1]", style: { "border-width": 3, "border-color": "#e8e8e0", "font-size": 12, "font-weight": "bold" } },
            { selector: "node:selected", style: { "border-width": 4, "border-color": "#6ea8fe" } },
            { selector: "node.dim", style: { opacity: 0.12 } },
            { selector: "node.match", style: { "border-width": 4, "border-color": "#f7d774" } },
            {
              selector: "edge",
              style: { width: "mapData(weight, 1, 40, 1, 6)", "line-color": "#4a4a46", "curve-style": "haystack", opacity: 0.6 },
            },
            { selector: "edge.dim", style: { opacity: 0.05 } },
          ],
          layout: { name: "cose", animate: false, padding: 30, nodeRepulsion: 8000, idealEdgeLength: 90 },
          wheelSensitivity: 0.2,
        });
        cy.on("tap", "node", (evt) => {
          if (mode === "explore") {
            onRecenter?.(evt.target.id());
          } else {
            const n = evt.target;
            n.selected() ? n.unselect() : n.select();
          }
        });
        cy.on("select unselect", "node", () => {
          selected = (cy?.$("node:selected") ?? [])
            .map((n: cytoscape.NodeSingular) => ({
              id: n.id(),
              name: n.data("label"),
              node_type: n.data("type"),
              claims: n.data("claims"),
            }));
        });
      } else {
        cy.elements().remove();
        cy.add(elements);
        cy.layout({ name: "cose", animate: false, padding: 30, nodeRepulsion: 8000, idealEdgeLength: 90 }).run();
      }
      selected = [];
      requestAnimationFrame(() => {
        cy?.resize();
        cy?.fit(undefined, 40);
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  // Highlight nodes whose name matches the search; dim the rest.
  $effect(() => {
    const q = search.trim().toLowerCase();
    if (!cy) return;
    cy.batch(() => {
      cy!.elements().removeClass("dim match");
      if (!q) return;
      const matches = cy!.nodes().filter((n) => (n.data("label") || "").toLowerCase().includes(q));
      cy!.elements().addClass("dim");
      matches.removeClass("dim").addClass("match");
      matches.connectedEdges().removeClass("dim");
    });
  });

  // Switching to explore clears any selection in progress.
  $effect(() => {
    if (mode === "explore" && cy) cy.$("node:selected").unselect();
  });

  let survivor = $derived(
    selected.length ? selected.reduce((a, b) => (b.claims > a.claims ? b : a)) : null,
  );
  $effect(() => {
    canonical = survivor?.name ?? "";
  });

  async function mergeSelected() {
    if (!survivor || selected.length < 2 || !canonical.trim()) return;
    merging = true;
    mergeError = null;
    try {
      const victims = selected.filter((s) => s.id !== survivor!.id);
      await applyMerge(survivor, victims, canonical.trim());
      onMerged?.(survivor.id); // parent recentres on the survivor + refreshes
      selected = [];
    } catch (e) {
      mergeError = e instanceof Error ? e.message : String(e);
    } finally {
      merging = false;
    }
  }

  $effect(() => {
    const id = nodeId;
    void refreshKey; // re-render when the parent bumps this (e.g. after a merge)
    if (container) render(id);
  });

  onMount(() => () => cy?.destroy());
</script>

<div class="relative flex-1 min-h-0">
  <!-- cytoscape overrides absolute positioning on its container, so size it with
       real width/height (the relative flex-1 parent provides the box). -->
  <div bind:this={container} class="w-full h-full bg-surface"></div>

  <!-- Search + mode controls -->
  <div class="absolute top-2 left-2 flex items-center gap-1.5">
    <input
      type="search"
      placeholder="Highlight..."
      bind:value={search}
      class="w-40 text-xs bg-surface-alt/90 border border-border rounded px-2 py-1 text-on-surface outline-none focus:border-primary placeholder:text-on-surface-muted/60"
    />
    <button
      onclick={() => (mode = mode === "explore" ? "select" : "explore")}
      class="text-xs font-ui px-2 py-1 rounded border cursor-pointer transition-colors
        {mode === 'select' ? 'bg-primary text-on-primary border-primary' : 'bg-surface-alt/90 border-border text-on-surface-secondary hover:bg-surface'}"
      title="Select mode: tap nodes to multi-select, then merge them"
    >{mode === "select" ? "Selecting" : "Select to merge"}</button>
  </div>

  {#if loading}<div class="absolute top-12 left-3 text-xs font-ui text-on-surface-muted">Loading graph...</div>{/if}
  {#if error}<div class="absolute top-12 left-3 text-xs font-ui text-error">{error}</div>{/if}

  <!-- Legend -->
  <div class="absolute top-2 right-2 max-w-[180px] rounded-md border border-border bg-surface-alt/90 px-2.5 py-2 text-[11px] font-ui">
    <div class="text-on-surface-muted mb-1">{count} nodes (scoped) · {mode === "select" ? "tap to select" : "tap to recentre"}</div>
    <div class="flex flex-col gap-0.5">
      {#each typesPresent as t}
        <div class="flex items-center gap-1.5">
          <span class="inline-block w-2.5 h-2.5 rounded-full" style="background-color: {TYPE_COLOUR[t] ?? DEFAULT_COLOUR}"></span>
          <span class="text-on-surface-secondary">{t}</span>
        </div>
      {/each}
    </div>
  </div>

  {#if cy}
    <button
      onclick={() => cy?.fit(undefined, 40)}
      class="absolute bottom-2 right-2 text-xs font-ui px-2 py-1 rounded border border-border bg-surface-alt text-on-surface-secondary hover:bg-surface cursor-pointer"
    >Fit</button>
  {/if}

  <!-- Merge panel: appears in select mode with 2+ nodes selected -->
  {#if mode === "select" && selected.length >= 2}
    <div class="absolute bottom-2 left-2 right-20 rounded-md border border-primary/40 bg-surface-alt/95 px-3 py-2.5 text-sm">
      <div class="flex items-baseline gap-2 flex-wrap mb-1.5">
        <span class="font-medium text-on-surface">Merge {selected.length} entities</span>
        {#if selected.some((s) => s.node_type !== survivor?.node_type)}
          <span class="text-[10px] font-ui px-1.5 py-0.5 rounded bg-warning/15 text-warning">spans types - check carefully</span>
        {/if}
      </div>
      <div class="flex flex-wrap gap-1 mb-2">
        {#each selected as s}
          <span class="text-xs font-ui px-1.5 py-0.5 rounded border border-border bg-surface text-on-surface-secondary">
            {s.name}<span class="text-on-surface-muted"> · {s.node_type}</span>
          </span>
        {/each}
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <label for="graph-canonical" class="text-xs font-ui text-on-surface-secondary">Canonical name</label>
        <input
          id="graph-canonical"
          type="text"
          bind:value={canonical}
          class="flex-1 min-w-[200px] px-2 py-1 rounded border border-border bg-surface text-on-surface text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        <button
          onclick={mergeSelected}
          disabled={merging || !canonical.trim()}
          class="px-3 py-1 rounded bg-primary text-on-primary text-sm font-medium cursor-pointer disabled:opacity-40 hover:opacity-90"
        >{merging ? "Merging..." : "Merge"}</button>
        <button onclick={() => cy?.$("node:selected").unselect()} class="px-2 py-1 rounded border border-border text-on-surface-secondary text-sm cursor-pointer hover:bg-surface">Clear</button>
      </div>
      {#if mergeError}<p class="text-xs text-error mt-1">{mergeError}</p>{/if}
    </div>
  {/if}
</div>
