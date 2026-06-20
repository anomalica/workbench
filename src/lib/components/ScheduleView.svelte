<script lang="ts">
  import { SAMPLE_QUEUE, LANE_LABEL, stageRank, type ScheduleJob } from "$lib/schedule";
  import ScheduleJobCard from "./ScheduleJobCard.svelte";

  // PROVISIONAL: the sample queue stands in for the scheduler's real output,
  // whose contract isn't final. Wiring to the live queue is a later step.
  const queue = SAMPLE_QUEUE;

  // Per-article "what's next" is the view Mark asked for by name, so it's the
  // default; by-lane and flat-by-value are the alternatives.
  let mode = $state<"article" | "lane" | "value">("article");

  const NONE = "Not tied to one page";

  let byValue = $derived([...queue.jobs].sort((a, b) => (b.value ?? -1) - (a.value ?? -1)));

  let byArticle = $derived.by<[string, ScheduleJob[]][]>(() => {
    const groups = new Map<string, ScheduleJob[]>();
    for (const j of queue.jobs) {
      const k = j.article ?? NONE;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)?.push(j);
    }
    for (const arr of groups.values()) arr.sort((a, b) => stageRank(a.type) - stageRank(b.type));
    // Order articles by their highest-value job (started/important chains
    // first), not alphabetically - throughput favours finishing live chains.
    return [...groups.entries()].sort((a, b) => {
      if (a[0] === NONE) return 1;
      if (b[0] === NONE) return -1;
      const av = Math.max(...a[1].map((j) => j.value ?? -1));
      const bv = Math.max(...b[1].map((j) => j.value ?? -1));
      return bv - av;
    });
  });

  let claudeJobs = $derived(
    queue.jobs.filter((j) => j.lane === "claude").sort((a, b) => (b.value ?? -1) - (a.value ?? -1)),
  );
  let localJobs = $derived(queue.jobs.filter((j) => j.lane === "local"));

  let willRun = $derived(new Set(queue.dryRunRunIds));
  let dryRunJobs = $derived(queue.jobs.filter((j) => willRun.has(j.id)));

  // "Next" in a chain = the earliest-stage job still queued (jobs are already
  // stage-sorted), whether or not it's runnable yet - throughput favours
  // finishing the front of a started chain over jumping to a later eligible
  // stage. The marker styles runnable vs waiting differently.
  function nextId(jobs: ScheduleJob[]): string | null {
    return jobs[0]?.id ?? null;
  }

  const MODES: { id: typeof mode; label: string }[] = [
    { id: "article", label: "By article" },
    { id: "lane", label: "By lane" },
    { id: "value", label: "By value" },
  ];
</script>

