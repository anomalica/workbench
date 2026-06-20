/**
 * Schedule view types + a PROVISIONAL sample queue.
 *
 * Read-only "outcome surface" of the prioritisation system the assimilator's
 * scheduler is building (design: anomalica/master/.ai/specs/
 * scheduling-prioritisation-design.md). The scheduler OWNS the real queue
 * contract; these types are a placeholder to build the shell against and are
 * being reconciled with the assimilator - do not treat them as final.
 *
 * Three lanes by SCARCE RESOURCE (Mark, 2026-06-20, supersedes the earlier
 * Local/Claude split): `claude` (tokens) and `gpu` (GPU time) are machine job
 * queues ranked by VALUE; `review` is human review time - records awaiting
 * review, ranked by DEMAND ("what should a human review next"). Light plumbing
 * (import / re-score) is eager background, lane `eager`, not a competing lane.
 */

/** Machine job lanes; `eager` is the minimised background plumbing. */
export type ScheduleLane = "claude" | "gpu" | "eager";

export type JobStatus =
  | "eligible" // ready to run
  | "blocked" // an upstream job is queued/running (blocker named)
  | "readiness_gated" // target not review-ready (its review sits in the Review lane)
  | "awaiting_approval"; // metered spend, waiting on a cost estimate + yes

/** Staleness band drives a chip colour; "off" greys a not-yet-pinned factor. */
export type DriverBand = "urgent" | "normal" | "sub" | "off";

export interface ScheduleDriver {
  label: string;
  value: string;
  band?: DriverBand;
}

export interface ScheduleTarget {
  kind: "record" | "page";
  label: string;
  hash?: string; // full content hash for record targets
  href?: string | null; // in-app deep link, or null when there's no destination yet
}

export interface ScheduleJob {
  id: string;
  type: string;
  lane: ScheduleLane;
  effort: string;
  dollars?: string | null; // set when the lane is on the metered API
  target: ScheduleTarget;
  article?: string; // the page this job advances (per-article "what's next" grouping)
  value: number | null; // VALUE score; null for eager jobs
  drivers: ScheduleDriver[];
  fitsBudget: boolean;
  status: JobStatus;
  blocker?: string;
  trigger: string;
}

/** A record (later: an assembled article) awaiting human review - the Review
 *  lane. Ranked by demand: the scheduler's per-record priority. */
export interface ReviewItem {
  target: ScheduleTarget;
  demand: number; // scheduler's computed priority (placeholder for now)
  reason: string; // why it's wanted (e.g. "unblocks digest -> 2 pages")
}

export interface ScheduleQueue {
  generatedAt: string | null;
  budgets: {
    claude: { used: string; total: string; note?: string };
    gpu: { used: string; total: string; note?: string };
  };
  jobs: ScheduleJob[];
  reviewQueue: ReviewItem[];
  dryRunRunIds: string[]; // jobs tonight's budgets would actually execute
}

/** Pipeline order, for sorting a single article's jobs into "what's next". */
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
 * PLACEHOLDER per-record demand (0-100), until the scheduler computes the real
 * per-record priority (how much downstream work reviewing it would unblock).
 * Deterministic from the content hash so the sort is stable. Drives both the
 * Review lane and the Records "sort by demand" mode; swap for the real signal
 * from the assimilator when it lands.
 */
export function recordDemand(contentHash: string): number {
  let h = 0;
  for (let i = 0; i < contentHash.length; i++) {
    h = (h * 31 + contentHash.charCodeAt(i)) >>> 0;
  }
  return h % 100;
}

// --- PROVISIONAL sample queue (replace with the scheduler's real output) ----

export const SAMPLE_QUEUE: ScheduleQueue = {
  generatedAt: null,
  budgets: {
    claude: { used: "120k", total: "500k", note: "tokens" },
    gpu: { used: "18", total: "90", note: "GPU-min" },
  },
  jobs: [
    // --- Claude lane (token jobs, ranked by value) ---
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
    // --- GPU lane (GPU-time jobs) ---
    {
      id: "j8",
      type: "ingest",
      lane: "gpu",
      effort: "~12 GPU-min",
      target: { kind: "record", label: "Lex Fridman #441 (queued source)", href: null },
      value: 6.7,
      drivers: [{ label: "source priority", value: "high (Area52)" }],
      fitsBudget: true,
      status: "eligible",
      trigger: "on demand",
    },
    {
      id: "j11",
      type: "re-ingest",
      lane: "gpu",
      effort: "~18 GPU-min",
      target: {
        kind: "record",
        label: "The CIA's Psychic Spies (re-transcribe)",
        hash: "c2",
        href: "/",
      },
      value: 3.4,
      drivers: [{ label: "source priority", value: "medium" }],
      fitsBudget: false,
      status: "eligible",
      trigger: "logic v2",
    },
    // --- Background (eager) - minimised, not a competing lane ---
    {
      id: "j9",
      type: "import",
      lane: "eager",
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
      lane: "eager",
      effort: "light",
      target: { kind: "page", label: "(all pages)", href: null },
      value: null,
      drivers: [],
      fitsBudget: true,
      status: "eligible",
      trigger: "logic v2",
    },
  ],
  // Review lane: records awaiting human review, ranked by demand.
  reviewQueue: [
    {
      target: { kind: "record", label: "CIA Stargate memo (1995)", hash: "s9", href: "/" },
      demand: 71,
      reason: "unblocks digest -> assemble of project-stargate",
    },
    {
      target: {
        kind: "record",
        label: "AARO Historical Record Report Vol. I",
        hash: "a3",
        href: "/",
      },
      demand: 58,
      reason: "high fanout - 3 pages reference it",
    },
    {
      target: { kind: "record", label: "Grusch Congressional testimony", hash: "g4", href: "/" },
      demand: 33,
      reason: "demand for a new page, source not yet reviewed",
    },
  ],
  dryRunRunIds: ["j1", "j5", "j6", "j8"],
};
