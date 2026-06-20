/**
 * Schedule view types + a PROVISIONAL sample queue.
 *
 * This is the read-only "outcome surface" of the prioritisation system the
 * assimilator's scheduler is building (design: anomalica/master/.ai/specs/
 * scheduling-prioritisation-design.md). The scheduler OWNS the real queue
 * contract; these types are a plausible shape to build the shell against and
 * MUST be reconciled with the scheduler's actual output before wiring - do not
 * treat them as final.
 *
 * Two lanes (per Mark's 2026-06-20 refinement): `local` is free and runs
 * eagerly (barely scheduled - shown lightly); `claude` is the scarce-budget
 * prioritised queue - the real focus. Drivers are per-job-specific, not one
 * uniform four-pill formula, so a job carries only the drivers that rank it.
 */

export type ScheduleLane = "local" | "claude";

export type JobStatus =
  | "eligible" // ready to run
  | "blocked" // an upstream job is queued/running (blocker named)
  | "readiness_gated" // target not review-ready -> routed to the review backlog
  | "awaiting_approval"; // metered spend, waiting on a cost estimate + yes

/** Staleness band drives a chip colour; "off" greys a not-yet-pinned factor. */
export type DriverBand = "urgent" | "normal" | "sub" | "off";

export interface ScheduleDriver {
  label: string; // "demand", "staleness", "reach", "evidence", "source priority"...
  value: string; // "12 dead links", "30%", "fanout 4", "off until scoring pinned"
  band?: DriverBand;
}

export interface ScheduleTarget {
  kind: "record" | "page";
  label: string; // friendly name (record) or page slug
  hash?: string; // full content hash for record targets
  /** Resolved in-app deep link, or null when there's no destination yet. */
  href?: string | null;
}

export interface ScheduleJob {
  id: string;
  type: string; // "ingest" | "digest" | "corroborate" | "synthesise" | "assemble" | "translate" | "verify" | "import" | "re-score"
  lane: ScheduleLane;
  effort: string; // "~8k tokens", "~12 GPU-min", "light"
  dollars?: string | null; // "$0.40" when the lane is on the metered API; null on subscription
  target: ScheduleTarget;
  /** The page/article this job advances, for the per-article "what's next"
   *  grouping. Absent for jobs not tied to one page (a new source, a merge). */
  article?: string;
  value: number | null; // VALUE score; null for eager local jobs (no priority)
  drivers: ScheduleDriver[];
  fitsBudget: boolean; // would tonight's lane budget admit it
  status: JobStatus;
  blocker?: string; // the named upstream when status === "blocked"
  trigger: string; // "never done" | "stale 30%" | "logic v2" | "on demand"
}

export interface ReviewBacklogItem {
  target: ScheduleTarget;
  reason: string; // why demand routed here (e.g. "2 of 3 sources not yet reviewed")
  href?: string | null;
}

export interface ScheduleQueue {
  generatedAt: string | null;
  claudeBudget: { used: string; total: string; note?: string };
  jobs: ScheduleJob[];
  reviewBacklog: ReviewBacklogItem[];
  /** Ids of the jobs tonight's budgets would actually execute (dry run). */
  dryRunRunIds: string[];
}

/** Pipeline order, for sorting a single article's jobs into "what's next". */
export const STAGE_ORDER = [
  "ingest",
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
  local: "Local",
  claude: "Claude",
};

// --- PROVISIONAL sample queue (replace with the scheduler's real output) ----
// Spans every lane, status, trigger and driver band so the shell renders all
// states. Built around a few articles so the per-article view is exercised.

