<script lang="ts">
  import { onMount } from "svelte";
  import {
    LANE_LABEL,
    stageRank,
    resolveTarget,
    type ScheduleQueue,
    type ScheduleJob,
    type ReviewItem,
  } from "$lib/schedule";
  import { fetchProcessing, setProcessing, type ProcessingStatus } from "$lib/api";
  import ScheduleJobCard from "./ScheduleJobCard.svelte";

  // The live scheduler queue (from /api/schedule), fetched by the parent (null
  // while loading), plus the known records' titles ({content_hash -> title})
  // so record targets show their human title instead of a hash/slug.
  let {
    queue,
    recordTitles = {},
  }: {
    queue: ScheduleQueue | null;
    recordTitles?: Record<string, string>;
  } = $props();

  // Processing mode (the runner). Polled while this tab is open so the gate
  // readout + recently-completed stay live.
  let processing = $state<ProcessingStatus | null>(null);
  let toggling = $state(false);
  let procError = $state<string | null>(null);

  async function loadProcessing() {
    try {
      processing = await fetchProcessing();
    } catch {
      /* leave last-known; transient */
    }
  }

  async function toggleProcessing() {
    if (toggling) return;
    toggling = true;
    procError = null;
    try {
      processing = await setProcessing(processing?.mode === "on" ? "off" : "on");
    } catch (e) {
      procError = e instanceof Error ? e.message : String(e);
    } finally {
      toggling = false;
    }
  }

  onMount(() => {
    loadProcessing();
    const t = setInterval(loadProcessing, 10000);
    return () => clearInterval(t);
  });

  // Cap how many cards render per lane - the GPU/ingest lane can be hundreds;
  // showing every one would be a heavy DOM, and the count note keeps it honest.
  const CAP = 100;

  let tab = $state<"claude" | "gpu" | "review" | "article">("claude");
  const NONE = "Not tied to one page";

  let jobs = $derived(queue?.jobs ?? []);
  let claudeJobs = $derived(
    jobs.filter((j) => j.lane === "claude").sort((a, b) => (b.value ?? -1) - (a.value ?? -1)),
  );
  let gpuJobs = $derived(jobs.filter((j) => j.lane === "gpu"));
  let eagerJobs = $derived(jobs.filter((j) => j.lane === "eager"));
  let reviewItems = $derived(
    [...(queue?.reviewQueue ?? [])].sort((a, b) => (b.demand ?? -1) - (a.demand ?? -1)),
  );

  let articleJobs = $derived(jobs.filter((j) => j.article));
  let byArticle = $derived.by<[string, ScheduleJob[]][]>(() => {
    const groups = new Map<string, ScheduleJob[]>();
    for (const j of jobs) {
      const k = j.article ?? NONE;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)?.push(j);
    }
    for (const arr of groups.values()) arr.sort((a, b) => stageRank(a.type) - stageRank(b.type));
    return [...groups.entries()].sort((a, b) => {
      if (a[0] === NONE) return 1;
      if (b[0] === NONE) return -1;
      return a[0].localeCompare(b[0]);
    });
  });

  function nextId(js: ScheduleJob[]): string | null {
    return js[0]?.id ?? null;
  }

  let empty = $derived(queue !== null && jobs.length === 0 && reviewItems.length === 0);

  const TABS: { id: typeof tab; label: string }[] = [
    { id: "claude", label: "Claude" },
    { id: "gpu", label: "GPU" },
    { id: "review", label: "Review" },
    { id: "article", label: "By article" },
  ];
</script>

