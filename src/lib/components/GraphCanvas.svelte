<script lang="ts">
  import { onMount } from "svelte";
  import cytoscape from "cytoscape";

  // A SCOPED node-link graph centred on one node (its ego-graph from
  // /api/graph/ego/<id>) - never the whole graph. Tap a node to recentre on it.
  let {
    nodeId,
    onRecenter,
  }: { nodeId: string; onRecenter?: (id: string) => void } = $props();

  // Distinguishable per-type colours (canvas-rendered, so fixed values not CSS vars).
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

  let container: HTMLDivElement;
  let cy = $state<cytoscape.Core | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let count = $state(0);
  let typesPresent = $state<string[]>([]);

  async function render(id: string) {
    loading = true;
    error = null;
    try {
      const res = await fetch(`/api/graph/ego/${id}?cap=40`);
      if (!res.ok) throw new Error(`Graph fetch failed (${res.status})`);
      const g = await res.json();
      count = g.nodes.length;
      typesPresent = [
        ...new Set<string>(g.nodes.map((n: { node_type: string }) => n.node_type)),
      ].sort();
      const elements = [
        ...g.nodes.map((n: { id: string; name: string; node_type: string; claims: number; center: boolean }) => ({
          data: { id: n.id, label: n.name, type: n.node_type, claims: n.claims, center: n.center ? 1 : 0 },
        })),
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
            {
              selector: "node[center = 1]",
              style: { "border-width": 3, "border-color": "#e8e8e0", "font-size": 12, "font-weight": "bold" },
            },
            {
              selector: "node:selected",
              style: { "border-width": 4, "border-color": "#6ea8fe" },
            },
            {
              selector: "edge",
              style: {
                width: "mapData(weight, 1, 40, 1, 6)",
                "line-color": "#4a4a46",
                "curve-style": "haystack",
                opacity: 0.6,
              },
            },
          ],
          layout: { name: "cose", animate: false, padding: 30, nodeRepulsion: 8000, idealEdgeLength: 90 },
          wheelSensitivity: 0.2,
        });
        cy.on("tap", "node", (evt) => {
          const id = evt.target.id();
          if (onRecenter) onRecenter(id);
        });
      } else {
        cy.elements().remove();
        cy.add(elements);
        cy.layout({ name: "cose", animate: false, padding: 30, nodeRepulsion: 8000, idealEdgeLength: 90 }).run();
      }
      // cytoscape can measure the flex container at 0 height before layout
      // settles - resize + fit on the next frame so it fills + centres.
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

  // Re-render whenever the centre node changes.
  $effect(() => {
    const id = nodeId;
    if (container) render(id);
  });

  onMount(() => () => cy?.destroy());
</script>

<div class="relative flex-1 min-h-0">
  <!-- cytoscape overrides absolute positioning on its container, so size it with
       real width/height (the relative flex-1 parent provides the box). -->
  <div bind:this={container} class="w-full h-full bg-surface"></div>

  {#if loading}
    <div class="absolute top-2 left-3 text-xs font-ui text-on-surface-muted">Loading graph...</div>
  {/if}
  {#if error}
    <div class="absolute top-2 left-3 text-xs font-ui text-error">{error}</div>
  {/if}

  <!-- Legend + scope note -->
  <div class="absolute top-2 right-2 max-w-[180px] rounded-md border border-border bg-surface-alt/90 px-2.5 py-2 text-[11px] font-ui">
    <div class="text-on-surface-muted mb-1">{count} nodes (scoped) · tap to recentre</div>
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
</div>
