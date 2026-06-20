<script lang="ts">
  import {
    SAMPLE_QUEUE,
    LANE_LABEL,
    stageRank,
    type ScheduleJob,
    type ReviewItem,
  } from "$lib/schedule";
  import ScheduleJobCard from "./ScheduleJobCard.svelte";

  // PROVISIONAL: the sample queue stands in for the scheduler's real output,
  // whose contract is being reconciled with the assimilator. Demand values are
  // placeholders.
  const queue = SAMPLE_QUEUE;

  // By-lane is the default (Mark's most-used view); By-article is the per-page
  // "what's next" lens.
  let mode = $state<"lane" | "article">("lane");

  const NONE = "Not tied to one page";

  let claudeJobs = $derived(
    queue.jobs.filter((j) => j.lane === "claude").sort((a, b) => (b.value ?? -1) - (a.value ?? -1)),
  );
  let gpuJobs = $derived(
    queue.jobs.filter((j) => j.lane === "gpu").sort((a, b) => (b.value ?? -1) - (a.value ?? -1)),
  );
  let eagerJobs = $derived(queue.jobs.filter((j) => j.lane === "eager"));
  let reviewItems = $derived([...queue.reviewQueue].sort((a, b) => b.demand - a.demand));

  let byArticle = $derived.by<[string, ScheduleJob[]][]>(() => {
    const groups = new Map<string, ScheduleJob[]>();
    for (const j of queue.jobs) {
      const k = j.article ?? NONE;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)?.push(j);
    }
    for (const arr of groups.values()) arr.sort((a, b) => stageRank(a.type) - stageRank(b.type));
    // Articles ordered by their highest-value job (started/important chains
    // first) - throughput favours finishing live chains over alphabetical.
    return [...groups.entries()].sort((a, b) => {
      if (a[0] === NONE) return 1;
      if (b[0] === NONE) return -1;
      const av = Math.max(...a[1].map((j) => j.value ?? -1));
      const bv = Math.max(...b[1].map((j) => j.value ?? -1));
      return bv - av;
    });
  });

  let willRun = $derived(new Set(queue.dryRunRunIds));
  let dryRunJobs = $derived(queue.jobs.filter((j) => willRun.has(j.id)));

  // "Next" in a chain = the earliest-stage job still queued (jobs are stage-
  // sorted), runnable or not - throughput favours finishing the chain front.
  function nextId(jobs: ScheduleJob[]): string | null {
    return jobs[0]?.id ?? null;
  }
</script>

