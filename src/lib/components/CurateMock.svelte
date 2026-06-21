<script lang="ts">
  // CLICKABLE MOCK of the graph-curation candidate-queue card, for the go/no-go
  // decision - NOT the live feature. Hardcoded from real knowledge.db clusters
  // (the 2004 Nimitz event split; the recursively-mangled AARO org name). No
  // backend: selecting members / picking a canonical / "merge" are client-side
  // only. The live build reads candidates from merge-candidates.json, the
  // merge-log from node_merges, and applies via `python -m assimilator.merge`.

  type Member = { id: string; name: string; node_type: string; claims: number };
  type Candidate = {
    node_type: string;
    score: number;
    reason: "name-equiv" | "fuzzy" | "embedding";
    suggested_canonical: string;
    members: Member[];
    review: Member[];
    neighbours: { name: string; type: string; shared: number }[];
    facetNote?: string;
  };

  const REASON_LABEL = {
    "name-equiv": "identical after normalisation",
    fuzzy: "near-identical names",
    embedding: "same entity, different wording",
  };

  const candidates: Candidate[] = [
    {
      node_type: "event",
      score: 0.93,
      reason: "embedding",
      suggested_canonical: "2004 USS Nimitz (Tic Tac) UAP Encounter",
      members: [
        { id: "n1", name: "Tic Tac Sighting", node_type: "event", claims: 113 },
        { id: "n2", name: "Nimitz Carrier Strike Group Anomalous Aerial Vehicle (AAV) Detection Matter, 2004-11-10 to 2004-11-16", node_type: "event", claims: 77 },
        { id: "n3", name: "2004 Nimitz UAP Encounter", node_type: "event", claims: 69 },
        { id: "n4", name: "Nimitz F/A-18F UAP Intercept, 2004-11-14", node_type: "event", claims: 48 },
        { id: "n5", name: "Nimitz Unidentified Aerial Phenomena (UAP) Intercept, 2004-11-14", node_type: "event", claims: 14 },
        { id: "n6", name: "2004 Nimitz Unidentified Aerial Phenomena (UAP) Encounter", node_type: "event", claims: 13 },
      ],
      review: [
        { id: "n7", name: "Nimitz Unofficial Investigation", node_type: "event", claims: 5 },
      ],
      neighbours: [
        { name: "Fravor, David", type: "person", shared: 41 },
        { name: "USS Nimitz", type: "object", shared: 29 },
        { name: "USS Princeton", type: "object", shared: 17 },
        { name: "Tic Tac UAP Full Video", type: "document", shared: 12 },
        { name: "Nimitz Carrier Strike Group (CSG-11)", type: "organisation", shared: 11 },
      ],
      facetNote:
        "USS Nimitz (object, 49 claims) and Nimitz Carrier Strike Group / CSG-11 (organisation, 30) are DIFFERENT entities - the ship and the strike group - and are NOT in this within-type cluster. Merge a ship into an event only if you deliberately choose to, across types.",
    },
    {
      node_type: "organisation",
      score: 0.99,
      reason: "name-equiv",
      suggested_canonical: "All-Domain Anomaly Resolution Office (AARO)",
      members: [
        { id: "a1", name: "All-domain Anomaly Resolution Office (All-Domain Anomaly Resolution Office (All-domain Anomaly Resolution Office (AARO)))", node_type: "organisation", claims: 107 },
        { id: "a2", name: "All-Domain Anomaly Resolution Office (AARO)", node_type: "organisation", claims: 18 },
      ],
      review: [],
      neighbours: [
        { name: "Kirkpatrick, Sean", type: "person", shared: 22 },
        { name: "UAP Historical Record Report, Volume I", type: "matter", shared: 14 },
        { name: "US Department of Defense", type: "organisation", shared: 12 },
      ],
    },
  ];

  const TOTAL = 47; // mock queue depth - "x of 47"

  let index = $state(0);
  let current = $derived(candidates[index % candidates.length]);

  let selected = $state(new Set<string>());
  let canonicalChoice = $state<string>("__suggested__");
  let newName = $state("");
  let mergedNote = $state<string | null>(null);

  function resetForCurrent() {
    selected = new Set(current.members.map((m) => m.id));
    canonicalChoice = "__suggested__";
    newName = current.suggested_canonical;
    mergedNote = null;
  }
  // Initialise on first render and whenever the candidate changes.
  let lastIndex = $state(-1);
  $effect(() => {
    if (index !== lastIndex) {
      lastIndex = index;
      resetForCurrent();
    }
  });

  function toggle(id: string) {
    const s = new Set(selected);
    s.has(id) ? s.delete(id) : s.add(id);
    selected = s;
  }

  let selectedCount = $derived(selected.size);
  let canonicalName = $derived(
    canonicalChoice === "__suggested__"
      ? current.suggested_canonical
      : canonicalChoice === "__new__"
        ? newName
        : ([...current.members, ...current.review].find((m) => m.id === canonicalChoice)?.name ??
          current.suggested_canonical),
  );

  function doMerge() {
    if (selectedCount < 2) return;
    mergedNote = `Merged ${selectedCount} nodes into "${canonicalName}". (mock - no backend write)`;
  }
  function next() {
    index = index + 1;
  }
