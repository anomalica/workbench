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
    putAuditClaims,
    putAuditNodes,
    type AuditNodeGold,
    type AuditPayload,
    type AuditPassage,
    type AuditCluster,
    type AuditMember,
    type AuditClaimGold,
  } from "$lib/api";
  import { variantLabels } from "$lib/variant-label";
  import { safeLocalSet } from "$lib/storage";
  import {
    visibleRows,
    passageHasContent,
    passageTally,
    stepsPastRendered,
    doubtfulFirst,
    entailmentLabel,
    memberLines,
    frameLabel,
    type AuditGridRow,
  } from "$lib/audit-grid";

  let {
    hash,
    onquote,
    onchunk,
    focus = [],
  }: {
    hash: string;
    /** Ask the source pane to show a whole CHUNK's span - what a chunk IS,
     *  demonstrated on the text rather than asserted by a heading. */
    onchunk?: (claimKeys: string[], scroll: boolean) => void;
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
  // Two questions, asked separately because they have different answers and
  // different fixes: how well was it EXTRACTED, and is it worth HAVING.
  const QUALITY = ["bad", "okay", "good"] as const;
  const VALUE = ["irrelevant", "potentially", "gold"] as const;
  const QUALITY_HELP: Record<string, string> = {
    bad: "Unsupported by, or misrepresents, the source - or badly made",
    okay: "Serviceable extraction",
    good: "Faithful and well made",
  };
  const VALUE_HELP: Record<string, string> = {
    irrelevant: "Not worth recording, however well extracted",
    potentially: "Might matter - worth keeping, not yet a finding",
    gold: "Prized: a claim the archive exists to hold",
  };

  let recordHash = $derived(payload?.record.hash ?? "");

  /** A variant's prompt identity: its fingerprint, else the stem's `.sha`
   *  suffix, else the id. Always non-empty, because the write is rejected
   *  without one. */
  function promptShaOf(variantId: string): string {
    const v = allVariants.find((x) => x.id === variantId);
    if (v?.prompt_fingerprint) return v.prompt_fingerprint;
    const parts = variantId.split(".");
    return parts.length > 1 ? parts[1] : variantId;
  }
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

  /** Verdicts recorded in this session but not yet written. Held here, and
   *  mirrored to localStorage, so a burst of grading costs nothing and a
   *  reload does not lose it.
   *
   *  Writing on every keypress meant a request and a git commit per keystroke:
   *  the git log became a keystroke log, and the reviewer's pace became git's.
   *  Grading is done in bursts - work down a passage, then move on - so the
   *  natural unit is the burst, not the press. */
  let unsaved = $state<Record<string, AuditClaimGold>>({});
  let saving = $state(false);
  let savedAt = $state<string | null>(null);
  let unsavedCount = $derived(Object.keys(unsaved).length);
  let draftKey = $derived(recordHash ? `workbench:audit:${recordHash}` : "");

  $effect(() => {
    if (!draftKey) return;
    try {
      const raw = localStorage.getItem(draftKey);
      unsaved = raw ? JSON.parse(raw) : {};
    } catch {
      unsaved = {};
    }
  });
  $effect(() => {
    if (!draftKey) return;
    const n = Object.keys(unsaved).length;
    if (n) safeLocalSet(draftKey, JSON.stringify(unsaved));
    else localStorage.removeItem(draftKey);
  });

  /** Record a verdict locally. Instant, and nothing leaves the browser. */
  function saveClaim(
    m: AuditMember,
    p: AuditPassage,
    change: {
      // null CLEARS the axis. A misclick set a verdict permanently - there was
      // no way back, and a wrong grade is worse than an absent one because
      // nothing downstream can tell them apart.
      quality?: "bad" | "okay" | "good" | null;
      value?: "irrelevant" | "potentially" | "gold" | null;
    },
  ) {
    const key = keyOf(m);
    const prev = unsaved[key] ?? goldOf(m);
    unsaved = {
      ...unsaved,
      [key]: {
        ...(prev?.gold_id ? { gold_id: prev.gold_id } : {}),
        variant: m.variant,
        model: m.model,
        prompt_sha: promptShaOf(m.variant),
        claim_id: m.claim_id,
        location: m.location || (p.raw_locations[0] ?? ""),
        text: m.text,
        quote: m.quote ?? "",
        claim_type: m.claim_type ?? "",
        ...(change.quality !== undefined
          ? change.quality === null
            ? {}
            : { quality: change.quality }
          : prev?.quality
            ? { quality: prev.quality }
            : {}),
        ...(change.value !== undefined
          ? change.value === null
            ? {}
            : { value: change.value }
          : prev?.value
            ? { value: prev.value }
            : {}),
        claim: { text: m.text, type: m.claim_type, quote: m.quote, location: m.location },
      },
    };
  }

  async function submitVerdicts() {
    const entries = Object.values(unsaved);
    if (!entries.length || saving) return;
    saving = true;
    saveError = null;
    try {
      await putAuditClaims(recordHash, entries);
      // Fold them into the stored gold so the chips keep their state without
      // a refetch, then clear the drafts.
      const byKey = new Map(entries.map((e) => [`${e.variant}\u0000${e.claim_id}`, e]));
      goldClaims = [
        ...goldClaims.filter((g) => !byKey.has(`${g.variant}\u0000${g.claim_id}`)),
        ...entries.map((e) => {
          const copy = { ...e };
          delete copy.claim;
          return copy;
        }),
      ];
      unsaved = {};
      savedAt = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    } catch (e) {
      saveError = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  const keyOf = (m: AuditMember) => `${m.variant}\u0000${m.claim_id}`;
  /** What a chip should show: this session's verdict if there is one, else what
   *  was already recorded. */
  function verdictOf(m: AuditMember): AuditClaimGold | undefined {
    return unsaved[keyOf(m)] ?? goldOf(m);
  }

  // Keyboard grading: the claim under the cursor takes 1/2/3/x.
  // A keyboard CURSOR, not a hover state. Revealing the shortcuts on hover was
  // self-defeating: you had to reach for the mouse to find out which keys
  // existed, which is the thing the keys are there to avoid. The cursor moves
  // with j/k (or the arrows) and the keys act on it; the pointer merely moves
  // the cursor too, for people already holding the mouse.
  let cursor = $state<{ m: AuditMember; p: AuditPassage } | null>(null);
  /** Every gradable claim on screen, in reading order - what j/k step through. */
  let claimOrder = $derived.by(() => {
    const out: { m: AuditMember; p: AuditPassage }[] = [];
    for (const p of listedPassages) {
      if (!gradable(p)) continue;
      for (const row of visibleRows(p, variants))
        for (const cell of row.cells) for (const m of cell.members) out.push({ m, p });
    }
    return out;
  });
  function cursorIndex(): number {
    if (!cursor) return -1;
    return claimOrder.findIndex(
      (c) => c.m.variant === cursor!.m.variant && c.m.claim_id === cursor!.m.claim_id,
    );
  }
  function moveCursor(delta: number) {
    if (!claimOrder.length) return;
    // Stepping past the last rendered claim pulls in the next batch, so j does
    // not silently stop at a boundary the reviewer cannot see. Without this the
    // keyboard would reach the end of the DOM rather than the end of the audit.
    if (stepsPastRendered(delta, cursorIndex(), claimOrder.length, moreToRender)) {
      renderedCount += PASSAGE_BATCH;
      return;
    }
    const next = Math.min(Math.max(cursorIndex() + delta, 0), claimOrder.length - 1);
    cursor = claimOrder[cursorIndex() < 0 ? 0 : next];
    requestAnimationFrame(() => {
      document.querySelector(".is-cursor")?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }
  /** Identity by (variant, claim_id), NOT by object reference: `m` inside a
   *  keyed each is a reactive proxy and a re-render can hand out a fresh
   *  wrapper, so `===` silently stopped matching and the hovered claim never
   *  showed its keys. */
  function isHovered(m: AuditMember): boolean {
    const h = cursor?.m;
    return !!h && h.variant === m.variant && h.claim_id === m.claim_id;
  }
  function onKeydown(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    if (e.key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      moveCursor(1);
      return;
    }
    if (e.key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      moveCursor(-1);
      return;
    }
    // A rating key with no cursor yet lands on the FIRST claim rather than
    // doing nothing. The keys were listed in the header but pressing one before
    // pressing j appeared to do nothing at all, which reads as broken.
    if (!cursor && claimOrder.length) cursor = claimOrder[0];
    if (!cursor) return;
    const { m, p } = cursor;
    if (!gradable(p)) return;
    // The number keys toggle too, so a mis-keyed grade is undone the same way
    // it was made rather than being permanent.
    const set = verdictOf(m);
    const q = (v: "bad" | "okay" | "good") =>
      saveClaim(m, p, { quality: set?.quality === v ? null : v });
    const val = (v: "irrelevant" | "potentially" | "gold") =>
      saveClaim(m, p, { value: set?.value === v ? null : v });
    if (e.key === "1") q("bad");
    else if (e.key === "2") q("okay");
    else if (e.key === "3") q("good");
    else if (e.key === "8" || e.key === "0" || e.key === "x" || e.key === "X") val("irrelevant");
    else if (e.key === "9") val("potentially");
    else if (e.key === "7") val("gold");
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
  /** Doubtful claims first - a contradiction, then a neutral, then a weak
   *  entailment - so a reviewer meets what the digester could not confirm
   *  before what it could. On by default; document order is one click away
   *  for reading against the source. */
  let doubtfulFirstOn = $state(true);
  let allListedPassages = $derived.by(() => {
    const base = showEmptyPassages ? (payload?.passages ?? []) : shownPassages;
    return doubtfulFirstOn ? doubtfulFirst(base) : base;
  });

  /** How many passages are actually built into the DOM.
   *
   *  The whole audit used to render at once: 293 passages became 41,000
   *  elements and 6,264 clickable chips for one record, and a real browser has
   *  to lay out and paint every one of them before the pane is usable. That is
   *  seconds of frozen page, and it grows with the record.
   *
   *  A batch at a time, extended as the reviewer reaches the end. Reading is
   *  top-down, so the passages below the fold are not needed until they are
   *  scrolled to, and the first screen arrives immediately regardless of how
   *  big the record is. */
  const PASSAGE_BATCH = 25;
  let renderedCount = $state(PASSAGE_BATCH);
  let listedPassages = $derived(allListedPassages.slice(0, renderedCount));
  let moreToRender = $derived(allListedPassages.length - listedPassages.length);

  // Back to the top of the list whenever the record changes, or a small record
  // opened after a big one would start already "expanded".
  $effect(() => {
    void payload;
    void showEmptyPassages;
    renderedCount = PASSAGE_BATCH;
  });

  /** Extend when the sentinel below the list comes into view. */
  function moreOnScroll(node: HTMLElement) {
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && moreToRender > 0) {
          renderedCount += PASSAGE_BATCH;
        }
      },
      { rootMargin: "600px" },
    );
    io.observe(node);
    return { destroy: () => io.disconnect() };
  }

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
  let nodeGroups = $derived(
    (payload?.nodes ?? []).filter((g) => g.found_by.some((v) => !hidden.has(v))),
  );
  let nodeTypes = $derived(
    [...new Set(nodeGroups.map((g) => g.alternatives[0]?.type ?? ""))].sort(),
  );
  let nodeRows = $derived(nodeGroups.flatMap((g) => g.alternatives));
  let sharedNodeCount = $derived(
    nodeRows.filter((n) => n.found_by.filter((v) => !hidden.has(v)).length > 1).length,
  );

  // --- entity verdicts ------------------------------------------------------
  // Entities fail differently from claims: `too generic` and `incorrect
  // formatting` are faults of the ENTITY, not of how well it was extracted.
  const NODE_QUALITY = ["irrelevant", "too_generic", "incorrect_formatting", "good"] as const;
  const NODE_LABEL: Record<string, string> = {
    irrelevant: "irrelevant",
    too_generic: "too generic",
    incorrect_formatting: "wrong form",
    good: "good",
  };
  const NODE_HELP: Record<string, string> = {
    irrelevant: "Not worth a node at all",
    too_generic: "Real, but useless as an entity - \"the government\", \"researchers\"",
    incorrect_formatting: "Right entity, wrong surface form",
    good: "Correct and well formed",
  };
  let unsavedNodes = $state<Record<string, AuditNodeGold>>({});
  let unsavedNodeCount = $derived(Object.keys(unsavedNodes).length);
  let savedNodes = $derived(payload?.gold?.nodes ?? []);
  function nodeKey(variant: string, type: string, name: string) {
    return `${variant}\u0000${type}\u0000${name}`.toLowerCase();
  }
  function nodeVerdict(variant: string, n: { type: string; name: string }) {
    const k = nodeKey(variant, n.type, n.name);
    return (
      unsavedNodes[k] ??
      savedNodes.find((g) => nodeKey(g.variant, g.type, g.name) === k)
    );
  }
  function rateNode(
    variant: string,
    n: { type: string; name: string },
    quality: (typeof NODE_QUALITY)[number],
  ) {
    unsavedNodes = {
      ...unsavedNodes,
      [nodeKey(variant, n.type, n.name)]: { variant, type: n.type, name: n.name, quality },
    };
  }
  async function submitNodes() {
    const entries = Object.values(unsavedNodes);
    if (!entries.length || saving) return;
    saving = true;
    try {
      await putAuditNodes(recordHash, entries);
      if (payload?.gold) payload.gold.nodes = [...savedNodes, ...entries];
      unsavedNodes = {};
      savedAt = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    } catch (e) {
      saveError = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  /** Can this passage's clusters be graded? Only if the models were actually
   *  compared here. A passage holding ONE model emits singletons by
   *  construction, so its "only X found this" flags are artefacts even when the
   *  record as a whole passes - the DoD record has exactly that shape, and both
   *  of its lone-passage singletons were shown to be false (the same facts exist
   *  in the other model's claims under a different location label). */
  function gradable(_p: AuditPassage): boolean {
    // ALWAYS. The guard came from an era of per-CLUSTER verdicts, where a
    // verdict really did depend on the models having been compared. A rating is
    // now per claim - read the quote, read the claim, judge it - and that needs
    // no comparison at all. Withholding the controls hid the claims most worth
    // rating: the one whose quote is not in the source was unrateable precisely
    // because no other model had matched it.
    return true;
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
      {#if tab === "claims"}
        <span
          class="text-[10px] text-on-surface-muted font-mono"
          title="The keys act on the highlighted claim. Nothing needs the mouse."
        >
          <kbd class="kbd-hint">j</kbd><kbd class="kbd-hint">k</kbd> move ·
          <kbd class="kbd-hint">1</kbd><kbd class="kbd-hint">2</kbd><kbd class="kbd-hint">3</kbd>
          extraction bad/okay/good ·
          <kbd class="kbd-hint">8</kbd><kbd class="kbd-hint">9</kbd><kbd class="kbd-hint">7</kbd>
          value irrelevant/potentially/gold
        </span>
      {/if}
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

    <!-- ONE place that says whether the work is safe, instead of a word beside
         every claim that appeared and disappeared and shifted the row. -->
    {#if unsavedCount || unsavedNodeCount || savedAt || saving}
      <div
        class="flex-none px-4 py-1.5 border-b border-border flex items-center gap-2 text-xs
          {unsavedCount ? 'bg-warning-container/40' : 'bg-surface-alt/40'}"
      >
        {#if saving}
          <span class="text-on-surface-secondary">Saving {unsavedCount} rating{unsavedCount === 1 ? "" : "s"}…</span>
        {:else if unsavedCount || unsavedNodeCount}
          <span class="text-on-surface font-medium">
            {unsavedCount + unsavedNodeCount} rating{unsavedCount + unsavedNodeCount === 1 ? "" : "s"}
            not saved yet
          </span>
          <span class="text-on-surface-secondary">- kept in this browser until you save</span>
          <button
            onclick={() => {
              if (unsavedCount) submitVerdicts();
              if (unsavedNodeCount) submitNodes();
            }}
            class="ml-auto text-xs font-medium rounded px-2.5 py-1 cursor-pointer
              bg-primary text-on-primary hover:opacity-90"
          >Save {unsavedCount + unsavedNodeCount}</button>
        {:else if savedAt}
          <span class="text-success">All ratings saved at {savedAt}</span>
        {/if}
      </div>
    {/if}

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
          {@const groups = nodeGroups.filter((g) => g.alternatives[0]?.type === t)}
          <section class="mb-5">
            <h3 class="text-[11px] uppercase tracking-wide text-on-surface-muted mb-1.5 pb-1 border-b border-border">
              {t || "untyped"} <span class="tabular-nums">({groups.length})</span>
            </h3>
            <ul class="flex flex-col gap-1">
              {#each groups as g, gi (t + gi)}
                <!-- A GROUP is forms that may be the same thing. They sit side
                     by side so the reviewer can see the alternatives and judge
                     each; the grouping suggests, it never merges. -->
                <li class="entity-group {g.alternatives.length > 1 ? 'has-alternatives' : ''}">
                  {#each g.alternatives as n (n.type + n.name)}
                    {@const finders = n.found_by.filter((v) => !hidden.has(v))}
                    <!-- Name on its own line, chips beneath. They shared one
                         wrapping row, so a record with six variants left the
                         name about 30px and it wrapped one character per line:
                         "Nimitz Carrier Strike Group" read vertically. The
                         chips' width is set by the variant count and the name's
                         is whatever is left, which is the wrong way round. -->
                    <div class="flex flex-col gap-1 py-1">
                      <div class="flex items-baseline gap-2">
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
                        <span class="text-xs text-on-surface min-w-0 break-words flex-1"
                          >{n.name}</span
                        >
                      </div>
                      <div class="flex items-center gap-2 flex-wrap pl-1">
                      {#each finders as fv (fv)}
                        {@const verdict = nodeVerdict(fv, n)}
                        <span class="flex items-center gap-0.5">
                          <span class="text-[9px] text-on-surface-muted mr-0.5">{labelOf(fv, fv)}</span>
                          {#each NODE_QUALITY as q}
                            <button
                              onclick={() => rateNode(fv, n, q)}
                              class="node-chip {verdict?.quality === q ? 'is-set ' + q : ''}"
                              title={NODE_HELP[q]}
                            >{NODE_LABEL[q]}</button>
                          {/each}
                        </span>
                      {/each}
                      </div>
                    </div>
                  {/each}
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

    {#if tab === "claims" && (payload?.passages ?? []).length > 0}
      <div class="flex items-center gap-2 px-4 py-1.5 text-[11px] text-on-surface-muted">
        <span>Order:</span>
        <button
          onclick={() => (doubtfulFirstOn = true)}
          class="cursor-pointer hover:underline {doubtfulFirstOn ? 'text-primary font-medium' : ''}"
          title="Claims the digester could not confirm against their own quote first: contradictions, then neutral, then weak entailments"
        >doubtful first</button>
        <span aria-hidden="true">&middot;</span>
        <button
          onclick={() => (doubtfulFirstOn = false)}
          class="cursor-pointer hover:underline {doubtfulFirstOn ? '' : 'text-primary font-medium'}"
          title="The order the passages appear in the record"
        >document order</button>
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
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <header
            class="px-4 py-2 bg-surface-alt/60 flex flex-wrap items-center gap-x-3 gap-y-1 sticky top-0 z-10 border-b border-border {onchunk
              ? 'chunk-header'
              : ''}"
            title={onchunk ? "Show this chunk's span in the source" : undefined}
            onmouseenter={() =>
              onchunk?.(
                rows.flatMap((r) => r.cells.flatMap((c) => c.members.map((m) => keyOf(m)))),
                false,
              )}
            onmouseleave={() => onchunk?.([], false)}
            onclick={() =>
              onchunk?.(
                rows.flatMap((r) => r.cells.flatMap((c) => c.members.map((m) => keyOf(m)))),
                true,
              )}
          >
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
          {#if p.compared === false && p.grouped_by !== "source" && !confounded}
            <div class="px-4 py-1.5 bg-warning-container/20 border-b border-warning/30">
              <p class="text-[11px] text-on-surface leading-relaxed max-w-4xl">
                Placed by the model's own location label rather than by finding its
                quote in the record, so "only one model here" may be a labelling
                difference rather than a real gap. The claims themselves are still
                yours to rate.
              </p>
            </div>
          {/if}
          {#each rows as row (row.cluster.id)}
            {@const canGrade = gradable(p)}
            <article class="px-4 py-3 border-b border-border/50 {row.singleton && canGrade ? 'bg-warning-container/10' : ''}">
              <!-- Each model's rendering of this fact, one line each. -->
              <div class="mt-2 space-y-1">
                {#each row.cells as cell (cell.variant)}
                  <!-- A model's claims sit inside its OWN block, marked down the
                       left in the model's colour. Three claims from one model
                       and one from the next ran together as a flat stack, so
                       which claim belonged to which model - and where a model's
                       run of claims ended - had to be inferred from a dot far
                       to the left. -->
                  <div
                    class="model-block flex items-start gap-2 {cell.present ? 'has-claims' : ''}"
                    style="--model-colour: {colourOf.get(cell.variant)}"
                  >
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
                          {@const g = verdictOf(m)}
                          {@const label = frameLabel({
                            text: m.text,
                            claim_type: m.claim_type,
                            attestation: m.attestation,
                            speaker: m.speaker ?? "",
                            refs: m.refs,
                          })}
                          <!-- ONE claim, and directly beneath it the rating for
                               THAT claim. They were rendered in two separate
                               loops - every claim's text, then every claim's
                               buttons - so three claims produced three "Rate:"
                               rows with nothing saying which belonged to which. -->
                          <!-- svelte-ignore a11y_no_static_element_interactions -->
                          <div
                            class="claim-block {isHovered(m) ? 'is-cursor' : ''} {isFocused(m)
                              ? 'claim-focused'
                              : ''} {g?.quality ||
                            g?.irrelevant
                              ? 'is-graded'
                              : ''}"
                            onmouseenter={() => (cursor = { m, p })}
                          >
                            {#if onquote && m.quote}
                              <button
                                type="button"
                                class="claim-linked text-sm text-on-surface leading-snug text-left w-full"
                                title="Show the source this was drawn from"
                                onmouseenter={() => onquote(m.quote, labelOf(cell.variant, cell.model), false)}
                                onmouseleave={() => onquote("", "", false)}
                                onclick={() => onquote(m.quote, labelOf(cell.variant, cell.model), true)}
                              >{m.text}</button>
                            {:else}
                              <p class="text-sm text-on-surface leading-snug">{m.text}</p>
                            {/if}
                            {#if label}
                              <p class="text-[10px] font-mono text-on-surface-muted/70 leading-tight">{label}</p>
                            {/if}
                            <!-- The model's OWN quote, always, inside its own
                                 box. Listing the cluster's distinct quotes above
                                 the claims left the reader unable to say which
                                 evidence belonged to which claim, and showing
                                 them there only SOMETIMES made the layout answer
                                 a different question depending on the cluster.
                                 The grouping already says these are one fact;
                                 the box says what each model made of it and
                                 which words it took. -->
                            {#if entailmentLabel(m.entailment)}
                              <!-- Only neutral and contradicts are said; an
                                   entailment is the expected case. Combined
                                   with a quote that is not in the record it is
                                   a contradiction against words the source
                                   never had, which the hover says. -->
                              <span
                                class="entailment-tag {m.entailment?.label}"
                                title={`The quote ${m.entailment?.label === "contradicts" ? "contradicts" : "neither supports nor contradicts"} the claim (${m.entailment?.score.toFixed(2)}, ${m.entailment?.model})${m.located === false ? ". And the quote itself is not in the record." : ""}`}
                              >{entailmentLabel(m.entailment)}</span>
                            {/if}
                            {#if m.quote}
                              <p class="member-quote {m.located === false ? 'not-in-source' : ''}">
                                {m.quote}
                                {#if m.located === false}
                                  <span
                                    class="not-found-tag"
                                    title="This quote could not be found in the record. The claim's evidence is not in the source - the wording was altered, stitched together, or invented."
                                  >not in the source</span>
                                {/if}
                              </p>
                            {/if}
                            {#if canGrade}
                            <!-- TWO ROWS, because these are two questions. One
                                 row of six read as a single scale, so choosing
                                 from both looked like a mistake rather than the
                                 point: a claim can be faultlessly extracted and
                                 still worthless. -->
                            <div
                              class="grade-rows mt-1 {isHovered(m) ? 'is-armed' : ''}"
                              role="group"
                            >
                              <div class="grade-row">
                                <span class="grade-axis">extraction</span>
                                {#each QUALITY as q, qi}
                                  <button
                                    onclick={() =>
                                      saveClaim(m, p, { quality: g?.quality === q ? null : q })}
                                    class="grade-chip {g?.quality === q ? 'is-set ' + q : ''}"
                                    title="{g?.quality === q
                                      ? 'Click again to clear this'
                                      : QUALITY_HELP[q]} - hover this claim and press {qi + 1}"
                                  >
                                    <kbd class:invisible={!isHovered(m)}>{qi + 1}</kbd>{q}
                                  </button>
                                {/each}
                              </div>
                              <div class="grade-row">
                                <span class="grade-axis">value</span>
                                {#each VALUE as v, vi}
                                  <button
                                    onclick={() =>
                                      saveClaim(m, p, {
                                        value:
                                          g?.value === v || (v === "irrelevant" && g?.irrelevant && !g?.value)
                                            ? null
                                            : v,
                                      })}
                                    class="grade-chip {g?.value === v ||
                                    (v === 'irrelevant' && g?.irrelevant && !g?.value)
                                      ? 'is-set ' + v
                                      : ''}"
                                    title="{VALUE_HELP[v]} - hover this claim and press {[8, 9, 7][vi]}"
                                  >
                                    <kbd class:invisible={!isHovered(m)}>{[8, 9, 7][vi]}</kbd>{v}
                                  </button>
                                {/each}
                              </div>
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
      {#if moreToRender > 0}
        <!-- Reaching this extends the list. Also a button, so it works without
             an observer and says plainly that there IS more rather than
             leaving the reviewer to guess the list ended. -->
        <div use:moreOnScroll class="py-4 text-center">
          <button
            onclick={() => (renderedCount += PASSAGE_BATCH)}
            class="text-xs font-ui text-on-surface-muted hover:text-on-surface"
          >{moreToRender} more passage{moreToRender === 1 ? "" : "s"}</button>
        </div>
      {/if}
    </div>
    {/if}
  {/if}
</div>

<style>
  /* The claims a clicked stretch of source produced. Marked rather than
     filtered: the neighbours are the context that makes it readable. */
  /* Only the hovered claim shows key badges, because the keys act on THAT
     claim and nothing else. Printing 1/2/3 beside every claim on a page of
     thousands read as a numbered list - "if I press 6, what am I referring
     to?" - when the number was never an index, only a key. */
  .is-cursor {
    outline: 2px solid var(--color-primary, #0d9488);
    outline-offset: 1px;
  }

  .is-armed {
    outline: 1px dashed color-mix(in srgb, var(--color-primary, #0d9488) 45%, transparent);
    outline-offset: 2px;
    border-radius: 0.2rem;
  }

  /* One model's claims, bracketed by a rule in its colour. */
  .model-block.has-claims {
    border-left: 3px solid var(--model-colour, transparent);
    padding-left: 0.5rem;
    margin-left: -0.5rem;
    border-radius: 0.15rem;
  }
  .model-block + .model-block {
    margin-top: 0.75rem;
  }

  /* A claim and ITS rating are one card; the next claim is visibly another. */
  /* Evidence sits with the claim it supports. */
  .member-quote {
    margin-top: 0.2rem;
    padding-left: 0.45rem;
    border-left: 2px solid color-mix(in srgb, var(--color-primary, #0d9488) 45%, transparent);
    font-size: 11px;
    line-height: 1.35;
    color: var(--color-on-surface-secondary, inherit);
  }

  .member-quote.not-in-source {
    border-left-color: var(--color-error, #dc2626);
  }
  .entailment-tag {
    display: inline-block;
    margin: 0.15rem 0 0.1rem;
    padding: 0 0.3rem;
    border-radius: 0.15rem;
    font-size: 9px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    cursor: help;
  }
  .entailment-tag.neutral {
    background: color-mix(in srgb, var(--color-warning) 18%, transparent);
    color: var(--color-warning);
  }
  .entailment-tag.contradicts {
    background: color-mix(in srgb, var(--color-error) 18%, transparent);
    color: var(--color-error);
  }
  .not-found-tag {
    display: inline-block;
    margin-left: 0.35rem;
    padding: 0 0.3rem;
    border-radius: 0.15rem;
    font-size: 9px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    background: var(--color-error, #dc2626);
    color: var(--color-on-error, #fff);
  }

  .claim-block {
    padding: 0.35rem 0.5rem;
    border-radius: 0.25rem;
    background: color-mix(in srgb, currentColor 3%, transparent);
  }
  .claim-block + .claim-block {
    margin-top: 0.4rem;
  }
  .claim-block.is-graded {
    background: color-mix(in srgb, var(--color-success, #16a34a) 7%, transparent);
  }

  /* "These came from the text you touched" - a tint, not a border. Outlining
     every claim in a chunk made the whole column look selected and left the
     keyboard cursor with nothing distinctive to say. */
  .claim-focused {
    background: color-mix(in srgb, var(--color-primary, #0d9488) 10%, transparent);
  }
  .chunk-header {
    cursor: pointer;
  }
  .chunk-header:hover {
    background: color-mix(in srgb, var(--color-primary, #0d9488) 12%, transparent);
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
  .kbd-hint {
    font-family: inherit;
    font-size: 9px;
    padding: 0.1rem 0.22rem;
    margin-right: 1px;
    border-radius: 0.15rem;
    background: var(--color-surface-alt, rgba(128, 128, 128, 0.18));
  }

  /* Alternatives are bracketed together, so "these may be the same thing"
     reads off the layout rather than needing a label. */
  .entity-group {
    padding: 0.15rem 0.35rem;
    border-radius: 0.2rem;
  }
  .entity-group.has-alternatives {
    border-left: 2px solid color-mix(in srgb, var(--color-primary, #0d9488) 55%, transparent);
    background: color-mix(in srgb, currentColor 3%, transparent);
  }
  .node-chip {
    font-size: 9px;
    line-height: 1;
    padding: 0.15rem 0.3rem;
    border-radius: 0.15rem;
    border: 1px solid var(--color-border, rgba(128, 128, 128, 0.35));
    background: transparent;
    color: var(--color-on-surface-muted, inherit);
    cursor: pointer;
  }
  .node-chip:hover {
    background: var(--color-surface-alt, rgba(128, 128, 128, 0.15));
  }
  .node-chip.is-set {
    border-color: transparent;
    font-weight: 600;
    color: #fff;
  }
  .node-chip.is-set.good {
    background: var(--color-success, #16a34a);
  }
  .node-chip.is-set.irrelevant {
    background: #475569;
  }
  .node-chip.is-set.too_generic {
    background: #b45309;
  }
  .node-chip.is-set.incorrect_formatting {
    background: #7c3aed;
  }

  .grade-chip kbd.invisible {
    visibility: hidden;
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
  .grade-chip.is-set.gold {
    background: #b8860b;
    color: #fff;
  }
  .grade-chip.is-set.potentially {
    background: #2563eb;
    color: #fff;
  }

  /* The two questions read as two, with the axis named rather than left to be
     inferred from the labels. */
  .grade-rows {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .grade-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
  }
  .grade-axis {
    width: 4.5rem;
    flex: none;
    font-size: 10px;
    text-align: right;
    padding-right: 0.3rem;
    color: var(--color-on-surface-muted, #6b7280);
  }
  /* Two axes, two palettes. EXTRACTION runs red-amber-green, the familiar
     ramp for "how well was this done". VALUE runs slate-blue-gold, a different
     hue family entirely, so a filled chip says which question it answered
     without the reader tracing back to the row label - and so `okay` and
     `potentially` stop looking like the same verdict. */
  .grade-chip.is-set.irrelevant {
    background: #475569;
    color: #fff;
  }
</style>
