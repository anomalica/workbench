<script lang="ts">
  import {
    SAMPLE_QUEUE,
    LANE_LABEL,
    stageRank,
    type ScheduleJob,
    type ReviewItem,
  } from "$lib/schedule";
  import ScheduleJobCard from "./ScheduleJobCard.svelte";

  // ILLUSTRATIVE placeholder - the real prioritised queue comes from the
  // assimilator's scheduler (not wired yet). See schedule.ts.
  const queue = SAMPLE_QUEUE;

  // Top-level tabs: one per resource lane, plus the per-article "what's next".
  let tab = $state<"claude" | "gpu" | "review" | "article">("claude");

  const NONE = "Not tied to one page";

  let claudeJobs = $derived(
    queue.jobs.filter((j) => j.lane === "claude").sort((a, b) => stageRank(a.type) - stageRank(b.type)),
  );
  let gpuJobs = $derived(queue.jobs.filter((j) => j.lane === "gpu"));
  let eagerJobs = $derived(queue.jobs.filter((j) => j.lane === "eager"));
  let reviewItems = $derived(
    [...queue.reviewQueue].sort((a, b) => (b.demand ?? -1) - (a.demand ?? -1)),
  );

  let byArticle = $derived.by<[string, ScheduleJob[]][]>(() => {
    const groups = new Map<string, ScheduleJob[]>();
    for (const j of queue.jobs) {
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

  function nextId(jobs: ScheduleJob[]): string | null {
    return jobs[0]?.id ?? null;
  }

  const TABS: { id: typeof tab; label: string }[] = [
    { id: "claude", label: "Claude" },
    { id: "gpu", label: "GPU" },
    { id: "review", label: "Review" },
    { id: "article", label: "By article" },
  ];
</script>

{#snippet reviewRow(item: ReviewItem)}
  <div class="rounded-md border border-border bg-surface px-3 py-2 text-sm flex items-baseline gap-2 flex-wrap">
    {#if item.demand !== undefined}
      <span class="text-xs font-ui font-medium tabular-nums text-warning w-12 flex-none" title="demand (placeholder until the scheduler computes it)">
        d {item.demand}
      </span>
    {/if}
    {#if item.target.href}
      <a href={item.target.href} class="text-primary hover:underline">{item.target.label}</a>
    {:else}
      <span class="text-on-surface">{item.target.label}</span>
    {/if}
    {#if item.target.hash}
      <span class="text-[10px] font-mono text-on-surface-muted" title="record content hash">{item.target.hash.slice(0, 12)}</span>
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
  </div>

  <!-- Honest framing: this is illustrative, the real queue is the scheduler's -->
  <div class="px-6 py-2 border-b border-border/60 flex-none text-xs font-ui text-on-surface-muted">
    Illustrative placeholder. The real prioritised queue - every job, with priorities, effort and
    drivers - comes from the scheduler, which isn't wired yet. Names and ordering here are examples,
    not real data. The pipeline runs on the Claude token quota (no dollar costs).
  </div>

  <div class="flex-1 overflow-auto px-6 py-4 space-y-4">
    {#if tab === "claude"}
      <h3 class="text-sm font-medium text-on-surface flex items-baseline gap-2">
        {LANE_LABEL.claude} lane <span class="text-xs font-ui text-on-surface-muted">tokens - the scarce-budget queue</span>
      </h3>
      {#each claudeJobs as job (job.id)}<ScheduleJobCard {job} />{/each}
    {:else if tab === "gpu"}
      <h3 class="text-sm font-medium text-on-surface flex items-baseline gap-2">
        {LANE_LABEL.gpu} lane <span class="text-xs font-ui text-on-surface-muted">GPU time - one transcription job per queued video</span>
      </h3>
      {#each gpuJobs as job (job.id)}<ScheduleJobCard {job} />{/each}
    {:else if tab === "review"}
      <h3 class="text-sm font-medium text-on-surface flex items-baseline gap-2">
        Review lane <span class="text-xs font-ui text-on-surface-muted">human review time - what to review next, by demand</span>
      </h3>
      {#each reviewItems as item}{@render reviewRow(item)}{/each}
    {:else}
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
              <div class="flex-1 min-w-0"><ScheduleJobCard {job} /></div>
            </div>
          {/each}
        </section>
      {/each}
    {/if}

    {#if eagerJobs.length > 0}
      <p class="text-xs text-on-surface-muted pt-2 border-t border-border/40">
        Background (eager, runs automatically, not a scheduled lane): {eagerJobs.map((j) => j.type).join(", ")}
      </p>
    {/if}
  </div>
</div>
