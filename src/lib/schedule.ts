/**
 * Schedule view types + an ILLUSTRATIVE placeholder queue.
 *
 * Read-only "outcome surface" of the prioritisation system the assimilator's
 * scheduler is building (design: anomalica/master/.ai/specs/
 * scheduling-prioritisation-design.md). The scheduler OWNS the real queue and
 * is the only source of the real comprehensive job list, priorities, effort and
 * drivers - this module is a thin PLACEHOLDER so the layout is reviewable, and
 * is wired to the scheduler's real output when it publishes.
 *
 * It must stay HONEST: it does NOT fabricate dollar costs, run-times, token
 * budgets, scores or a nightly runner (none exist yet). The pipeline runs on the
 * Claude SUBSCRIPTION - a TOKEN quota, not dollars; the metered/dollar path is
 * off by default and handled elsewhere, never shown here. value/effort/drivers
 * are optional and rendered only when the real scheduler supplies them.
 *
 * Three lanes by SCARCE RESOURCE: `claude` (tokens) + `gpu` (GPU time) machine
 * job queues; `review` = records awaiting human review, ranked by DEMAND. Light
 * plumbing (import / re-score) is eager background, lane `eager`, not a lane.
 */

export type ScheduleLane = "claude" | "gpu" | "eager";

export type JobStatus =
  | "eligible" // ready to run
  | "blocked" // an upstream job is queued/running (blocker named)
  | "readiness_gated"; // target not review-ready (its review sits in the Review lane)

export type DriverBand = "urgent" | "normal" | "sub" | "off";

export interface ScheduleDriver {
  label: string;
  value: string;
  band?: DriverBand;
}

export interface ScheduleTarget {
  kind: "record" | "page";
  label: string;
  hash?: string;
  href?: string | null;
}

export interface ScheduleJob {
  id: string;
  type: string;
  lane: ScheduleLane;
  target: ScheduleTarget;
  article?: string;
  status: JobStatus;
  blocker?: string; // named upstream when status === "blocked"
  trigger?: string; // qualitative reason: never done / stale / logic version bump / on demand
  // Real-scheduler fields - rendered only when present. The placeholder leaves
  // them unset rather than inventing scores, effort or driver metrics.
  value?: number | null;
  effort?: string;
  drivers?: ScheduleDriver[];
}

/** A record (later: an assembled article) awaiting human review - the Review
 *  lane. The scheduler's per-record demand ranks it (placeholder for now). */
export interface ReviewItem {
  target: ScheduleTarget;
  demand?: number; // scheduler's per-record priority; unset = unranked placeholder
  reason?: string;
}

export interface ScheduleQueue {
  generatedAt: string | null;
  jobs: ScheduleJob[];
  reviewQueue: ReviewItem[];
}

export const STAGE_ORDER = [
  "ingest",
  "re-ingest",
  "import",
  "re-score",
  "digest",
  "corroborate",
  "synthesise",
  "assemble",
  "translate",
  "verify",
];

export function stageRank(type: string): number {
  const i = STAGE_ORDER.indexOf(type);
  return i === -1 ? STAGE_ORDER.length : i;
}

export const LANE_LABEL: Record<ScheduleLane, string> = {
  claude: "Claude",
  gpu: "GPU",
  eager: "Background",
};

/**
 * PLACEHOLDER per-record demand (0-99), until the scheduler computes the real
 * per-record priority. Deterministic from the content hash so the Records "sort
 * by demand" produces a stable order; clearly flagged illustrative in the UI.
 */
export function recordDemand(contentHash: string): number {
  let h = 0;
  for (let i = 0; i < contentHash.length; i++) {
    h = (h * 31 + contentHash.charCodeAt(i)) >>> 0;
  }
  return h % 100;
}

// --- ILLUSTRATIVE placeholder (generic targets, no fabricated metrics) ------
// Shows the SHAPE of each lane. The real comprehensive, prioritised list comes
// from the scheduler; this is replaced wholesale when it's wired.

export const SAMPLE_QUEUE: ScheduleQueue = {
  generatedAt: null,
  jobs: [
    // Claude lane - one of each job type, generic targets, no fake scores.
    {
      id: "j1",
      type: "digest",
      lane: "claude",
      target: { kind: "record", label: "(a reviewed record)", href: null },
      article: "Example article A",
      status: "eligible",
      trigger: "never done",
    },
    {
      id: "j2",
      type: "corroborate",
      lane: "claude",
      target: { kind: "page", label: "(graph-wide)", href: null },
      status: "eligible",
      trigger: "logic version bump",
    },
    {
      id: "j3",
      type: "synthesise",
      lane: "claude",
      target: { kind: "page", label: "(a proposed page)", href: null },
      article: "Example article B",
      status: "eligible",
      trigger: "on demand",
    },
    {
      id: "j4",
      type: "assemble",
      lane: "claude",
      target: { kind: "page", label: "example-article-a", href: null },
      article: "Example article A",
      status: "blocked",
      blocker: "digest (a reviewed record)",
      trigger: "stale",
    },
    {
      id: "j5",
      type: "assemble",
      lane: "claude",
      target: { kind: "page", label: "example-article-c", href: null },
      article: "Example article C",
      status: "readiness_gated",
      trigger: "never done",
    },
    {
      id: "j6",
      type: "translate",
      lane: "claude",
      target: { kind: "page", label: "example-article-a (ja)", href: null },
      article: "Example article A",
      status: "blocked",
      blocker: "assemble (example-article-a)",
      trigger: "on demand",
    },
    {
      id: "j7",
      type: "verify",
      lane: "claude",
      target: { kind: "page", label: "example-article-a", href: null },
      article: "Example article A",
      status: "blocked",
      blocker: "assemble (example-article-a)",
      trigger: "follows assemble",
    },
    // GPU lane - one transcription job PER VIDEO (however many there are).
    {
      id: "g1",
      type: "transcribe",
      lane: "gpu",
      target: { kind: "record", label: "(a queued video)", href: null },
      status: "eligible",
      trigger: "on demand",
    },
    {
      id: "g2",
      type: "transcribe",
      lane: "gpu",
      target: { kind: "record", label: "(another queued video)", href: null },
      status: "eligible",
      trigger: "on demand",
    },
    // Background (eager) - minimised, not a competing lane.
    {
      id: "e1",
      type: "import",
      lane: "eager",
      target: { kind: "record", label: "(a fresh digest)", href: null },
      status: "eligible",
    },
    {
      id: "e2",
      type: "re-score",
      lane: "eager",
      target: { kind: "page", label: "(all pages)", href: null },
      status: "eligible",
    },
  ],
  // Review lane - records awaiting human review. Unranked placeholders; the
  // scheduler's demand will order them.
  reviewQueue: [
    { target: { kind: "record", label: "(an unreviewed record)", href: null } },
    { target: { kind: "record", label: "(another unreviewed record)", href: null } },
  ],
};
