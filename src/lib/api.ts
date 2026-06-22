import { createSHA256 } from "hash-wasm";
import type { ReviewCarryover } from "./carryover";

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

// --- Static-read mode (serverless deploy) -----------------------------------
// In the serverless deploy the READS (records, graph, curation) come from the
// pre-rendered JSON snapshot on the CDN (backend/prerender.py) - no live backend.
// The snapshot mirrors the API paths with a ".json" suffix, so a read just gains
// ".json" (and the node list, shipped whole, is filtered client-side). WRITES are
// unchanged: they POST to the same /api/* paths, served online by the edge
// function. /api/me/reviews stays dynamic (per-user) -> an edge endpoint. Off by
// default (dev hits the FastAPI backend); VITE_STATIC_READS=1 builds the static
// SPA (or tests the snapshot path locally).
export const STATIC_READS = import.meta.env.VITE_STATIC_READS === "1";

/** A read path: static-mode appends ".json" (the snapshot), else the live API. */
function readPath(apiPath: string): string {
  return STATIC_READS ? `${apiPath}.json` : apiPath;
}

export async function fetchIngests(): Promise<IngestSummary[]> {
  const res = await fetch(readPath("/api/ingests"));
  if (!res.ok) throw new Error(`Failed to fetch ingests: ${res.status}`);
  return res.json();
}

export async function fetchIngest(hash: string): Promise<IngestDetail> {
  const res = await fetch(readPath(`/api/ingests/${hash}`));
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
  const res = await fetch(readPath(`/api/ingests/${hash}/digest`));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch digest: ${res.status}`);
  return res.json();
}

/** Check whether an ingest exists for a given full hash. */
export async function ingestExists(fullHash: string): Promise<boolean> {
  const res = await fetch(readPath(`/api/ingests/${fullHash}`));
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
  const res = await fetch(readPath(`/api/ingests/${hash}/coverage`));
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data?.reviews) ? data.reviews : [];
}

export interface ReviewHistoryEntry {
  by: string;
  at: string;
  summary: string;
}

/** Every reviewer's edits to a record, newest first (the record's git history).
 *  DYNAMIC (the live edge/FastAPI), never the static snapshot - the history grows
 *  with each review, so it is not pre-rendered. Empty on any error. */
export async function fetchHistory(hash: string): Promise<ReviewHistoryEntry[]> {
  const res = await fetch(`/api/ingests/${hash}/history`);
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data?.history) ? data.history : [];
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
  /** The source record's public hash, to deep-link to it in the Records tab. */
  record_public_hash?: string | null;
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

/** Client-side equivalent of the backend list_nodes filter (name substring +
 *  exact type), used when the static snapshot ships the whole node list.
 *  Note: the static list carries no alias strings, so search is name-only
 *  (the live backend also matches aliases). */
export function filterNodes(
  nodes: GraphNodeSummary[],
  type?: string,
  q?: string,
): GraphNodeSummary[] {
  const needle = q?.trim().toLowerCase();
  return nodes.filter(
    (n) => (!type || n.node_type === type) && (!needle || n.name.toLowerCase().includes(needle)),
  );
}

/** Graph totals + node breakdown by type. Null when the graph isn't available
 *  (503 live, or 404 in static mode), so the view can show an unavailable state. */
export async function fetchGraphStats(): Promise<GraphStats | null> {
  const res = await fetch(readPath("/api/graph/stats"));
  if (res.status === 503 || res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch graph stats: ${res.status}`);
  return res.json();
}

/** Browse/search entities, optionally filtered by type. In static mode the whole
 *  list is fetched once and filtered client-side. */
export async function fetchGraphNodes(type?: string, q?: string): Promise<GraphNodeSummary[]> {
  if (STATIC_READS) {
    const res = await fetch("/api/graph/nodes.json");
    if (res.status === 503 || res.status === 404) return [];
    if (!res.ok) throw new Error(`Failed to fetch graph nodes: ${res.status}`);
    return filterNodes(await res.json(), type, q);
  }
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
  /** the node's alias surface forms -> the ledger entry's prior_names (online). */
  aliases?: string[];
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
  const res = await fetch(readPath("/api/curation/candidates"));
  if (res.status === 404 && STATIC_READS) return [];
  if (!res.ok) throw new Error(`Failed to fetch candidates: ${res.status}`);
  return (await res.json()).candidates;
}

