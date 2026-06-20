<script lang="ts">
  import type { ScheduleJob } from "$lib/schedule";
  import { LANE_LABEL } from "$lib/schedule";

  let { job, willRun = false }: { job: ScheduleJob; willRun?: boolean } = $props();

  const STATUS: Record<string, { label: string; cls: string }> = {
    eligible: { label: "Eligible", cls: "bg-success/15 text-success" },
    blocked: { label: "Blocked", cls: "bg-on-surface-muted/15 text-on-surface-secondary" },
    readiness_gated: { label: "Review-gated", cls: "bg-warning/20 text-warning" },
    awaiting_approval: { label: "Needs $ approval", cls: "bg-accent/15 text-accent" },
  };

  function bandCls(band?: string): string {
    if (band === "urgent") return "bg-error/15 text-error";
    if (band === "normal") return "bg-warning/20 text-warning";
    if (band === "sub") return "bg-on-surface-muted/15 text-on-surface-muted";
    if (band === "off") return "bg-on-surface-muted/10 text-on-surface-muted/60 italic";
    return "bg-surface text-on-surface-secondary border border-border";
  }

  let status = $derived(STATUS[job.status] ?? STATUS.eligible);
</script>

<div class="rounded-md border border-border bg-surface px-3 py-2.5 text-sm">
  <!-- Header: type + lane/effort + dollars + status -->
  <div class="flex items-center gap-2 flex-wrap">
    <span class="font-medium text-on-surface uppercase tracking-wide text-xs">{job.type}</span>
    <span class="text-[10px] font-ui px-1.5 py-0.5 rounded bg-primary/10 text-primary">
      {LANE_LABEL[job.lane]} &middot; {job.effort}
    </span>
    {#if job.dollars}
      <span class="text-[10px] font-ui px-1.5 py-0.5 rounded bg-accent/15 text-accent font-medium" title="Metered API - bills real money">
        {job.dollars}
      </span>
    {/if}
    {#if willRun}
      <span class="text-[10px] font-ui px-1.5 py-0.5 rounded bg-success/15 text-success" title="Tonight's budget would run this">
        runs tonight
      </span>
    {/if}
    <span class="flex-1"></span>
    {#if job.value !== null}
      <span class="text-xs font-ui text-on-surface-secondary tabular-nums" title="VALUE score">
        value {job.value.toFixed(1)}
      </span>
    {/if}
    <span class="text-[10px] font-ui px-1.5 py-0.5 rounded font-medium {status.cls}">{status.label}</span>
  </div>

  <!-- Target (record hash + friendly name, or page slug); deep link where there's one -->
  <div class="mt-1.5 text-on-surface flex items-baseline gap-2 flex-wrap">
    {#if job.target.href}
      <a href={job.target.href} class="text-primary hover:underline">{job.target.label}</a>
    {:else}
      <span>{job.target.label}</span>
    {/if}
    {#if job.target.kind === "record" && job.target.hash}
      <span class="text-[10px] font-mono text-on-surface-muted" title="record content hash">
        {job.target.hash.slice(0, 12)}
      </span>
    {/if}
  </div>

  <!-- Driver chips (per-job-specific) -->
  {#if job.drivers.length > 0}
    <div class="mt-1.5 flex flex-wrap gap-1">
      {#each job.drivers as d}
        <span class="text-[11px] font-ui px-1.5 py-0.5 rounded {bandCls(d.band)}">
          {d.label}: {d.value}
        </span>
      {/each}
    </div>
  {/if}

  <!-- Status detail + budget fit + trigger -->
  <div class="mt-1.5 flex items-center gap-x-3 gap-y-1 flex-wrap text-[11px] font-ui text-on-surface-muted">
    {#if job.status === "blocked" && job.blocker}
      <span class="text-on-surface-secondary">waiting on <span class="text-on-surface">{job.blocker}</span></span>
    {/if}
    {#if job.status === "readiness_gated"}
      <a href="#review-backlog" class="text-warning hover:underline">in review backlog</a>
    {/if}
    {#if job.status === "awaiting_approval"}
      <span class="text-accent">cost estimate + approval required</span>
    {/if}
    {#if job.value !== null}
      <span class={job.fitsBudget ? "text-on-surface-secondary" : "text-on-surface-muted"}>
        {job.fitsBudget ? "fits tonight's budget" : "over tonight's budget"}
      </span>
    {/if}
    <span class="ml-auto">trigger: {job.trigger}</span>
  </div>
</div>