{#snippet capNote(shown: number, total: number, suffix = "")}
  {#if total > shown}
    <p class="text-xs text-on-surface-muted pt-1">Showing the first {shown} of {total}{suffix}.</p>
  {/if}
{/snippet}

{#snippet reviewRow(item: ReviewItem)}
  {@const r = resolveTarget(item.target, recordTitles)}
  <div class="rounded-md border border-border bg-surface px-3 py-2 text-sm flex items-baseline gap-2 flex-wrap">
    {#if item.demand !== undefined}
      <span class="text-xs font-ui font-medium tabular-nums text-warning w-12 flex-none" title="demand (scheduler priority)">
        d {item.demand.toFixed(2)}
      </span>
    {/if}
    {#if r.href}
      <a href={r.href} class="text-primary hover:underline">{r.label}</a>
    {:else}
      <span class="text-on-surface">{r.label}</span>
    {/if}
    {#if item.reason}<span class="text-xs text-on-surface-muted ml-auto">{item.reason}</span>{/if}
  </div>
{/snippet}

<div class="flex-1 flex flex-col min-h-0">
  <!-- Tabs -->
  <div class="px-6 py-2 border-b border-border bg-surface-alt flex items-center gap-1 flex-none">
    {#each TABS as t}
      <button
        onclick={() => { tab = t.id; }}
        class="text-sm font-ui px-3 py-1 rounded cursor-pointer transition-colors
          {tab === t.id ? 'bg-primary text-on-primary' : 'text-on-surface-secondary hover:bg-surface'}"
      >{t.label}</button>
    {/each}
    <span class="flex-1"></span>
    <span class="text-xs font-ui text-on-surface-muted">
      {#if queue?.generatedAt}generated {new Date(queue.generatedAt).toLocaleString()}{:else if queue}not yet generated{/if}
    </span>
  </div>

  <!-- Processing mode (the runner): the autonomous worker + its dual-trend gate -->
  <div class="px-6 py-2 border-b border-border flex items-center gap-3 flex-wrap flex-none text-xs font-ui">
    <span class="font-medium text-on-surface">Processing mode</span>
    <button
      onclick={toggleProcessing}
      disabled={toggling}
      class="px-2.5 py-0.5 rounded font-medium cursor-pointer transition-colors disabled:opacity-50
        {processing?.mode === 'on' ? 'bg-success text-on-success' : 'bg-surface border border-border text-on-surface-secondary hover:bg-surface-alt'}"
      title="Flip the runner on/off - it works the queue while on (subscription-only, gated by usage)"
    >{processing?.mode === "on" ? "ON" : "OFF"}</button>
    {#if processing?.mode !== "on"}
      <span class="text-on-surface-muted">idle - flip on to work the queue</span>
    {/if}
    {#if processing?.mode === "on"}
      <span class="text-on-surface-secondary">
        {processing.state}{processing.reason ? ` - ${processing.reason}` : ""}
      </span>
      {#if processing.gate}
        <span class="ml-auto text-on-surface-muted tabular-nums">
          5h {processing.gate.five_hour.util}/{processing.gate.five_hour.ideal}
          · 7d {processing.gate.seven_day.util}/{processing.gate.seven_day.ideal}
          {#if processing.usage_status && processing.usage_status !== "fresh"}
            · usage {processing.usage_status}
          {/if}
        </span>
      {/if}
    {/if}
    {#if procError}<span class="text-error">{procError}</span>{/if}
  </div>

  <!-- Honest caveats about the live data -->
  <div class="px-6 py-2 border-b border-border/60 flex-none text-xs font-ui text-on-surface-muted">
    Live queue from the scheduler. Ingest jobs are unranked (source priority isn't a built concept
    yet); demand exists only for records already in the graph, others rank off a baseline. Token
    quota, no dollar costs.
  </div>

  <div class="flex-1 overflow-auto px-6 py-4 space-y-4">
    {#if queue === null}
      <p class="text-sm text-on-surface-muted">Loading the queue...</p>
    {:else if empty}
      <p class="text-sm text-on-surface-muted">
        The scheduler hasn't produced a queue yet. Run <code class="font-mono">assimilator schedule</code> to generate one.
      </p>
    {:else if tab === "claude"}
      <h3 class="text-sm font-medium text-on-surface flex items-baseline gap-2">
        {LANE_LABEL.claude} lane <span class="text-xs font-ui text-on-surface-muted">tokens - the scarce-budget queue</span>
      </h3>
      {#each claudeJobs.slice(0, CAP) as job (job.id)}<ScheduleJobCard {job} {recordTitles} />{/each}
      {@render capNote(Math.min(claudeJobs.length, CAP), claudeJobs.length)}
    {:else if tab === "gpu"}
      <h3 class="text-sm font-medium text-on-surface flex items-baseline gap-2">
        {LANE_LABEL.gpu} lane <span class="text-xs font-ui text-on-surface-muted">{gpuJobs.length} transcription jobs, one per video - unranked</span>
      </h3>
      {#each gpuJobs.slice(0, CAP) as job (job.id)}<ScheduleJobCard {job} {recordTitles} />{/each}
      {@render capNote(Math.min(gpuJobs.length, CAP), gpuJobs.length, " (unranked - source priority not built yet)")}
    {:else if tab === "review"}
      <h3 class="text-sm font-medium text-on-surface flex items-baseline gap-2">
        Review lane <span class="text-xs font-ui text-on-surface-muted">{reviewItems.length} records awaiting review, by demand</span>
      </h3>
      {#each reviewItems.slice(0, CAP) as item}{@render reviewRow(item)}{/each}
      {@render capNote(Math.min(reviewItems.length, CAP), reviewItems.length)}
    {:else if articleJobs.length === 0}
      <p class="text-sm text-on-surface-muted">
        No page-tied jobs yet. Jobs gain an article once synthesise/assemble produce page targets;
        until then see the Claude, GPU and Review tabs.
      </p>
    {:else}
      {#each byArticle as [article, groupJobs] (article)}
        {@const next = article === NONE ? null : nextId(groupJobs)}
        <section class="space-y-2">
          <h3 class="text-sm font-medium {article === NONE ? 'text-on-surface-muted' : 'text-on-surface'}">
            {article}
            <span class="text-xs font-ui text-on-surface-muted">&middot; {groupJobs.length} {groupJobs.length === 1 ? "job" : "jobs"} queued</span>
          </h3>
          {#each groupJobs.slice(0, CAP) as job (job.id)}
            {@const isNext = job.id === next}
            <div class="flex items-stretch gap-2">
              <span
                class="w-12 flex-none text-[10px] font-ui pt-2.5 text-right {isNext
                  ? job.status === 'eligible'
                    ? 'text-success font-medium'
                    : 'text-on-surface-muted'
                  : 'text-transparent'}"
              >
                {isNext ? (job.status === "eligible" ? "next →" : "next") : ""}
              </span>
              <div class="flex-1 min-w-0"><ScheduleJobCard {job} {recordTitles} /></div>
            </div>
          {/each}
        </section>
      {/each}
    {/if}

    {#if !empty && eagerJobs.length > 0}
      <p class="text-xs text-on-surface-muted pt-2 border-t border-border/40">
        Background (eager, runs automatically, not a scheduled lane): {[...new Set(eagerJobs.map((j) => j.type))].join(", ")}
      </p>
    {/if}

    {#if processing?.completed && processing.completed.length > 0}
      <section class="pt-3 border-t border-border/40 space-y-1">
        <h3 class="text-sm font-medium text-on-surface">Recently completed</h3>
        {#each processing.completed as c}
          <div class="text-sm flex items-baseline gap-2">
            <span class={c.ok ? "text-success" : "text-error"} aria-hidden="true">{c.ok ? "✓" : "✗"}</span>
            <span class="text-xs font-ui text-primary uppercase flex-none">{c.type}</span>
            <span class="text-on-surface truncate">{c.target}</span>
            <span class="ml-auto text-xs text-on-surface-muted tabular-nums flex-none">
              {c.duration_s}s{#if c.tokens} &middot; {c.tokens} tok{/if}
            </span>
          </div>
        {/each}
      </section>
    {/if}
  </div>
</div>