export async function fetchActiveMerges(): Promise<ActiveMerge[]> {
  const res = await fetch(readPath("/api/curation/merges"));
  if (res.status === 404 && STATIC_READS) return [];
  if (!res.ok) throw new Error(`Failed to fetch merges: ${res.status}`);
  return (await res.json()).merges;
}

/** A node reference carried in a curation write so both backends are satisfied:
 *  the local FastAPI uses the ids, the online edge (no DB) uses the natural
 *  identity (name/node_type/aliases -> the ledger's prior_names). */
function nodeRef(m: MergeMember) {
  return { id: m.id, name: m.name, node_type: m.node_type, aliases: m.aliases ?? [] };
}

/** Apply a merge. Sends both bare ids (FastAPI) and node refs (edge ledger).
 *  Throws on failure. */
export async function applyMerge(
  survivor: MergeMember,
  victims: MergeMember[],
  canonical_name: string,
): Promise<void> {
  const res = await fetch("/api/curation/merge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      survivor_id: survivor.id,
      victim_ids: victims.map((v) => v.id),
      canonical_name,
      survivor: nodeRef(survivor),
      victims: victims.map(nodeRef),
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `Merge failed (${res.status})`);
  }
}

/** Record a durable 'not a duplicate' rejection for a candidate cluster. Sends
 *  both bare ids (FastAPI) and node refs (edge ledger). */
export async function rejectCandidate(members: MergeMember[]): Promise<void> {
  const res = await fetch("/api/curation/reject", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      node_ids: members.map((m) => m.id),
      nodes: members.map(nodeRef),
    }),
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

// --- Model comparison (ADR 0039 Layer 1) ------------------------------------

export interface ComparableIngest {
  content_hash: string;
  title: string;
  slug: string;
  models: string[];
  variant_count: number;
}

export interface ModelClaim {
  id?: string;
  type?: string;
  location?: string;
  text?: string;
  quote?: string;
  speaker?: string | null;
  refs?: string[];
  shared: boolean;
}

export interface ModelVariant {
  model: string;
  prompt_variant?: string | null;
  domain_count: number;
  infra_count: number;
  claim_count: number;
  node_count: number;
  shared_count: number;
  unique_count: number;
  extracted_at?: string;
  wall_seconds?: number | null;
  claims: ModelClaim[];
  node_names: string[];
}

export interface ModelComparison {
  content_hash: string;
  title: string;
  models: string[];
  per_model: ModelVariant[];
  entities: { name: string; models: string[] }[];
}

export interface ModelJudgment {
  content_hash: string;
  models_compared: string[];
  chosen_model: string;
  judged_by?: string;
  created_at: string;
  notes?: string;
}

export async function fetchComparable(): Promise<ComparableIngest[]> {
  const res = await fetch("/api/models/comparable");
  if (!res.ok) throw new Error(`Failed to fetch comparable: ${res.status}`);
  return (await res.json()).comparable;
}

export async function fetchComparison(
  contentHash: string,
): Promise<{ comparison: ModelComparison; judgment: ModelJudgment | null }> {
  const res = await fetch(`/api/models/compare/${contentHash}`);
  if (!res.ok) throw new Error(`Failed to fetch comparison: ${res.status}`);
  return res.json();
}

export async function saveJudgment(
  content_hash: string,
  models_compared: string[],
  chosen_model: string,
  notes: string,
): Promise<ModelJudgment> {
  const res = await fetch("/api/models/judgment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content_hash, models_compared, chosen_model, notes }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `Judgment failed (${res.status})`);
  return data;
}

export async function fetchGraphNode(id: string): Promise<GraphNodeDetail | null> {
  const res = await fetch(readPath(`/api/graph/nodes/${encodeURIComponent(id)}`));
  if (res.status === 404 || res.status === 503) return null;
  if (!res.ok) throw new Error(`Failed to fetch graph node: ${res.status}`);
  return res.json();
}

// The schedule + processing-mode API moved to the local `scheduler` repo
// (review-vs-orchestrate split). The workbench is review-only.