export const SAMPLE_QUEUE: ScheduleQueue = {
  generatedAt: null,
  claudeBudget: { used: "120k", total: "500k", note: "tonight's Claude token budget" },
  jobs: [
    // --- Article: "Nimitz UAP incident" - a chain mid-flight ---
    {
      id: "j1",
      type: "digest",
      lane: "claude",
      effort: "~9k tokens",
      target: { kind: "record", label: "Nimitz CSG-11 AAV Incident Report", hash: "n1", href: "/" },
      article: "The Nimitz UAP incident",
      value: 8.4,
      drivers: [
        { label: "demand", value: "14 dead links" },
        { label: "readiness", value: "reviewed", band: "normal" },
      ],
      fitsBudget: true,
      status: "eligible",
      trigger: "never done",
    },
    {
      id: "j2",
      type: "assemble",
      lane: "claude",
      effort: "~15k tokens",
      target: { kind: "page", label: "the-nimitz-uap-incident", href: null },
      article: "The Nimitz UAP incident",
      value: 7.1,
      drivers: [
        { label: "demand", value: "high" },
        { label: "staleness", value: "30%", band: "normal" },
        { label: "reach", value: "fanout 4" },
      ],
      fitsBudget: true,
      status: "blocked",
      blocker: "digest (Nimitz CSG-11 AAV Incident Report)",
      trigger: "stale 30%",
    },
    {
      id: "j3",
      type: "verify",
      lane: "claude",
      effort: "~6k tokens",
      dollars: "$0.45",
      target: { kind: "page", label: "the-nimitz-uap-incident", href: null },
      article: "The Nimitz UAP incident",
      value: 3.2,
      drivers: [{ label: "follows", value: "assemble" }],
      fitsBudget: true,
      status: "awaiting_approval",
      trigger: "logic v2",
    },
    // --- Article: "Project Stargate" - readiness-gated ---
    {
      id: "j4",
      type: "assemble",
      lane: "claude",
      effort: "~14k tokens",
      target: { kind: "page", label: "project-stargate", href: null },
      article: "Project Stargate",
      value: 6.0,
      drivers: [
        { label: "demand", value: "9 dead links" },
        { label: "staleness", value: "never done", band: "urgent" },
        { label: "reach", value: "fanout 2" },
      ],
      fitsBudget: false,
      status: "readiness_gated",
      trigger: "never done",
    },
    {
      id: "j5",
      type: "corroborate",
      lane: "claude",
      effort: "~11k tokens",
      target: { kind: "page", label: "(graph-wide)", href: null },
      value: 5.5,
      drivers: [{ label: "pending duplicates", value: "23 claim pairs" }],
      fitsBudget: true,
      status: "eligible",
      trigger: "logic v2",
    },
    {
      id: "j6",
      type: "synthesise",
      lane: "claude",
      effort: "~12k tokens",
      target: { kind: "page", label: "tic-tac-encounters (proposed)", href: null },
      article: "Tic-Tac encounters",
      value: 4.8,
      drivers: [{ label: "demand", value: "missing page" }],
      fitsBudget: true,
      status: "eligible",
      trigger: "on demand",
    },
    {
      id: "j7",
      type: "translate",
      lane: "claude",
      effort: "~7k tokens",
      target: { kind: "page", label: "the-nimitz-uap-incident (ja)", href: null },
      article: "The Nimitz UAP incident",
      value: 2.1,
      drivers: [{ label: "languages", value: "ja wanted" }],
      fitsBudget: false,
      status: "blocked",
      blocker: "assemble (the-nimitz-uap-incident)",
      trigger: "on demand",
    },
    // --- Local lane (eager, no priority) ---
    {
      id: "j8",
      type: "ingest",
      lane: "local",
      effort: "~12 GPU-min",
      target: { kind: "record", label: "Lex Fridman #441 (queued source)", href: null },
      value: null,
      drivers: [{ label: "source priority", value: "high (Area52)" }],
      fitsBudget: true,
      status: "eligible",
      trigger: "on demand",
    },
    {
      id: "j9",
      type: "import",
      lane: "local",
      effort: "light",
      target: { kind: "record", label: "Bob Lazar - DEBRIEFED ep. 87", hash: "b1", href: "/" },
      value: null,
      drivers: [],
      fitsBudget: true,
      status: "eligible",
      trigger: "logic v2",
    },
    {
      id: "j10",
      type: "re-score",
      lane: "local",
      effort: "light",
      target: { kind: "page", label: "(all pages)", href: null },
      value: null,
      drivers: [{ label: "priority", value: "eager (neutral)" }],
      fitsBudget: true,
      status: "eligible",
      trigger: "logic v2",
    },
  ],
  reviewBacklog: [
    {
      target: { kind: "page", label: "project-stargate", href: null },
      reason: "2 of 3 brief sources not yet reviewed - assemble is readiness-gated",
      href: "/",
    },
    {
      target: { kind: "record", label: "CIA Stargate memo (1995)", href: "/" },
      reason: "demand for digest, but the record isn't reviewed yet",
      href: "/",
    },
  ],
  dryRunRunIds: ["j1", "j5", "j6"],
};
