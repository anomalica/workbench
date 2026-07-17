<script lang="ts">
  // Auditing a record's extraction variants: walk the source chunk by chunk and,
  // for each chunk, see what EVERY model made of it side by side.
  //
  // The shape is deliberate. Source on the left, one COLUMN PER MODEL on the
  // right, one row per distinct fact, and a cell for every model in every row -
  // including an explicit "nothing" where a model found nothing. The previous
  // clustered shape rendered a fact once with an "only haiku" badge, which made
  // every judgement relative: to read one row you had to hold the other models
  // in your head and infer their silence from an absence. Here a row is
  // standalone - what each model said, and who said nothing, is on its face.
  import {
    fetchAudit,
    putAuditVerdict,
    type AuditPayload,
    type AuditPassage,
    type AuditCluster,
    type AuditMember,
    type AuditGold,
  } from "$lib/api";
  import {
    auditGrid,
    passageQuotes,
    passageTally,
    memberLines,
    frameLabel,
    type AuditGridRow,
  } from "$lib/audit-grid";

  let { hash }: { hash: string } = $props();

  let status = $state<"loading" | "ready" | "empty" | "error">("loading");
  let payload = $state<AuditPayload | null>(null);

  // Colour per model, by its order in the record - the column header, the tally
  // and any per-cell marker all read the same colour.
  const PALETTE = ["#0ea5e9", "#f59e0b", "#8b5cf6", "#ec4899", "#22c55e", "#ef4444"];
  let colourOf = $derived.by(() => {
    const m = new Map<string, string>();
    (payload?.variants ?? []).forEach((v, i) => m.set(v.id, PALETTE[i % PALETTE.length]));
    return m;
  });

  let variants = $derived(payload?.variants ?? []);
  // The grid's column template: the source chunk, then one equal column per model.
  let columns = $derived(`minmax(0,1fr) ${variants.map(() => "minmax(0,1fr)").join(" ")}`);

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

  // --- adjudication (the gold): mark each fact real/hallucinated/not-asserted;
  // for a `real` fact, mark each model's rendering correct or how it went wrong.
  // Persisted to {hash}.audit.json; the digester's grader scores variants on it.
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

  function rowsOf(p: AuditPassage): AuditGridRow[] {
    return auditGrid(p, variants);
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
    <!-- Variant summary: model, claim count, cost - colour-keyed to the columns. -->
    <div class="flex-none px-4 py-3 border-b border-border bg-surface-alt flex flex-wrap items-center gap-x-4 gap-y-2">
      <span class="text-xs font-medium text-on-surface-secondary">
        {payload.variants.length} models · {payload.passages.length} chunks
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
        {@const rows = rowsOf(p)}
        {@const tally = passageTally(p, variants)}
        <section class="border-b-4 border-border/60">
          <!-- Chunk header: where in the source, and what each model found HERE
               (an explicit 0 included - "found nothing here" is a finding). -->
          <header class="px-4 py-2 bg-surface-alt/60 flex flex-wrap items-center gap-x-3 gap-y-1 sticky top-0 z-10 border-b border-border">
            <span class="text-xs font-mono tabular-nums font-medium text-on-surface-secondary">
              {passageLabel(p.start, p.end, p.raw_locations)}
            </span>
            <span class="text-[11px] text-on-surface-muted">
              {rows.length} claim{rows.length === 1 ? "" : "s"} in this chunk
            </span>
            <span class="flex-1"></span>
            {#each tally as t (t.variant)}
              <span
                class="inline-flex items-center gap-1 text-[11px] tabular-nums
                  {t.count === 0 ? 'text-on-surface-muted/60' : 'text-on-surface-secondary'}"
                title={t.count === 0
                  ? `${t.model} found nothing in this chunk`
                  : `${t.model} produced ${t.count} claim${t.count === 1 ? "" : "s"} here`}
              >
                <span class="w-1.5 h-1.5 rounded-full flex-none" style="background:{colourOf.get(t.variant)}"></span>
                {t.model} {t.count}
              </span>
            {/each}
          </header>

          <!-- Column headers: SOURCE, then one per model. -->
          <div class="grid gap-px bg-border/40 border-b border-border" style="grid-template-columns: {columns}">
            <div class="bg-surface-alt/40 px-3 py-1">
              <span class="text-[10px] font-semibold uppercase tracking-wide text-on-surface-muted">Source</span>
            </div>
            {#each variants as v (v.id)}
              <div class="bg-surface-alt/40 px-3 py-1 flex items-center gap-1.5">
                <span class="w-2 h-2 rounded-full flex-none" style="background:{colourOf.get(v.id)}"></span>
                <span class="text-[10px] font-semibold uppercase tracking-wide text-on-surface-secondary">{v.model}</span>
              </div>
            {/each}
          </div>

          {#if rows.length === 0}
            <div class="grid gap-px bg-border/40" style="grid-template-columns: {columns}">
              <div class="bg-surface px-3 py-3 text-sm text-on-surface-secondary space-y-1.5">
                {#each passageQuotes(p.clusters) as q}
                  <p class="border-l-2 border-border pl-2 leading-snug">{q}</p>
                {:else}
                  <p class="text-on-surface-muted/60 italic text-xs">no source quote</p>
                {/each}
              </div>
              {#each variants as v (v.id)}
                <div class="bg-surface px-3 py-3">
                  <p class="text-xs italic text-on-surface-muted/60">nothing</p>
                </div>
              {/each}
            </div>
          {/if}

          <!-- One row per fact. Every model has a cell; an empty one SAYS so. -->
          {#each rows as row (row.cluster.id)}
            <div
              class="grid gap-px bg-border/40 {row.singleton ? 'ring-1 ring-inset ring-warning/40' : ''}"
              style="grid-template-columns: {columns}"
            >
              <!-- Source: the span this fact was drawn from. -->
              <div class="bg-surface px-3 py-2.5 min-w-0">
                {#if row.cluster.members.length}
                  {@const quotes = passageQuotes([row.cluster])}
                  {#each quotes as q}
                    <p class="text-sm text-on-surface-secondary border-l-2 border-border pl-2 leading-snug">{q}</p>
                  {:else}
                    <p class="text-xs italic text-on-surface-muted/60">no source quote</p>
                  {/each}
                {:else}
                  <p class="text-xs italic text-on-surface-muted/60">no source quote</p>
                {/if}

                <!-- Adjudication sits with the source, since it judges the FACT,
                     not any one model's wording of it. -->
                <div class="mt-2 flex flex-wrap items-center gap-1">
                  {#each CLUSTER_VERDICTS as v}
                    <button
                      onclick={() => saveGold(row.cluster, p, v)}
                      class="text-[11px] font-medium rounded px-1.5 py-0.5 cursor-pointer transition-colors
                        {row.cluster.gold?.verdict === v
                          ? v === 'real'
                            ? 'bg-success text-on-success'
                            : 'bg-error text-on-error'
                          : 'text-on-surface-muted hover:bg-surface-alt'}"
                      title="Mark this claim {CLUSTER_LABEL[v]}"
                    >
                      {CLUSTER_LABEL[v]}
                    </button>
                  {/each}
                </div>
              </div>

              <!-- One cell per model: its rendering, or an explicit nothing. -->
              {#each row.cells as cell (cell.variant)}
                <div class="bg-surface px-3 py-2.5 min-w-0">
                  {#if !cell.present}
                    <p
                      class="text-xs italic text-on-surface-muted/60"
                      title="{cell.model} produced no claim for this fact"
                    >
                      nothing
                    </p>
                  {:else}
                    <div class="space-y-1.5">
                      {#each memberLines(cell.members) as line}
                        {@const label = frameLabel(line)}
                        <div>
                          <p class="text-sm text-on-surface leading-snug">{line.text}</p>
                          {#if label}
                            <p class="text-[10px] font-mono text-on-surface-muted/80 leading-tight">{label}</p>
                          {/if}
                        </div>
                      {/each}

                      <!-- When the fact is real, grade THIS model's rendering. -->
                      {#if row.cluster.gold?.verdict === "real"}
                        {#each cell.members as m (m.claim_id)}
                          <div class="flex flex-wrap items-center gap-1 pt-0.5">
                            {#each MEMBER_VERDICTS as mv}
                              <button
                                onclick={() => saveGold(row.cluster, p, "real", { member: m, verdict: mv })}
                                class="text-[10px] rounded px-1 py-0.5 cursor-pointer transition-colors
                                  {memberVerdictOf(row.cluster, m) === mv
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
                      {/if}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/each}
        </section>
      {/each}
    </div>
  {/if}
</div>
