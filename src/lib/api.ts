import { createSHA256 } from "hash-wasm";
import type { ReviewCarryover } from "./carryover";
import type { ScheduleQueue } from "./schedule";

export type CopyrightStatus =
  | "public_domain"
  | "open_licence"
  | "publicly_accessible"
  | "licensed"
  | "restricted";

export interface IngestSummary {
  content_hash: string;
  public_hash: string;
  title: string;
  /** Spec field `creators` (was `authors`); UI labels it "Authors / Creators". */
  creators: string[];
  /** date_published from frontmatter. */
  date: string;
  /** date_extracted (falls back to date_accessed) - when ingestion ran. */
  date_ingested: string;
  source_type: string;
  source_url: string;
  /** Local-file origin filename (PDFs ingested from disk). */
  source_file: string;
  /** "unknown" when the acquisition origin is unrecoverable. */
  provenance: string;
  publisher: string;
  copyright_status: CopyrightStatus;
  /** True when a reviewer has observed 100% of the record's content units
   *  (the digester gate's rule). See observed_coverage for the fraction. */
  digestible: boolean;
  /** Observed fraction (0..1) of the record's content units. */
  observed_coverage: number;
  /** True when a digest has been built for this record. */
  digested: boolean;
  /** Present when the ingester carried a prior review onto this re-ingested
   *  record; null/absent otherwise. */
  review_carryover?: ReviewCarryover | null;
}

/** Whether a record's copyright status allows free public viewing (vs gated
 *  licensed/restricted material). Drives the compact "Public" list column. */
export function isPubliclyViewable(status: CopyrightStatus): boolean {
  return (
    status === "public_domain" || status === "open_licence" || status === "publicly_accessible"
  );
}

export type ProvenanceKind = "url" | "file" | "unknown" | "none";

/** Where a record came from, derived from its acquisition fields. `traceable`
 *  is false for records whose origin is unknown or absent - the ones worth
 *  flagging when browsing. Works on an IngestSummary or a frontmatter dict. */
export function provenanceOf(r: {
  source_url?: string;
  source_file?: string;
  provenance?: string;
}): { kind: ProvenanceKind; label: string; traceable: boolean } {
  if (r.source_url) return { kind: "url", label: r.source_url, traceable: true };
  if (r.source_file) return { kind: "file", label: r.source_file, traceable: true };
  if (r.provenance === "unknown")
    return { kind: "unknown", label: "Origin unknown", traceable: false };
  return { kind: "none", label: "No source recorded", traceable: false };
}

export interface IngestDetail {
  content_hash: string;
  public_hash: string;
  copyright_status: CopyrightStatus;
  creators: string[];
  frontmatter: Record<string, string>;
  raw_frontmatter: string;
  body: string;
}

export async function fetchIngests(): Promise<IngestSummary[]> {
  const res = await fetch("/api/ingests");
  if (!res.ok) throw new Error(`Failed to fetch ingests: ${res.status}`);
  return res.json();
}

export async function fetchIngest(hash: string): Promise<IngestDetail> {
  const res = await fetch(`/api/ingests/${hash}`);
  if (!res.ok) throw new Error(`Failed to fetch ingest: ${res.status}`);
  return res.json();
}

/** Digest interchange format (schema: anomalica/digest/1).
 *  See architecture/digest-format.md and decision 0027 in the meta-repo. */
export interface DigestRef {
  id?: string;
  name: string;
}

export interface DigestNode {
  id: string;
  type: string;
  name: string;
  metadata?: Record<string, unknown>;
}

export interface DigestClaim {
  id: string;
  type: string;
  attestation?: string;
  speaker?: DigestRef;
  location?: string;
  date?: string;
  date_range?: [string, string];
  refs?: DigestRef[];
  quote?: string;
  text: string;
}

export interface DigestDocument {
  schema: string;
  extracted_at: string;
  model: string;
  record: {
    id: string;
    title?: string;
    producer?: string;
    date?: string;
    reference?: string | null;
  };
  nodes: DigestNode[];
  domain_claims?: DigestClaim[];
  infrastructure_claims?: DigestClaim[];
}

/** Fetch the digester's YAML output for an ingest. Returns null if no digest
 *  has been produced for this record yet (404). */