</script>

<div class="flex-1 overflow-auto">
  <div class="bg-warning/15 border-b border-warning/40 px-6 py-1.5 text-xs font-ui text-warning text-center">
    MOCK - graph-curation candidate queue, for review only. No backend; nothing is written.
  </div>

  <div class="max-w-3xl mx-auto px-6 py-6 space-y-4">
    <!-- Queue position -->
    <div class="flex items-baseline justify-between">
      <h2 class="text-lg font-medium text-on-surface">Merge candidates</h2>
      <span class="text-sm font-ui text-on-surface-muted tabular-nums">
        candidate {(index % candidates.length) + 1} of {TOTAL}
      </span>
    </div>
    <p class="text-sm text-on-surface-secondary">
      The assimilator proposes clusters it has AI-verified to be one entity. Confirm the members,
      pick the canonical name, and merge - or skip. Highest-confidence first.
    </p>

    <!-- The candidate card -->
    <div class="rounded-lg border border-border bg-surface p-4 space-y-4">
      <!-- Header: type + confidence + reason -->
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-xs font-ui px-2 py-0.5 rounded bg-primary/10 text-primary uppercase tracking-wide">
          {current.node_type}
        </span>
        <span class="text-xs font-ui text-on-surface-secondary">
          {Math.round(current.score * 100)}% confident · {REASON_LABEL[current.reason]}
        </span>
        <span class="flex-1"></span>
        <span class="text-xs font-ui text-on-surface-muted tabular-nums">{selectedCount} selected</span>
      </div>

      <!-- Members (checked = will merge) -->
      <div class="space-y-1.5">
        {#each current.members as m (m.id)}
          <label class="flex items-baseline gap-2.5 px-2.5 py-1.5 rounded border border-border bg-surface-alt cursor-pointer hover:bg-surface">
            <input type="checkbox" checked={selected.has(m.id)} onchange={() => toggle(m.id)} class="mt-0.5 accent-primary" />
            <span class="text-sm text-on-surface flex-1 min-w-0">{m.name}</span>
            <span class="text-[10px] font-ui px-1.5 py-0.5 rounded bg-primary/10 text-primary flex-none">{m.node_type}</span>
            <span class="text-xs font-ui text-on-surface-muted tabular-nums flex-none w-16 text-right">{m.claims} claims</span>
          </label>
        {/each}
        {#if current.review.length > 0}
          <p class="text-xs font-ui text-on-surface-muted pt-1.5">Suggested for review (unchecked - confirm before including):</p>
          {#each current.review as m (m.id)}
            <label class="flex items-baseline gap-2.5 px-2.5 py-1.5 rounded border border-dashed border-warning/50 bg-warning/5 cursor-pointer">
              <input type="checkbox" checked={selected.has(m.id)} onchange={() => toggle(m.id)} class="mt-0.5 accent-warning" />
              <span class="text-sm text-on-surface flex-1 min-w-0">{m.name}</span>
              <span class="text-[10px] font-ui px-1.5 py-0.5 rounded bg-warning/15 text-warning flex-none">{m.node_type}</span>
              <span class="text-xs font-ui text-on-surface-muted tabular-nums flex-none w-16 text-right">{m.claims} claims</span>
            </label>
          {/each}
        {/if}
      </div>

      <!-- Canonical name -->
      <div class="space-y-1.5 border-t border-border pt-3">
        <p class="text-xs font-ui font-medium text-on-surface-secondary">Canonical name</p>
        <label class="flex items-center gap-2 text-sm text-on-surface cursor-pointer">
          <input type="radio" name="canon" checked={canonicalChoice === "__suggested__"} onchange={() => (canonicalChoice = "__suggested__")} class="accent-primary" />
          <span>{current.suggested_canonical}</span>
          <span class="text-[10px] font-ui px-1.5 py-0.5 rounded bg-success/15 text-success">suggested</span>
        </label>
        {#each selected as id (id)}
          {@const m = [...current.members, ...current.review].find((x) => x.id === id)}
          {#if m}
            <label class="flex items-center gap-2 text-sm text-on-surface-secondary cursor-pointer">
              <input type="radio" name="canon" checked={canonicalChoice === id} onchange={() => (canonicalChoice = id)} class="accent-primary" />
              <span class="truncate">{m.name}</span>
            </label>
          {/if}
        {/each}
        <label class="flex items-center gap-2 text-sm cursor-pointer">
          <input type="radio" name="canon" checked={canonicalChoice === "__new__"} onchange={() => (canonicalChoice = "__new__")} class="accent-primary" />
          <input
            type="text"
            bind:value={newName}
            onfocus={() => (canonicalChoice = "__new__")}
            placeholder="write a new name (follow the naming convention)"
            class="flex-1 px-2 py-1 rounded border border-border bg-surface text-on-surface text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
        </label>
      </div>

      <!-- Relations (v1: a ranked neighbours list, not a hairball) -->
      <div class="space-y-1 border-t border-border pt-3">
        <p class="text-xs font-ui font-medium text-on-surface-secondary">
          Related nodes <span class="text-on-surface-muted font-normal">- shares claims with (a scoped neighbours list; the visual ego-graph is the fast-follow)</span>
        </p>
        <div class="flex flex-wrap gap-1.5">
          {#each current.neighbours as nb}
            <span class="text-xs font-ui px-2 py-0.5 rounded border border-border bg-surface-alt text-on-surface-secondary">
              {nb.name} <span class="text-on-surface-muted">· {nb.type} · {nb.shared}</span>
            </span>
          {/each}
        </div>
      </div>

      {#if current.facetNote}
        <p class="text-xs font-ui text-on-surface-muted border-t border-border pt-3 leading-relaxed">
          <span class="text-warning font-medium">Facets kept separate:</span> {current.facetNote}
        </p>
      {/if}

      <!-- Actions -->
      <div class="flex items-center gap-2 border-t border-border pt-3">
        <button
          onclick={doMerge}
          disabled={selectedCount < 2}
          class="px-3 py-1.5 rounded bg-primary text-on-primary text-sm font-medium cursor-pointer disabled:opacity-40 hover:opacity-90"
        >Merge {selectedCount} nodes</button>
        <button onclick={next} class="px-3 py-1.5 rounded border border-border text-on-surface-secondary text-sm cursor-pointer hover:bg-surface-alt">Not a duplicate</button>
        <button onclick={next} class="px-3 py-1.5 rounded text-on-surface-muted text-sm cursor-pointer hover:bg-surface-alt">Skip</button>
        <span class="flex-1"></span>
        {#if mergedNote}
          <span class="text-sm text-success">{mergedNote}</span>
        {/if}
      </div>
    </div>

    {#if mergedNote}
      <div class="text-center">
        <button onclick={next} class="px-4 py-1.5 rounded bg-success text-on-success text-sm font-medium cursor-pointer">Next candidate &rarr;</button>
      </div>
    {/if}
  </div>
</div>
