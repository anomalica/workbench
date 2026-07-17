<script lang="ts">
  // Auditing a record's extraction variants: walk the source chunk by chunk and,
  // for each chunk, see what EVERY model made of it side by side.
  //
  // The shape is deliberate, twice over.
  //
  // Per fact, EVERY model gets a line - including an explicit "nothing" where it
  // found nothing. The original rendered a fact once with an "only haiku" badge,
  // which made every judgement relative: to read it you had to hold the other
  // models in your head and infer their silence from an absence. Here what each
  // model said, and who said nothing, is on the fact's face.
  //
  // And the models stack VERTICALLY, not as columns. Columns encode an assumption
  // that there are two or three models; there will be twenty. A column per model
  // dies at that width, a stack just gets taller - and the eye compares adjacent
  // lines more easily than adjacent columns anyway.
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

  /** Models the reviewer has switched off. With twenty models you narrow to the
   *  few you're weighing; the default shows all, because a model hidden by
   *  default is a model silently excluded from a comparison. */
  let hidden = $state<Set<string>>(new Set());
  function toggleModel(id: string) {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    // Never allow the last model to be switched off - an empty grid isn't a
    // filter, it's a broken page.
    if (next.size >= allVariants.length) return;
    hidden = next;
  }

  // When the passage axis is confounded the singleton flag is an artefact of
  // location formatting, not a fact about the models - so the view says so and
  // adjudication is DISABLED. Reading a degraded view is fine; recording gold
  // against it is not, because nothing downstream will remember the clusters
  // were manufactured when a grader later scores against them.
  let confounded = $derived(payload?.axis?.confounded === true);
  let confoundReason = $derived(payload?.axis?.reason ?? "");

  let allVariants = $derived(payload?.variants ?? []);
  let variants = $derived(allVariants.filter((v) => !hidden.has(v.id)));
  // Is this a like-for-like comparison? Only if every variant ran the SAME
  // prompt. An unknown ("") fingerprint counts as not-verified, never as a
  // match: a prompt difference read as a model difference is the one wrong
  // conclusion this view can produce.
  let promptFingerprints = $derived([...new Set(variants.map((v) => v.prompt_fingerprint))]);
  let mixedPrompts = $derived(
    variants.length > 1 && (promptFingerprints.length > 1 || promptFingerprints[0] === ""),
  );
  /** Longest model name, so the per-line labels form a readable gutter without a
   *  fixed width that truncates at 20 models with long names. */
  let labelCh = $derived(Math.min(14, Math.max(6, ...variants.map((v) => v.model.length), 6)));

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

  /** Can this passage's clusters be graded? Only if the models were actually
   *  compared here. A passage holding ONE model emits singletons by
   *  construction, so its "only X found this" flags are artefacts even when the
   *  record as a whole passes - the DoD record has exactly that shape, and both
   *  of its lone-passage singletons were shown to be false (the same facts exist
   *  in the other model's claims under a different location label). */
  function gradable(p: AuditPassage): boolean {
    return !confounded && p.compared !== false;
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
        {variants.length}{hidden.size ? `/${allVariants.length}` : ""} models · {payload.passages.length} chunks
      </span>
      {#if confounded}
        <span
          class="inline-flex items-center gap-1 text-[11px] font-medium text-on-error bg-error/80 rounded px-2 py-0.5"
          title={confoundReason}
        >
          Cannot compare these models - grading disabled
        </span>
      {/if}
      {#if mixedPrompts}
        <span
          class="inline-flex items-center gap-1 text-[11px] font-medium text-on-error bg-error/80 rounded px-2 py-0.5"
          title={promptFingerprints.includes("")
            ? "At least one variant does not record which prompt it ran, so this cannot be verified as like-for-like."
            : `These variants ran DIFFERENT prompts (${promptFingerprints.join(" vs ")}). A gap between them is a prompt difference as much as a model difference - do not read it as a model comparison.`}
        >
          NOT like-for-like: prompts differ
        </span>
      {/if}
      {#each allVariants as v (v.id)}
        {@const off = hidden.has(v.id)}
        <button
          onclick={() => toggleModel(v.id)}
          class="inline-flex items-center gap-1.5 text-xs rounded px-1.5 py-0.5 cursor-pointer transition-colors
            {off ? 'opacity-40 hover:opacity-70' : 'hover:bg-surface'}"
          title={off ? `Show ${v.model}` : `Hide ${v.model}`}
        >
          <span
            class="w-2.5 h-2.5 rounded-full flex-none {off ? 'ring-1 ring-inset ring-on-surface-muted' : ''}"
            style={off ? "" : `background:${colourOf.get(v.id)}`}
          ></span>
          <span class="font-medium {off ? 'text-on-surface-muted line-through' : 'text-on-surface'}">{v.model}</span>
          <span class="text-on-surface-muted tabular-nums">{v.claim_count} claims</span>
          {#if v.cost_usd != null}
            <span class="text-on-surface-muted tabular-nums">${v.cost_usd.toFixed(2)}</span>
          {/if}
          {#if mixedPrompts}
            <span
              class="font-mono text-[10px] text-on-surface-muted/80"
              title="Prompt fingerprint - the prompts this variant actually ran"
            >{v.prompt_fingerprint || "prompt unknown"}</span>
          {/if}
        </button>
      {/each}
    </div>

    {#if confounded}
      <div class="flex-none px-4 py-2.5 bg-error/10 border-b border-error/30">
        <p class="text-xs text-on-surface max-w-4xl leading-relaxed">
          <span class="font-semibold">These models were never actually compared.</span>
          {confoundReason} Every claim below will look unique to one model - that is
          an artefact of how each model writes its locations, not a difference between
          them. Grading is disabled here: a verdict recorded against these clusters
          would be a verdict on a formatting accident.
        </p>
      </div>
    {/if}

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

          {#if rows.length === 0}
            <div class="px-4 py-3">
              <p class="text-xs italic text-on-surface-muted/60">
                No model produced a claim from this chunk.
              </p>
            </div>
          {/if}

          <!-- One block per fact. Inside it, EVERY model gets a line - including
               an explicit "nothing". Stacked, not columned: twenty models make a
               taller list, where twenty columns make an unreadable one. -->
          {#if p.compared === false && !confounded}
            <div class="px-4 py-1.5 bg-warning-container/20 border-b border-warning/30">
              <p class="text-[11px] text-on-surface leading-relaxed max-w-4xl">
                Only one model filed claims at this location, so nothing here was
                compared. These are not unique findings - another model may have
                reported the same facts under a different location label. Grading is
                off for this chunk.
              </p>
            </div>
          {/if}
          {#each rows as row (row.cluster.id)}
            {@const quotes = passageQuotes([row.cluster])}
            {@const canGrade = gradable(p)}
            <article class="px-4 py-3 border-b border-border/50 {row.singleton && canGrade ? 'bg-warning-container/10' : ''}">
              <!-- The source span this fact was drawn from, and the verdict on
                   the FACT (not on any one model's wording of it). -->
              <div class="flex flex-wrap items-start gap-x-3 gap-y-1.5">
                <div class="min-w-0 flex-1">
                  {#each quotes as q}
                    <p class="text-sm text-on-surface-secondary border-l-2 border-primary/40 pl-2 leading-snug">{q}</p>
                  {:else}
                    <p class="text-xs italic text-on-surface-muted/60">no source quote</p>
                  {/each}
                </div>
                <div class="flex flex-none items-center gap-1">
                  {#each CLUSTER_VERDICTS as v}
                    <button
                      onclick={() => saveGold(row.cluster, p, v)}
                      disabled={!canGrade}
                      class="text-[11px] font-medium rounded px-1.5 py-0.5 transition-colors
                        {!canGrade
                          ? 'text-on-surface-muted/40 cursor-not-allowed'
                          : row.cluster.gold?.verdict === v
                            ? v === 'real'
                              ? 'bg-success text-on-success cursor-pointer'
                              : 'bg-error text-on-error cursor-pointer'
                            : 'text-on-surface-muted hover:bg-surface-alt cursor-pointer'}"
                      title={!canGrade
                        ? "Grading is off here: the models were not compared at this location, so this cluster is an artefact"
                        : `Mark this claim ${CLUSTER_LABEL[v]}`}
                    >
                      {CLUSTER_LABEL[v]}
                    </button>
                  {/each}
                </div>
              </div>

              <!-- Each model's rendering of this fact, one line each. -->
              <div class="mt-2 space-y-1">
                {#each row.cells as cell (cell.variant)}
                  <div class="flex items-start gap-2">
                    <span
                      class="flex-none flex items-center gap-1.5 pt-0.5"
                      style="width: {labelCh + 2}ch"
                      title={cell.present ? cell.model : `${cell.model} produced no claim for this fact`}
                    >
                      <span class="w-1.5 h-1.5 rounded-full flex-none" style="background:{colourOf.get(cell.variant)}"></span>
                      <span class="text-[11px] tabular-nums truncate
                        {cell.present ? 'text-on-surface-secondary' : 'text-on-surface-muted/50'}">{cell.model}</span>
                    </span>
                    {#if !cell.present}
                      <span class="text-xs italic text-on-surface-muted/50 pt-0.5">nothing</span>
                    {:else}
                      <div class="min-w-0 flex-1 space-y-1">
                        {#each memberLines(cell.members) as line}
                          {@const label = frameLabel(line)}
                          <div>
                            <p class="text-sm text-on-surface leading-snug">{line.text}</p>
                            {#if label}
                              <p class="text-[10px] font-mono text-on-surface-muted/70 leading-tight">{label}</p>
                            {/if}
                          </div>
                        {/each}
                        {#if row.cluster.gold?.verdict === "real" && canGrade}
                          {#each cell.members as m (m.claim_id)}
                            <div class="flex flex-wrap items-center gap-1">
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
            </article>
          {/each}
        </section>
      {/each}
    </div>
  {/if}
</div>