export async function fetchDigest(hash: string): Promise<DigestDocument | null> {
  const res = await fetch(`/api/ingests/${hash}/digest`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch digest: ${res.status}`);
  return res.json();
}

/** Check whether an ingest exists for a given full hash. */
export async function ingestExists(fullHash: string): Promise<boolean> {
  const res = await fetch(`/api/ingests/${fullHash}`);
  return res.ok;
}

/** Submit a review: save changes and commit with reviewer identity.
 *  Optional spans are coverage assertions over the body's line indices,
 *  appended to the record's review-coverage sidecar. */
export async function submitReview(
  fullHash: string,
  content: string,
  notes: string,
  spans?: KindedSpan[],
  verdict?: { observed_coverage: number; digestible: boolean; total_units: number },
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/api/ingests/${fullHash}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content,
      notes,
      ...(spans && spans.length > 0 ? { spans } : {}),
      ...(verdict ? { verdict } : {}),
    }),
  });
  if (res.ok) return { ok: true };
  const data = await res.json().catch(() => ({}));
  return { ok: false, error: data.detail || `Error ${res.status}` };
}

import type { KindedSpan, CoverageReview } from "$lib/coverage";

/** Fetch all reviewers' coverage entries for a record. Empty when no
 *  coverage has been recorded yet. */
export async function fetchCoverage(hash: string): Promise<CoverageReview[]> {
  const res = await fetch(`/api/ingests/${hash}/coverage`);
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data?.reviews) ? data.reviews : [];
}

export interface User {
  name: string;
  email: string;
  login: string;
  avatar_url: string;
}

export async function fetchCurrentUser(): Promise<User | null> {
  const res = await fetch("/api/auth/me");
  if (!res.ok) return null;
  const data = await res.json();
  return data.user || null;
}

export async function hashFile(file: File): Promise<string> {
  // Stream the file through an incremental SHA-256 in chunks. The old
  // file.arrayBuffer() + crypto.subtle.digest loaded the whole file into
  // memory at once, which crashed the tab on multi-GB videos. WebCrypto has no
  // streaming digest, so we use hash-wasm. Still hashed locally, never uploaded.
  const hasher = await createSHA256();
  hasher.init();
  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) hasher.update(value);
  }
  return hasher.digest("hex");
}

/** Fetch a map of {content_hash: latest_review_iso} for the current user.
 *  Empty when not logged in. */
export async function fetchReviewedHashes(): Promise<Record<string, string>> {
  const res = await fetch("/api/me/reviews");
  if (!res.ok) return {};
  const data = await res.json().catch(() => ({}));
  const reviewed = data?.reviewed;
  if (reviewed && typeof reviewed === "object" && !Array.isArray(reviewed)) {
    return reviewed as Record<string, string>;
  }
  return {};
}

// --- Knowledge graph (read-only view over the assimilator's merged graph) ---

export interface GraphStats {
  total_nodes: number;
  total_claims: number;
  total_merges: number;
  total_records: number;
  total_corroborations: number;
  by_type: { type: string; count: number }[];
}

export interface GraphNodeSummary {
  id: string;
  name: string;
  node_type: string;
  /** Surface forms the matcher merged into this node - the merge decisions. */
  alias_count: number;
  claim_count: number;
}

/** A reference to another entity (node), followable to its own node view. */
export interface NodeRef {
  id: string;
  name: string;
  node_type: string;
}

export interface GraphClaim {
  id: string;
  content: string;
  claim_type: string;
  attestation?: string;
  excerpt?: string;
  location?: string;
  claim_role?: string;
  record_id?: string;
  record_title: string;
  /** Other entities this claim references (claim_node_refs, minus this node). */
  corefs?: NodeRef[];
  /** The claim's speaker (a node), if any. */
  speaker?: NodeRef | null;
  /** The producer of the claim's source record (a node), if any. */
  record_producer?: NodeRef | null;
}

export interface GraphNodeDetail {
  id: string;
  name: string;
  node_type: string;
  /** The merge decisions: every other name resolved into this entity. */
  aliases: string[];
  claim_count: number;
  claims_truncated: boolean;
  claims: GraphClaim[];
}

/** Graph totals + node breakdown by type. Null when the assimilator DB isn't
 *  available (503), so the view can show an unavailable state. */
export async function fetchGraphStats(): Promise<GraphStats | null> {
  const res = await fetch("/api/graph/stats");
  if (res.status === 503) return null;
  if (!res.ok) throw new Error(`Failed to fetch graph stats: ${res.status}`);
  return res.json();
}

/** Browse/search entities, optionally filtered by type. */
export async function fetchGraphNodes(type?: string, q?: string): Promise<GraphNodeSummary[]> {
  const params = new URLSearchParams();
  if (type) params.set("type", type);
  if (q) params.set("q", q);
  const res = await fetch(`/api/graph/nodes?${params.toString()}`);
  if (res.status === 503) return [];
  if (!res.ok) throw new Error(`Failed to fetch graph nodes: ${res.status}`);
  return res.json();
}

/** An entity with its merge decisions (aliases) and referencing claims. Null
 *  if the node id is unknown (404). */
// --- Graph curation (merge duplicate entities) ------------------------------

export interface MergeMember {
  id: string;
  name: string;
  node_type: string;
  claims: number;
}

export interface MergeCandidate {
  node_ids: string[];
  suggested_canonical: string;
  score: number;
  node_type: string;
  reason: "name-equiv" | "name-equiv-crosstype" | "fuzzy" | "embedding";
  members: MergeMember[];
}

export interface ActiveMerge {
  merge_id: string;
  survivor_id: string;
  survivor_name: string;
  canonical_name: string;
  created_at: string;
  victims: { id: string; prior_name: string }[];
}

export async function fetchMergeCandidates(): Promise<MergeCandidate[]> {
  const res = await fetch("/api/curation/candidates");
  if (!res.ok) throw new Error(`Failed to fetch candidates: ${res.status}`);
  return (await res.json()).candidates;
}

export async function fetchActiveMerges(): Promise<ActiveMerge[]> {
  const res = await fetch("/api/curation/merges");
  if (!res.ok) throw new Error(`Failed to fetch merges: ${res.status}`);
  return (await res.json()).merges;
}

/** Apply a merge (writes the live graph via the assimilator). Throws on failure. */
export async function applyMerge(
  survivor_id: string,
  victim_ids: string[],
  canonical_name: string,
): Promise<void> {
  const res = await fetch("/api/curation/merge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ survivor_id, victim_ids, canonical_name }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `Merge failed (${res.status})`);
  }
}

/** Record a durable 'not a duplicate' rejection for a candidate cluster. */
export async function rejectCandidate(node_ids: string[]): Promise<void> {
  const res = await fetch("/api/curation/reject", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_ids }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `Reject failed (${res.status})`);
  }
}

/** Reverse a merge by its merge_id. Throws on failure. */
export async function undoMerge(merge_id: string): Promise<void> {
  const res = await fetch("/api/curation/unmerge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ merge_id }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `Un-merge failed (${res.status})`);
  }
}

export async function fetchGraphNode(id: string): Promise<GraphNodeDetail | null> {
  const res = await fetch(`/api/graph/nodes/${encodeURIComponent(id)}`);
  if (res.status === 404 || res.status === 503) return null;
  if (!res.ok) throw new Error(`Failed to fetch graph node: ${res.status}`);
  return res.json();
}

// --- Schedule (the assimilator scheduler's prioritised work queue) ----------

/** Fetch the scheduler's prioritised queue. The backend returns an empty queue
 *  ({jobs:[], reviewQueue:[], recordDemand:{}}) when no run has emitted yet. */
export async function fetchSchedule(): Promise<ScheduleQueue> {
  const res = await fetch("/api/schedule");
  if (!res.ok) throw new Error(`Failed to fetch schedule: ${res.status}`);
  return res.json();
}

// --- Runner / processing mode -----------------------------------------------

export interface ProcessingWindow {
  util: number;
  ideal: number;
  below: boolean;
}

export interface ProcessingCompleted {
  type: string;
  target: string;
  start: string;
  end: string;
  duration_s: number;
  tokens: number | null;
  ok: boolean;
  error?: string | null;
}

export interface ProcessingStatus {
  mode: "on" | "off";
  /** idle | waiting | ready | running | halted */
  state: string;
  /** true when the worker has stopped itself (fail-closed); clears on an off->on toggle */
  halted: boolean;
  /** trend-line margin: dispatch only when usage is this many points under the ideal line */
  margin: number;
  reason: string;
  gate: { five_hour: ProcessingWindow; seven_day: ProcessingWindow } | null;
  /** fresh | stale | unavailable */
  usage_status: string | null;
  current: { type: string; target: string; hash?: string; started?: string } | null;
  checked_at: string | null;
  completed: ProcessingCompleted[];
}

export async function fetchProcessing(): Promise<ProcessingStatus> {
  const res = await fetch("/api/processing");
  if (!res.ok) throw new Error(`Failed to fetch processing: ${res.status}`);
  return res.json();
}

/** {content_hash -> {title, source_url}} for un-ingested sources (from v1 records),
 *  so the schedule view can show a transcription job's title + source link. */
export async function fetchIngestTitles(): Promise<
  Record<string, { title: string; source_url: string | null }>
> {
  const res = await fetch("/api/ingest-titles");
  if (!res.ok) throw new Error(`Failed to fetch ingest titles: ${res.status}`);
  return res.json();
}

/** Flip processing mode on/off (auth-gated server-side). */
export async function setProcessing(mode: "on" | "off"): Promise<ProcessingStatus> {
  const res = await fetch("/api/processing", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `Error ${res.status}`);
  return data;
}

/** Set the gate's trend-line margin (percentage points under the ideal line). */
export async function setProcessingMargin(margin: number): Promise<ProcessingStatus> {
  const res = await fetch("/api/processing/margin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ margin }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `Error ${res.status}`);
  return data;
}
