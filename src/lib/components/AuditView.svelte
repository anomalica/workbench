<script lang="ts">
  // Model/digest audit view: compare a record's extraction variants against each
  // other, walking the record passage by passage. Per passage, the source on one
  // side and the claims clustered by meaning on the other - each cluster showing
  // which variants produced it and their phrasings, singletons (one variant only)
  // flagged as unique recall or hallucination. Read-only for now; per-cluster
  // adjudication is the next layer.
  import { fetchAudit, type AuditPayload, type AuditCluster } from "$lib/api";

  let { hash }: { hash: string } = $props();

  let status = $state<"loading" | "ready" | "empty" | "error">("loading");
  let payload = $state<AuditPayload | null>(null);

  // Colour per variant, by its order in the record - reused in the summary and in
  // every cluster's attribution so a model reads the same colour throughout.
  const PALETTE = ["#0ea5e9", "#f59e0b", "#8b5cf6", "#ec4899", "#22c55e", "#ef4444"];
  let colourOf = $derived.by(() => {
    const m = new Map<string, string>();
    (payload?.variants ?? []).forEach((v, i) => m.set(v.id, PALETTE[i % PALETTE.length]));
    return m;
  });
  let modelOf = $derived.by(() => {
    const m = new Map<string, string>();
    (payload?.variants ?? []).forEach((v) => m.set(v.id, v.model));
    return m;
  });

  $effect(() => {
    const h = hash;
    status = "loading";
    payload = null;
    fetchAudit(h)
      .then((p) => {
        if (h !== hash) return; // a newer record superseded this fetch
        if (!p || p.variants.length === 0) {
          status = "empty";
        } else {
          payload = p;
          status = "ready";
        }
      })
      .catch(() => {
        if (h === hash) status = "error";
      });
  });

  function clock(s: number): string {
    const t = Math.max(0, Math.floor(s));
    const m = Math.floor(t / 60);
    const sec = String(t % 60).padStart(2, "0");
    const h = Math.floor(m / 60);
    return h > 0 ? `${h}:${String(m % 60).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  }

  function passageLabel(start: number, end: number, raws: string[]): string {
    if (end > start || start > 0) return end > start ? `${clock(start)}–${clock(end)}` : clock(start);
    return raws[0] ?? "—";
  }

  // The distinct source quotes a passage's claims cited - the "source side".
  function passageQuotes(clusters: AuditCluster[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of clusters) {
      for (const m of c.members) {
        const q = m.quote.trim();
        if (q && q !== "(mock)" && !seen.has(q)) {
          seen.add(q);
          out.push(q);
        }
      }
    }
    return out;
  }

  // Distinct phrasings in a cluster, one per variant (the wording each model
  // used). Same text from several variants shows once, tagged with all of them.
  function phrasings(c: AuditCluster): { text: string; variants: string[] }[] {
    const byText = new Map<string, Set<string>>();
    for (const m of c.members) {
      (byText.get(m.text) ?? byText.set(m.text, new Set()).get(m.text)!).add(m.variant);
    }
    return [...byText.entries()].map(([text, vs]) => ({ text, variants: [...vs] }));
  }
</script>

<div class="flex-1 flex flex-col min-h-0 font-ui bg-surface">
  {#if status === "loading"}
    <p class="p-6 text-sm text-on-surface-muted">Loading audit…</p>
  {:else if status === "empty"}
    <p class="p-6 text-sm text-on-surface-muted">
      No extraction variants for this record yet. The audit compares several model
      digests of one record; it appears once more than one has been produced.
    </p>
  {:else if status === "error"}
    <p class="p-6 text-sm text-error">Could not load the audit for this record.</p>
  {:else if payload}
    <!-- Variant summary: model, claim count, cost - colour-keyed to the clusters. -->
    <div class="flex-none px-4 py-3 border-b border-border bg-surface-alt flex flex-wrap items-center gap-3">
      <span class="text-xs font-medium text-on-surface-secondary">
        {payload.variants.length} variants · {payload.passages.length} passages
      </span>
      {#each payload.variants as v (v.id)}
        <span class="inline-flex items-center gap-1.5 text-xs">
          <span class="w-2.5 h-2.5 rounded-full flex-none" style="background:{colourOf.get(v.id)}"></span>
          <span class="font-medium text-on-surface">{v.model}</span>
          <span class="text-on-surface-muted tabular-nums">{v.claim_count} claims</span>
          {#if v.cost_usd != null}
            <span class="text-on-surface-muted tabular-nums">${v.cost_usd.toFixed(2)}</span>
          {/if}
        </span>
      {/each}
    </div>

    <div class="flex-1 overflow-auto min-h-0">
      {#each payload.passages as p (p.index)}
        <section class="border-b border-border/60">
          <header class="px-4 py-1.5 bg-surface-alt/40 flex items-center gap-2 sticky top-0">
            <span class="text-xs font-mono tabular-nums text-on-surface-secondary">
              {passageLabel(p.start, p.end, p.raw_locations)}
            </span>
            <span class="text-[11px] text-on-surface-muted">
              {p.clusters.length} claim{p.clusters.length === 1 ? "" : "s"}
            </span>
          </header>

          <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-4 px-4 py-3">
            <!-- Source side: the verbatim spans the models cited. -->
            <div class="text-sm text-on-surface-secondary space-y-1.5 min-w-0">
              {#each passageQuotes(p.clusters) as q}
                <p class="border-l-2 border-border pl-2 leading-snug">{q}</p>
              {:else}
                <p class="text-on-surface-muted/60 italic">no source quote</p>
              {/each}
            </div>

            <!-- Cluster side: one row per fact, its variants and phrasings. -->
            <div class="space-y-2 min-w-0">
              {#each p.clusters as c (c.id)}
                <div
                  class="rounded border px-2.5 py-1.5
                    {c.singleton
                      ? 'border-warning/50 bg-warning-container/15'
                      : 'border-border bg-surface-alt/30'}"
                >
                  <div class="flex items-start gap-2">
                    <!-- Which variants produced this fact. -->
                    <span class="flex-none flex items-center gap-1 pt-0.5">
                      {#each c.variants as vid}
                        <span
                          class="w-2 h-2 rounded-full"
                          style="background:{colourOf.get(vid)}"
                          title={modelOf.get(vid)}
                        ></span>
                      {/each}
                    </span>
                    <div class="min-w-0 flex-1">
                      {#each phrasings(c) as ph}
                        <p class="text-sm text-on-surface leading-snug">
                          {ph.text}
                          {#if !c.singleton && ph.variants.length < c.variants.length}
                            <span class="text-[10px] text-on-surface-muted">
                              ({ph.variants.map((v) => modelOf.get(v)).join(", ")})
                            </span>
                          {/if}
                        </p>
                      {/each}
                    </div>
                    {#if c.singleton}
                      <span
                        class="flex-none text-[10px] font-medium text-on-warning-container bg-warning-container/60 rounded px-1.5 py-0.5"
                        title="Only one variant produced this - unique recall or a hallucination"
                      >
                        only {modelOf.get(c.variants[0])}
                      </span>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          </div>
        </section>
      {/each}
    </div>
  {/if}
</div>