<div class="flex-1 flex flex-col min-h-0">
  <!-- Header: budget + grouping -->
  <div class="px-6 py-3 border-b border-border bg-surface-alt flex items-center gap-x-5 gap-y-1 flex-wrap flex-none">
    <div class="flex items-baseline gap-1.5">
      <span class="text-sm font-medium text-on-surface">Claude budget</span>
      <span class="text-sm text-on-surface-secondary tabular-nums">{queue.claudeBudget.used} / {queue.claudeBudget.total}</span>
    </div>
    <span class="text-xs text-on-surface-muted">{queue.claudeBudget.note}</span>
    <span class="text-[10px] font-ui px-1.5 py-0.5 rounded bg-warning/15 text-warning" title="The scheduler's real queue isn't wired yet">
      sample data
    </span>
    <div class="flex-1"></div>
    <div class="flex items-center gap-1">
      {#each MODES as m}
        <button
          onclick={() => { mode = m.id; }}
          class="text-xs font-ui px-2 py-1 rounded cursor-pointer transition-colors
            {mode === m.id ? 'bg-primary text-on-primary' : 'text-on-surface-secondary hover:bg-surface'}"
        >{m.label}</button>
      {/each}
    </div>
  </div>

  <div class="flex-1 overflow-auto px-6 py-4 space-y-6">
    <!-- Dry-run preview: what tonight's budget would actually execute -->
    <section class="rounded-lg border border-success/40 bg-success/5 px-4 py-3">
      <div class="text-xs font-ui font-medium text-on-surface-secondary uppercase tracking-wide mb-1">
        Tonight's run (dry run)
      </div>
      {#if dryRunJobs.length === 0}
        <p class="text-sm text-on-surface-muted">Nothing fits tonight's budget.</p>
      {:else}
        <p class="text-sm text-on-surface-secondary mb-1">
          {dryRunJobs.length} of {queue.jobs.filter((j) => j.lane === "claude").length} Claude jobs would run within budget:
        </p>
        <ul class="text-sm text-on-surface flex flex-wrap gap-x-4 gap-y-0.5">
          {#each dryRunJobs as j}
            <li><span class="uppercase text-xs font-ui text-primary">{j.type}</span> {j.target.label}</li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- Grouped jobs -->
    {#if mode === "value"}
      <section class="space-y-2">
        <h3 class="text-xs font-ui font-medium text-on-surface-secondary uppercase tracking-wide">All jobs by value</h3>
        {#each byValue as job (job.id)}
          <ScheduleJobCard {job} willRun={willRun.has(job.id)} />
        {/each}
      </section>
    {:else if mode === "lane"}
      <section class="space-y-2">
        <h3 class="text-sm font-medium text-on-surface flex items-baseline gap-2">
          {LANE_LABEL.claude} queue
          <span class="text-xs font-ui text-on-surface-muted">scarce budget - prioritised by value</span>
        </h3>
        {#each claudeJobs as job (job.id)}
          <ScheduleJobCard {job} willRun={willRun.has(job.id)} />
        {/each}
      </section>
      <section class="space-y-2">
        <h3 class="text-sm font-medium text-on-surface-secondary flex items-baseline gap-2">
          {LANE_LABEL.local} lane
          <span class="text-xs font-ui text-on-surface-muted">free - runs automatically, not prioritised</span>
        </h3>
        <div class="opacity-80 space-y-2">
          {#each localJobs as job (job.id)}
            <ScheduleJobCard {job} willRun={willRun.has(job.id)} />
          {/each}
        </div>
      </section>
    {:else}
      <!-- By article: each page's whole "what's next" chain, in stage order -->
      {#each byArticle as [article, jobs] (article)}
        {@const next = article === NONE ? null : nextId(jobs)}
        <section class="space-y-2">
          <h3 class="text-sm font-medium {article === NONE ? 'text-on-surface-muted' : 'text-on-surface'}">
            {article}
            <span class="text-xs font-ui text-on-surface-muted">&middot; {jobs.length} {jobs.length === 1 ? "job" : "jobs"} queued</span>
          </h3>
          {#each jobs as job (job.id)}
            {@const isNext = job.id === next}
            <div class="flex items-stretch gap-2">
              <span
                class="w-12 flex-none text-[10px] font-ui pt-2.5 text-right {isNext
                  ? job.status === 'eligible'
                    ? 'text-success font-medium'
                    : 'text-on-surface-muted'
                  : 'text-transparent'}"
                title={isNext ? (job.status === "eligible" ? "next - runnable now" : "next in the chain, waiting") : ""}
              >
                {isNext ? (job.status === "eligible" ? "next →" : "next") : ""}
              </span>
              <div class="flex-1 min-w-0"><ScheduleJobCard {job} willRun={willRun.has(job.id)} /></div>
            </div>
          {/each}
        </section>
      {/each}
    {/if}

    <!-- Review backlog: demand routed here by the readiness gate -->
    <section id="review-backlog" class="rounded-lg border border-warning/40 bg-warning/5 px-4 py-3 scroll-mt-4">
      <div class="text-xs font-ui font-medium text-warning uppercase tracking-wide mb-2">
        Review backlog ({queue.reviewBacklog.length})
      </div>
      <p class="text-xs text-on-surface-muted mb-2">
        Demand exists for these, but the target isn't review-ready - the work routes here instead of the queue.
      </p>
      <ul class="space-y-1.5">
        {#each queue.reviewBacklog as item}
          <li class="text-sm">
            {#if item.href}
              <a href={item.href} class="text-primary hover:underline">{item.target.label}</a>
            {:else}
              <span class="text-on-surface">{item.target.label}</span>
            {/if}
            <span class="text-on-surface-muted"> - {item.reason}</span>
          </li>
        {/each}
      </ul>
    </section>
  </div>
</div>
