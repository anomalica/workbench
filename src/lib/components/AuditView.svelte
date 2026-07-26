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
    AuditAccessError,
    fetchAudit,
    putAuditClaim,
    type AuditPayload,
    type AuditPassage,
    type AuditCluster,
    type AuditMember,
    type AuditClaimGold,
  } from "$lib/api";
  import { variantLabels } from "$lib/variant-label";
  import {
    visibleRows,
    passageHasContent,
    passageQuotes,
    passageTally,
    memberLines,
    frameLabel,
    type AuditGridRow,
  } from "$lib/audit-grid";

  let {
    hash,
    onquote,
    focus = [],
  }: {
    hash: string;
    /** Claim keys (`variant\u0000claim_id`) the source pane asked to show -
     *  the reverse link: click a stretch of source, land on what the models
     *  made of it. */
    focus?: string[];
    /** Ask the source pane to show where this claim came from. `scroll` is
     *  false on hover - a preview should not move the reader's place - and true
     *  on click. Absent when there is no source pane beside us. */
    onquote?: (quote: string, label: string, scroll?: boolean) => void;
  } = $props();

  let status = $state<"loading" | "ready" | "empty" | "error" | "forbidden">("loading");
  /** Which refusal, so the message names the actual obstacle. */
  let forbiddenReason = $state("");
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
  // Two variants of ONE model (jon-stewart has two opus digests at different
  // prompts) both rendered as "opus" - two rows with the same name, one of them
  // silent, and no way to tell which was which or which to switch off. The
  // label carries the prompt fingerprint only where the model name repeats.
  let labels = $derived(variantLabels(allVariants));
  function labelOf(id: string, fallback: string): string {
    return labels.get(id) ?? fallback;
  }
  /** Longest label, so the per-line names form a readable gutter without a
   *  fixed width that truncates at 20 models with long names. */
  let labelCh = $derived(
    Math.min(22, Math.max(6, ...variants.map((v) => labelOf(v.id, v.model).length), 6)),
  );

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
      .catch((e) => {
        if (h !== hash) return;
        // A refusal is not a failure. Rendering "could not load" for a
        // permission error sends the reader hunting a bug that isn't there.
        if (e instanceof AuditAccessError) {
          status = "forbidden";
          forbiddenReason = e.status === 403 ? "reviewer" : "login";
        } else {
          status = "error";
        }
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

  // --- adjudication, anomalica/audit/2: ONE question per model claim -
  // quality (bad/okay/good) - plus the orthogonal irrelevant mark. The eval
  // catches fabrication and quote-mining deterministically, so clicks buy only
  // what a machine can't judge: "bad" INCLUDES unsupported-or-misrepresents-
  // the-source (the semantic axis), and irrelevant is the noise metric, kept
  // separate so a perfectly-written claim about nothing stays visible as such.
  // Keyboard-first: hover a claim, press 1/2/3 for bad/okay/good, x for
  // irrelevant. Adjudication is per model AND prompt - the models word the same
  // fact differently every time, so grading one credits nothing to another.
  const QUALITY = ["bad", "okay", "good"] as const;
  const QUALITY_HELP: Record<string, string> = {
    bad: "Unsupported by, or misrepresents, the source - or badly made (key 1)",
    okay: "Serviceable extraction (key 2)",
    good: "Faithful and well made (key 3)",
  };

  let recordHash = $derived(payload?.record.hash ?? "");
  /** Surfaced when a grade fails to persist - never swallowed. */
  let saveError = $state<string | null>(null);

  // The reviewer's verdicts, held as their OWN top-level state rather than as a
  // field mutated inside the fetched payload. Writing back into
  // `payload.gold.claims` did save on the server and did nothing on screen: the
  // chip kept its unset styling until a reload, so a grade looked like it had
  // been ignored. Keeping the list here makes the update a plain reassignment,
  // which is unambiguously reactive.
  let goldClaims = $state<AuditClaimGold[]>([]);
  $effect(() => {
    goldClaims = payload?.gold?.claims ?? [];
  });
  let goldByKey = $derived.by(() => {
    const m = new Map<string, AuditClaimGold>();
    for (const g of goldClaims) m.set(`${g.variant}\u0000${g.claim_id}`, g);
    return m;
  });
  let focusSet = $derived(new Set(focus));
  function isFocused(m: AuditMember): boolean {
    return focusSet.has(`${m.variant}\u0000${m.claim_id}`);
  }
  // Scroll to the first focused claim when the source pane hands us a new set.
  $effect(() => {
    if (!focus.length) return;
    requestAnimationFrame(() => {
      document
        .querySelector(".claim-focused")
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  });

  function goldOf(m: AuditMember): AuditClaimGold | undefined {
    return goldByKey.get(`${m.variant}\u0000${m.claim_id}`);
  }

  async function saveClaim(
    m: AuditMember,
    p: AuditPassage,
    change: { quality?: "bad" | "okay" | "good"; irrelevant?: boolean },
  ) {
    const prev = goldOf(m);
    const entry: AuditClaimGold = {
      ...(prev?.gold_id ? { gold_id: prev.gold_id } : {}),
      variant: m.variant,
      model: m.model,
      prompt_sha: m.variant.includes(".") ? m.variant.split(".")[1] : "",
      claim_id: m.claim_id,
      location: m.location || (p.raw_locations[0] ?? ""),
      text: m.text,
      quote: m.quote ?? "",
      claim_type: m.claim_type ?? "",
      ...(change.quality !== undefined
        ? { quality: change.quality }
        : prev?.quality
          ? { quality: prev.quality }
          : {}),
      ...(change.irrelevant !== undefined
        ? { irrelevant: change.irrelevant }
        : prev?.irrelevant
          ? { irrelevant: true }
          : {}),
      // The digest-shaped claim, for the server-side fingerprint (the digester's
      // fingerprint_of_claim maps these keys itself). audit_load renamed
      // type -> claim_type on the way in; this undoes exactly that one rename.
      claim: {
        text: m.text,
        type: m.claim_type,
        quote: m.quote,
        location: m.location,
      },
    };
    try {
      const { gold_id } = await putAuditClaim(recordHash, entry);
      const stored = { ...entry, gold_id };
      delete stored.claim;
      goldClaims = [
        ...goldClaims.filter((g) => !(g.variant === m.variant && g.claim_id === m.claim_id)),
        stored,
      ];
    } catch (e) {
      // A grade that silently fails to save is worse than one that errors: the
      // reviewer moves on believing the record was made, and the gold quietly
      // does not contain it.
      saveError = e instanceof Error ? e.message : String(e);
      setTimeout(() => (saveError = null), 6000);
    }
  }

  // Keyboard grading: the claim under the cursor takes 1/2/3/x.
  let hoveredMember: { m: AuditMember; p: AuditPassage } | null = null;
  function onKeydown(e: KeyboardEvent) {
    if (!hoveredMember || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    const { m, p } = hoveredMember;
    if (!gradable(p)) return;
    if (e.key === "1") saveClaim(m, p, { quality: "bad" });
    else if (e.key === "2") saveClaim(m, p, { quality: "okay" });
    else if (e.key === "3") saveClaim(m, p, { quality: "good" });
    else if (e.key === "x" || e.key === "X")
      saveClaim(m, p, { irrelevant: !goldOf(m)?.irrelevant });
    else return;
    e.preventDefault();
  }

  function rowsOf(p: AuditPassage): AuditGridRow[] {
    return visibleRows(p, variants);
  }

  // Chunks where NOT ONE selected model produced a claim are dead weight to
  // scroll past - so they collapse to a single line by default. A chunk where
  // only SOME models are silent is never hidden: that silence is the missed-fact
  // signal (see visibleRows). The hidden ones stay reachable, and their count is
  // always on screen, because a view that silently drops source is a view that
  // can hide a model's total failure on a passage.
  let shownPassages = $derived(
    (payload?.passages ?? []).filter((p) => passageHasContent(p, variants)),
  );
  let emptyPassageCount = $derived((payload?.passages ?? []).length - shownPassages.length);
  let showEmptyPassages = $state(false);
  let listedPassages = $derived(showEmptyPassages ? (payload?.passages ?? []) : shownPassages);

  // --- entities (Pass A) ------------------------------------------------------
  // The other half of the two-pass output. Which entities a model found is a
  // recall signal in its own right, and it was invisible until now.
  //
  // A TAB, not an expanding panel. Squeezed above the claims it was a wall of
  // chips with no room to breathe, and it pushed the claims off screen while
  // reading neither as a list nor as a comparison.
  let tab = $state<"claims" | "entities">("claims");
  let showNodes = $derived(tab === "entities");
  /** Detail of how the variants actually differ - "prompts differ" is not
   *  actionable until you can see WHICH prompt. */
  let showVariantDetail = $state(false);
  let nodeRows = $derived(
    (payload?.nodes ?? []).filter((n) => n.found_by.some((v) => !hidden.has(v))),
  );
  let nodeTypes = $derived([...new Set(nodeRows.map((n) => n.type))].sort());
  let sharedNodeCount = $derived(
    nodeRows.filter((n) => n.found_by.filter((v) => !hidden.has(v)).length > 1).length,
  );

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

<svelte:window onkeydown={onKeydown} />

<div class="flex-1 flex flex-col min-h-0 font-ui bg-surface">
  {#if status === "loading"}
    <p class="p-6 text-sm text-on-surface-muted">Loading audit…</p>
  {:else if status === "empty"}
    <p class="p-6 text-sm text-on-surface-muted">
      No extraction variants for this record yet. The audit compares several model
      digests of one record; it appears once more than one has been produced.
    </p>
  {:else if status === "forbidden"}
    <div class="p-6 max-w-2xl">
      <p class="text-sm text-on-surface font-medium">
        {forbiddenReason === "reviewer"
          ? "You don't have reviewer access."
          : "You need to be logged in."}
      </p>
      <p class="text-xs text-on-surface-secondary mt-1.5 leading-relaxed">
        {forbiddenReason === "reviewer"
          ? "The audit compares model extractions and records grading against them, so it's limited to reviewers. Your account has a lower role - ask an admin to grant reviewer in the roles file. Nothing is wrong with this record."
          : "Sign in to open the audit for this record."}
      </p>
    </div>
  {:else if status === "error"}
    <p class="p-6 text-sm text-error">Could not load the audit for this record.</p>
  {:else if payload}
    <!-- Variant summary: model, claim count, cost - colour-keyed to the columns. -->
    <div class="flex-none px-4 py-3 border-b border-border bg-surface-alt flex flex-wrap items-center gap-x-4 gap-y-2">
      <span class="text-xs font-medium text-on-surface-secondary">
        {variants.length}{hidden.size ? `/${allVariants.length}` : ""} models ·
        {shownPassages.length}{emptyPassageCount ? `/${payload.passages.length}` : ""} chunks
      </span>
      <span class="inline-flex rounded overflow-hidden border border-border">
        <button
          onclick={() => (tab = "claims")}
          class="text-xs px-2.5 py-1 cursor-pointer transition-colors
            {tab === 'claims' ? 'bg-primary text-on-primary font-medium' : 'text-on-surface-secondary hover:bg-surface'}"
          title="What each model CLAIMED, chunk by chunk"
        >Claims</button>
        <button
          onclick={() => (tab = "entities")}
          disabled={!payload.nodes?.length}
          class="text-xs px-2.5 py-1 transition-colors border-l border-border
            {tab === 'entities' ? 'bg-primary text-on-primary font-medium' : 'text-on-surface-secondary hover:bg-surface'}
            {payload.nodes?.length ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed'}"
          title="Which ENTITIES each model extracted - the other half of the two-pass output"
        >Entities{payload.nodes?.length ? ` (${nodeRows.length})` : ""}</button>
      </span>
      {#if payload.similarity?.degraded}
        <span
          class="inline-flex items-center gap-1 text-[11px] font-medium text-on-warning bg-warning/80 rounded px-2 py-0.5"
          title="The embedding service was unreachable, so claims were grouped by a crude word-overlap placeholder. Facts worded differently by different models will NOT have merged - expect false 'only one model found this' flags."
        >
          Approximate grouping - embeddings unavailable
        </span>
      {:else if payload.similarity?.method === "embedding"}
        <span
          class="text-[10px] font-mono text-on-surface-muted/70"
          title="Claims were grouped by meaning in this embedding space, at this cosine cut. A verdict is only reproducible against the space that produced its clusters."
        >
          {payload.similarity.model_id?.split(":")[0] ?? "embedding"} @ {payload.similarity.threshold}
        </span>
      {/if}
      {#if confounded}
        <span
          class="inline-flex items-center gap-1 text-[11px] font-medium text-on-error bg-error/80 rounded px-2 py-0.5"
          title={confoundReason}
        >
          Cannot compare these models - grading disabled
        </span>
      {/if}
      {#if mixedPrompts}
        <button
          onclick={() => (showVariantDetail = !showVariantDetail)}
          class="inline-flex items-center gap-1.5 text-[11px] rounded px-2 py-0.5 cursor-pointer transition-colors
            bg-warning-container/50 text-on-surface hover:bg-warning-container/70"
        >
          <span class="font-medium">Mixed prompts</span>
          <span class="text-on-surface-secondary">
            {promptFingerprints.includes("")
              ? "one run didn't record its prompt"
              : "these runs didn't all use the same instructions"}
          </span>
          <span class="text-primary underline">{showVariantDetail ? "hide" : "compare"}</span>
        </button>
      {/if}
      {#each allVariants as v (v.id)}
        {@const off = hidden.has(v.id)}
        <button
          onclick={() => toggleModel(v.id)}
          class="inline-flex items-center gap-1.5 text-xs rounded px-1.5 py-0.5 cursor-pointer transition-colors
            {off ? 'opacity-40 hover:opacity-70' : 'hover:bg-surface'}"
          title={off ? `Show ${labelOf(v.id, v.model)}` : `Hide ${labelOf(v.id, v.model)}`}
        >
          <span
            class="w-2.5 h-2.5 rounded-full flex-none {off ? 'ring-1 ring-inset ring-on-surface-muted' : ''}"
            style={off ? "" : `background:${colourOf.get(v.id)}`}
          ></span>
          <span class="font-medium {off ? 'text-on-surface-muted line-through' : 'text-on-surface'}">{labelOf(v.id, v.model)}</span>
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

    {#if saveError}
      <div class="flex-none px-4 py-2 bg-error/15 border-b border-error/40">
        <p class="text-xs text-on-surface">
          <span class="font-semibold">That rating did not save.</span> {saveError}
        </p>
      </div>
    {/if}

    {#if showVariantDetail}
      <!-- WHAT differs, not just THAT it differs. The version label lies: two
           variants can both say v3 and carry different prompt SHAs, which is
           exactly the jon-stewart case. -->
      <div class="flex-none px-4 py-3 bg-surface-alt/60 border-b border-border overflow-x-auto">
        <table class="text-[11px] font-mono border-collapse">
          <thead>
            <tr class="text-on-surface-muted">
              <th class="text-left pr-4 pb-1 font-medium">variant</th>
              <th class="text-left pr-4 pb-1 font-medium">run</th>
              {#each allVariants[0]?.prompts ?? [] as pr (pr.pass)}
                <th class="text-left pr-4 pb-1 font-medium">{pr.pass} prompt</th>
              {/each}
              <th class="text-right pr-4 pb-1 font-medium">claims</th>
              <th class="text-right pb-1 font-medium">entities</th>
            </tr>
          </thead>
          <tbody>
            {#each allVariants as v (v.id)}
              <tr class="text-on-surface">
                <td class="pr-4 py-0.5 whitespace-nowrap">
                  <span class="inline-block w-2 h-2 rounded-full mr-1.5" style="background:{colourOf.get(v.id)}"></span>
                  {labelOf(v.id, v.model)}
                </td>
                <td class="pr-4 py-0.5 whitespace-nowrap text-on-surface-secondary">{(v.extracted_at ?? "").slice(0, 10) || "—"}</td>
                {#each v.prompts ?? [] as pr (pr.pass)}
                  {@const differs = allVariants.some((o) => (o.prompts ?? []).some((q) => q.pass === pr.pass && q.sha !== pr.sha))}
                  <td class="pr-4 py-0.5 whitespace-nowrap {differs ? 'text-error font-semibold' : 'text-on-surface-muted'}">
                    {pr.version}·{pr.sha}{differs ? " ←" : ""}
                  </td>
                {/each}
                <td class="pr-4 py-0.5 text-right tabular-nums">{v.claim_count}</td>
                <td class="py-0.5 text-right tabular-nums">{v.node_count ?? "—"}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        <p class="text-[11px] text-on-surface-secondary mt-2 max-w-3xl leading-relaxed">
          Marked columns are where these runs differ. <span class="text-on-surface">Why it matters:</span>
          if two runs used different instructions, a gap between them is not evidence about the
          models - the one told to do more will find more. Compare like with like by switching off
          the odd run above, or read the difference as a prompt result rather than a model result.
          The version label alone will not tell you: two runs can both say v3 and carry different
          prompts, which is why the SHA is shown.
        </p>
      </div>
    {/if}

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

    {#if showNodes}
      <!-- Entities (Pass A). No source location, so this is a whole-record
           comparison, not a per-chunk one - which is why it is its own TAB
           rather than a strip crammed above the chunks. -->
      <div class="flex-1 min-h-0 overflow-auto px-4 py-3">
        <p class="text-[11px] text-on-surface-muted mb-2 max-w-4xl leading-relaxed">
          Entities each model extracted. {sharedNodeCount} of {nodeRows.length} were found by
          more than one selected model. Matched on name and type exactly - the same entity
          written two ways ("Stewart, Jon" / "Jon Stewart") shows as two rows rather than being
          silently merged into false agreement.
        </p>
        {#each nodeTypes as t (t)}
          {@const rows = nodeRows.filter((n) => n.type === t)}
          <section class="mb-5">
            <h3 class="text-[11px] uppercase tracking-wide text-on-surface-muted mb-1.5 pb-1 border-b border-border">
              {t || "untyped"} <span class="tabular-nums">({rows.length})</span>
            </h3>
            <!-- One entity per ROW, with a fixed gutter of model dots. Chips
                 wrapped inline made this a wall of text where nothing lined up;
                 a column of dots lets the eye scan straight down for the gaps,
                 which is the whole point of the comparison. -->
            <ul class="grid gap-x-6 gap-y-0.5" style="grid-template-columns: repeat(auto-fill, minmax(22rem, 1fr));">
              {#each rows as n (n.type + n.name)}
                {@const finders = n.found_by.filter((v) => !hidden.has(v))}
                <li class="flex items-baseline gap-2 py-0.5 border-b border-border/30">
                  <span class="flex-none flex gap-0.5 pt-0.5" style="width: {Math.max(allVariants.length, 2) * 0.5}rem">
                    {#each allVariants as v (v.id)}
                      {@const found = finders.includes(v.id)}
                      <span
                        class="w-1.5 h-1.5 rounded-full flex-none"
                        style={found
                          ? `background:${colourOf.get(v.id)}`
                          : "background:transparent;box-shadow:inset 0 0 0 1px var(--color-border,rgba(128,128,128,0.4))"}
                        title="{labelOf(v.id, v.model)} {found ? 'found' : 'did NOT find'} {n.name}"
                      ></span>
                    {/each}
                  </span>
                  <span class="text-xs {finders.length > 1 ? 'text-on-surface' : 'text-on-surface-secondary'} min-w-0 break-words">
                    {n.name}
                  </span>
                  {#if finders.length === 1}
                    <span class="ml-auto flex-none text-[10px] text-on-surface-muted/70 whitespace-nowrap">
                      only {labelOf(finders[0], finders[0])}
                    </span>
                  {/if}
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      </div>
    {/if}

    {#if emptyPassageCount > 0 && tab === "claims"}
      <div class="flex-none px-4 py-1.5 bg-surface-alt/40 border-b border-border flex items-center gap-2">
        <span class="text-[11px] text-on-surface-muted">
          {emptyPassageCount} chunk{emptyPassageCount === 1 ? "" : "s"} hidden - no selected model
          produced a claim there.
        </span>
        <button
          onclick={() => (showEmptyPassages = !showEmptyPassages)}
          class="text-[11px] text-primary hover:underline cursor-pointer"
        >
          {showEmptyPassages ? "Hide them" : "Show them"}
        </button>
      </div>
    {/if}

    {#if tab === "claims"}
    <div class="flex-1 overflow-auto min-h-0">
      {#each listedPassages as p (p.index)}
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
                  ? `${labelOf(t.variant, t.model)} found nothing in this chunk`
                  : `${labelOf(t.variant, t.model)} produced ${t.count} claim${t.count === 1 ? "" : "s"} here`}
              >
                <span class="w-1.5 h-1.5 rounded-full flex-none" style="background:{colourOf.get(t.variant)}"></span>
                {labelOf(t.variant, t.model)} {t.count}
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
                    {#if onquote}
                      <button
                        type="button"
                        class="claim-linked text-sm text-on-surface-secondary border-l-2 border-primary/40 pl-2 leading-snug text-left w-full"
                        title="Find this passage in the source"
                        onmouseenter={() => onquote(q, "source", false)}
                        onclick={() => onquote(q, "source", true)}
                      >{q}</button>
                    {:else}
                      <p class="text-sm text-on-surface-secondary border-l-2 border-primary/40 pl-2 leading-snug">{q}</p>
                    {/if}
                  {:else}
                    <p class="text-xs italic text-on-surface-muted/60">no source quote</p>
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
                      title={cell.present
                        ? labelOf(cell.variant, cell.model)
                        : `${labelOf(cell.variant, cell.model)} produced no claim for this fact`}
                    >
                      <span class="w-1.5 h-1.5 rounded-full flex-none" style="background:{colourOf.get(cell.variant)}"></span>
                      <span class="text-[11px] tabular-nums truncate
                        {cell.present ? 'text-on-surface-secondary' : 'text-on-surface-muted/50'}">{labelOf(cell.variant, cell.model)}</span>
                    </span>
                    {#if !cell.present}
                      <span class="text-xs italic text-on-surface-muted/50 pt-0.5">nothing</span>
                    {:else}
                      <div class="min-w-0 flex-1 space-y-1">
                        {#each cell.members as m (m.claim_id)}
                          {@const g = goldOf(m)}
                          {@const label = frameLabel({
                            text: m.text,
                            claim_type: m.claim_type,
                            attestation: m.attestation,
                            refs: m.refs,
                          })}
                          <!-- ONE claim, and directly beneath it the rating for
                               THAT claim. They were rendered in two separate
                               loops - every claim's text, then every claim's
                               buttons - so three claims produced three "Rate:"
                               rows with nothing saying which belonged to which. -->
                          <div class="claim-block {isFocused(m) ? 'claim-focused' : ''} {g?.quality || g?.irrelevant ? 'is-graded' : ''}">
                            {#if onquote && m.quote}
                              <button
                                type="button"
                                class="claim-linked text-sm text-on-surface leading-snug text-left w-full"
                                title="Show the source this was drawn from"
                                onmouseenter={() => onquote(m.quote, labelOf(cell.variant, cell.model), false)}
                                onclick={() => onquote(m.quote, labelOf(cell.variant, cell.model), true)}
                              >{m.text}</button>
                            {:else}
                              <p class="text-sm text-on-surface leading-snug">{m.text}</p>
                            {/if}
                            {#if label}
                              <p class="text-[10px] font-mono text-on-surface-muted/70 leading-tight">{label}</p>
                            {/if}
                            {#if canGrade}
                            <!-- ONE question, about THIS model's claim: quality.
                                 Hover + 1/2/3/x grades without clicking. -->
                            <div
                              class="flex flex-wrap items-center gap-1 mt-1"
                              role="group"
                              onmouseenter={() => (hoveredMember = { m, p })}
                              onmouseleave={() => (hoveredMember = null)}
                            >
                              <span class="text-[10px] text-on-surface-muted/70 mr-0.5">Rate:</span>
                              {#each QUALITY as q, qi}
                                <button
                                  onclick={() => saveClaim(m, p, { quality: q })}
                                  class="grade-chip {g?.quality === q ? 'is-set ' + q : ''}"
                                  title="{QUALITY_HELP[q]} - keyboard: {qi + 1}"
                                >
                                  <kbd>{qi + 1}</kbd>{q}
                                </button>
                              {/each}
                              <button
                                onclick={() => saveClaim(m, p, { irrelevant: !g?.irrelevant })}
                                class="grade-chip ml-2 {g?.irrelevant ? 'is-set irrelevant' : ''}"
                                title="Separate from the rating: the claim may be well made and still not worth recording. Keyboard: x"
                              >
                                <kbd>x</kbd>not worth recording
                              </button>
                              {#if g?.quality || g?.irrelevant}
                                <span class="text-[10px] text-success ml-1" title="Saved to the gold sidecar">saved</span>
                              {/if}
                            </div>
                            {/if}
                          </div>
                        {/each}
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
  {/if}
</div>

<style>
  /* The claims a clicked stretch of source produced. Marked rather than
     filtered: the neighbours are the context that makes it readable. */
  .claim-focused {
    background: color-mix(in srgb, var(--color-primary, #0d9488) 18%, transparent);
    box-shadow: inset 2px 0 0 var(--color-primary, #0d9488);
  }

  /* A claim that can be traced to its source says so on hover - the link is the
     point of the split view, and an unmarked paragraph gives no hint it is
     clickable. */
  .claim-linked {
    cursor: pointer;
    border-radius: 0.15rem;
    transition: background-color 0.12s;
  }
  .claim-linked:hover {
    background: color-mix(in srgb, currentColor 8%, transparent);
  }

  /* The grading controls read as BUTTONS, and the keyboard shortcut reads as a
     KEY rather than as part of the label. They previously rendered as bare text
     "1 bad  2 okay  3 good  x irrelevant", which looks like a list of labels
     with stray numerals - the affordance was invisible and the shortcut looked
     like part of the word. */
  .grade-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 11px;
    line-height: 1;
    padding: 0.25rem 0.45rem;
    border-radius: 0.25rem;
    border: 1px solid var(--color-border, rgba(128, 128, 128, 0.35));
    background: transparent;
    color: var(--color-on-surface-secondary, inherit);
    cursor: pointer;
    transition:
      background-color 0.12s,
      border-color 0.12s,
      color 0.12s;
  }
  .grade-chip:hover {
    background: var(--color-surface-alt, rgba(128, 128, 128, 0.12));
  }
  .grade-chip kbd {
    font-family: inherit;
    font-size: 9px;
    font-weight: 600;
    line-height: 1;
    padding: 0.12rem 0.25rem;
    border-radius: 0.15rem;
    background: var(--color-surface-alt, rgba(128, 128, 128, 0.18));
    color: var(--color-on-surface-muted, inherit);
    opacity: 0.85;
  }
  /* The chosen one is filled, so a graded claim is legible at a glance while
     scrolling; the rest stay quiet outlines. */
  .grade-chip.is-set {
    border-color: transparent;
    font-weight: 600;
  }
  .grade-chip.is-set kbd {
    background: rgba(255, 255, 255, 0.25);
    color: inherit;
    opacity: 0.9;
  }
  .grade-chip.is-set.bad {
    background: var(--color-error, #dc2626);
    color: var(--color-on-error, #fff);
  }
  .grade-chip.is-set.okay {
    background: var(--color-warning, #d97706);
    color: var(--color-on-warning, #fff);
  }
  .grade-chip.is-set.good {
    background: var(--color-success, #16a34a);
    color: var(--color-on-success, #fff);
  }
  .grade-chip.is-set.irrelevant {
    background: var(--color-on-surface-muted, #6b7280);
    color: var(--color-surface, #fff);
  }
</style>
