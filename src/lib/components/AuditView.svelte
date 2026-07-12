<script lang="ts">
  // Model/digest audit view: compare a record's extraction variants against each
  // other, walking the record passage by passage. Per passage, the source on one
  // side and the claims clustered by meaning on the other - each cluster showing
  // which variants produced it and their phrasings, singletons (one variant only)
  // flagged as unique recall or hallucination. Read-only for now; per-cluster
  // adjudication is the next layer.
  import {
    fetchAudit,
    putAuditVerdict,
    type AuditPayload,
    type AuditPassage,
    type AuditCluster,
    type AuditMember,
    type AuditGold,
  } from "$lib/api";

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

  // Cluster members grouped by (wording + epistemic frame): variants that
  // captured the fact identically collapse to one row; a variant that flattened
  // it (dropped the attestation or a source ref) splits onto its own row, so the
  // difference the gold exists to catch is visible at a glance.
  interface MemberRow {
    text: string;
    claim_type: string;
    attestation: string;
    refs: string[];
    variants: string[];
  }
  function memberRows(c: AuditCluster): MemberRow[] {
    const by = new Map<string, MemberRow>();
    for (const m of c.members) {
      const key = `${m.text}|${m.claim_type}|${m.attestation}|${m.refs.join(",")}`;
      const row = by.get(key);
      if (row) row.variants.push(m.variant);
      else
        by.set(key, {
          text: m.text,
          claim_type: m.claim_type,
          attestation: m.attestation,
          refs: m.refs,
          variants: [m.variant],
        });
    }
    return [...by.values()];
  }

  // A compact epistemic frame label: type · attestation · refs. Empty parts drop.
  function frameLabel(r: MemberRow): string {
    const parts = [r.claim_type, r.attestation].filter(Boolean);
    if (r.refs.length) parts.push(`refs: ${r.refs.join(", ")}`);
    return parts.join(" · ");
  }

  // --- adjudication (the gold): mark each cluster real/hallucinated/not-asserted;
  // for a `real` cluster, mark each member correct or how it went wrong. Persisted
  // to {hash}.audit.json; the digester's grader scores variants against it. ---
  const CLUSTER_VERDICTS = ["real", "hallucinated", "not_asserted"] as const;
  const CLUSTER_LABEL: Record<string, string> = {
    real: "Real",
    hallucinated: "Hallucinated",
    not_asserted: "Not asserted",
  };
  const MEMBER_VERDICTS = ["correct", "flattened", "misattributed", "overhedged"] as const;
  const MEMBER_LABEL: Record<string, string> = {
    correct: "correct",
    flattened: "flattened",
    misattributed: "mis-attributed",
    overhedged: "over-hedged",
  };

  let recordHash = $derived(payload?.record.hash ?? "");

  function memberVerdictOf(c: AuditCluster, m: AuditMember): string {
    return (
      c.gold?.members?.find((g) => g.variant === m.variant && g.claim_id === m.claim_id)?.verdict ??
      "correct"
    );
  }

  // Build + persist the adjudication for a cluster, carrying existing member
  // verdicts. `memberOverride` sets one member's verdict (for the per-member
  // controls); a bare verdict change keeps the members as they were.
  async function saveGold(
    c: AuditCluster,
    p: AuditPassage,
    verdict: string,
    memberOverride?: { member: AuditMember; verdict: string },
  ) {
    const members = c.members.map((m) => ({
      variant: m.variant,
      claim_id: m.claim_id,
      verdict:
        memberOverride && memberOverride.member.variant === m.variant &&
        memberOverride.member.claim_id === m.claim_id
          ? memberOverride.verdict
          : memberVerdictOf(c, m),
    }));
    const gold: AuditGold = {
      gold_id: c.gold?.gold_id,
      verdict,
      location: p.raw_locations[0] ?? "",
      text: c.members[0]?.text ?? "",
      members,
    };
    try {
      const { gold_id } = await putAuditVerdict(recordHash, gold);
      c.gold = { ...gold, gold_id };
      payload = payload; // nested mutation -> reassign to refresh
    } catch {
      /* leave the UI unchanged on failure */
    }
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
                    <div class="min-w-0 flex-1 space-y-1">
                      {#each memberRows(c) as row}
                        {@const label = frameLabel(row)}
                        <div>
                          <p class="text-sm text-on-surface leading-snug">
                            {row.text}
                            {#if memberRows(c).length > 1}
                              <span class="text-[10px] text-on-surface-muted">
                                ({row.variants.map((v) => modelOf.get(v)).join(", ")})
                              </span>
                            {/if}
                          </p>
                          {#if label}
                            <p class="text-[10px] font-mono text-on-surface-muted/80 leading-tight">
                              {label}
                            </p>
                          {/if}
                        </div>
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

                  <!-- Adjudication: mark the cluster, and (when real) each member. -->
                  <div class="mt-1.5 pt-1.5 border-t border-border/40 flex flex-wrap items-center gap-1">
                    {#each CLUSTER_VERDICTS as v}
                      <button
                        onclick={() => saveGold(c, p, v)}
                        class="text-[11px] font-medium rounded px-1.5 py-0.5 cursor-pointer transition-colors
                          {c.gold?.verdict === v
                            ? v === 'real'
                              ? 'bg-success text-on-success'
                              : 'bg-error text-on-error'
                            : 'text-on-surface-muted hover:bg-surface-alt'}"
                        title="Mark this claim {CLUSTER_LABEL[v]}"
                      >
                        {CLUSTER_LABEL[v]}
                      </button>
                    {/each}
                    {#if c.gold && c.gold.verdict !== "real" && !c.singleton}
                      <span class="text-[10px] text-on-surface-muted/70 ml-1">both variants marked</span>
                    {/if}
                  </div>

                  {#if c.gold?.verdict === "real" && c.members.length > 1}
                    <!-- Per member: did it get the framing right, or flatten it? -->
                    <div class="mt-1 space-y-0.5">
                      {#each c.members as m (m.variant + m.claim_id)}
                        <div class="flex items-center gap-1 text-[10px]">
                          <span class="w-2 h-2 rounded-full flex-none" style="background:{colourOf.get(m.variant)}"></span>
                          <span class="text-on-surface-muted w-14 flex-none truncate">{modelOf.get(m.variant)}</span>
                          {#each MEMBER_VERDICTS as mv}
                            <button
                              onclick={() => saveGold(c, p, "real", { member: m, verdict: mv })}
                              class="rounded px-1 py-0.5 cursor-pointer transition-colors
                                {memberVerdictOf(c, m) === mv
                                  ? mv === 'correct'
                                    ? 'bg-success/80 text-on-success'
                                    : 'bg-warning text-on-warning'
                                  : 'text-on-surface-muted/70 hover:bg-surface-alt'}"
                            >
                              {MEMBER_LABEL[mv]}
                            </button>
                          {/each}
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        </section>
      {/each}
    </div>
  {/if}
</div>