{#snippet reviewRow(item: ReviewItem)}
  <div class="rounded-md border border-border bg-surface px-3 py-2 text-sm flex items-baseline gap-2 flex-wrap">
    <span class="text-xs font-ui font-medium tabular-nums text-warning w-12 flex-none" title="demand (placeholder until the scheduler computes it)">
      d {item.demand}
    </span>
    {#if item.target.href}
      <a href={item.target.href} class="text-primary hover:underline">{item.target.label}</a>
    {:else}
      <span class="text-on-surface">{item.target.label}</span>
    {/if}
    {#if item.target.hash}
      <span class="text-[10px] font-mono text-on-surface-muted" title="record content hash">{item.target.hash.slice(0, 12)}</span>
    {/if}
    <span class="text-xs text-on-surface-muted ml-auto">{item.reason}</span>
  </div>
{/snippet}

<div class="flex-1 flex flex-col min-h-0">
  <!-- Header: budgets + grouping -->
  <div class="px-6 py-3 border-b border-border bg-surface-alt flex items-center gap-x-5 gap-y-1 flex-wrap flex-none">
    <div class="flex items-baseline gap-1.5">
      <span class="text-sm font-medium text-on-surface">Claude</span>
      <span class="text-sm text-on-surface-secondary tabular-nums">{queue.budgets.claude.used} / {queue.budgets.claude.total}</span>
      <span class="text-xs text-on-surface-muted">{queue.budgets.claude.note}</span>
    </div>
    <div class="flex items-baseline gap-1.5">
      <span class="text-sm font-medium text-on-surface">GPU</span>
      <span class="text-sm text-on-surface-secondary tabular-nums">{queue.budgets.gpu.used} / {queue.budgets.gpu.total}</span>
      <span class="text-xs text-on-surface-muted">{queue.budgets.gpu.note}</span>
    </div>
    <span class="text-[10px] font-ui px-1.5 py-0.5 rounded bg-warning/15 text-warning" title="The scheduler's real queue isn't wired yet">
      sample data
    </span>
    <div class="flex-1"></div>
    <div class="flex items-center gap-1">
      <button
        onclick={() => { mode = "lane"; }}
        class="text-xs font-ui px-2 py-1 rounded cursor-pointer transition-colors
          {mode === 'lane' ? 'bg-primary text-on-primary' : 'text-on-surface-secondary hover:bg-surface'}"
      >By lane</button>
      <button
        onclick={() => { mode = "article"; }}
        class="text-xs font-ui px-2 py-1 rounded cursor-pointer transition-colors
          {mode === 'article' ? 'bg-primary text-on-primary' : 'text-on-surface-secondary hover:bg-surface'}"
      >By article</button>
    </div>
  </div>

  <div class="flex-1 overflow-auto px-6 py-4 space-y-6">
    <!-- Dry-run preview -->
    <section class="rounded-lg border border-success/40 bg-success/5 px-4 py-3">
      <div class="text-xs font-ui font-medium text-on-surface-secondary uppercase tracking-wide mb-1">
        Tonight's run (dry run)
      </div>
      {#if dryRunJobs.length === 0}
        <p class="text-sm text-on-surface-muted">Nothing fits tonight's budgets.</p>
      {:else}
        <ul class="text-sm text-on-surface flex flex-wrap gap-x-4 gap-y-0.5">
          {#each dryRunJobs as j}
            <li>
              <span class="text-[10px] font-ui text-primary uppercase">{LANE_LABEL[j.lane]}</span>
              <span class="uppercase text-xs font-ui text-on-surface-secondary">{j.type}</span>
              {j.target.label}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    {#if mode === "lane"}
      <!-- Claude lane -->
      <section class="space-y-2">
        <h3 class="text-sm font-medium text-on-surface flex items-baseline gap-2">
          {LANE_LABEL.claude} lane
          <span class="text-xs font-ui text-on-surface-muted">tokens - prioritised by value</span>
        </h3>
        {#each claudeJobs as job (job.id)}
          <ScheduleJobCard {job} willRun={willRun.has(job.id)} />
        {/each}
      </section>
      <!-- GPU lane -->
      <section class="space-y-2">
        <h3 class="text-sm font-medium text-on-surface flex items-baseline gap-2">
          {LANE_LABEL.gpu} lane
          <span class="text-xs font-ui text-on-surface-muted">GPU time - prioritised by value</span>
        </h3>
        {#each gpuJobs as job (job.id)}
          <ScheduleJobCard {job} willRun={willRun.has(job.id)} />
        {/each}
      </section>
      <!-- Review lane: records awaiting human review, ranked by demand -->
      <section class="space-y-2">
        <h3 class="text-sm font-medium text-on-surface flex items-baseline gap-2">
          Review lane
          <span class="text-xs font-ui text-on-surface-muted">human review time - what to review next, by demand</span>
        </h3>
        {#each reviewItems as item}
          {@render reviewRow(item)}
        {/each}
      </section>
      <!-- Eager background: minimised, not a competing lane -->
      {#if eagerJobs.length > 0}
        <p class="text-xs text-on-surface-muted">
          Background (eager, runs automatically): {eagerJobs.map((j) => j.type).join(", ")}
        </p>
      {/if}
    {:else}
      <!-- By article: each page's "what's next" chain, in stage order -->
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
  </div>
</div>
