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
  schema_version: number;
  /** Spec field `creators` (was `authors`); UI labels it "Authors / Creators". */
  creators: string[];
  /** date_published from frontmatter. */
  date: string;
  /** date_extracted (falls back to date_accessed) - when ingestion ran. */
  date_ingested: string;
  source_type: string;
  source_url: string;
  /** Extraction generation that produced this record (anomalica decision 0040),
   *  or null when not declared. Below `pipeline_current` = stale (badged). */
  pipeline_version?: number | null;
  /** Current extraction generation for this record's media type, from the
   *  ingester's manifest, or null when the media type isn't in the manifest. */
  pipeline_current?: number | null;
  /** Local-file origin filename (PDFs ingested from disk). */
  source_file: string;
  /** sha256 of the archived original source file (ebooks/PDFs ingested from a
   *  file). A recoverable origin even when `provenance` is "unknown". */
  source_hash: string;
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
  source_hash?: string;
  provenance?: string;
}): { kind: ProvenanceKind; label: string; traceable: boolean } {
  if (r.source_url) return { kind: "url", label: r.source_url, traceable: true };
  if (r.source_file) return { kind: "file", label: r.source_file, traceable: true };
  // The original source file archived by its hash (e.g. ebooks/PDFs ingested from
  // a file) is a recoverable origin even when provenance is "unknown" - the bytes
  // exist in the sources archive. Without this, ebooks read as "No source
  // recorded" though their epub is on hand.
  if (r.source_hash) return { kind: "file", label: "Archived source file", traceable: true };
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

export async function fetchArchivedIngests(): Promise<IngestSummary[]> {
  const res = await fetch(readPath("/api/ingests/archived"));
  if (!res.ok) throw new Error(`Failed to fetch archived ingests: ${res.status}`);
  return res.json();
}

export async function archiveIngest(hash: string): Promise<void> {
  const res = await fetch(`/api/ingests/${hash}/archive`, { method: "POST" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `Archive failed (${res.status})`);
  }
}

export async function unarchiveIngest(hash: string): Promise<void> {
  const res = await fetch(`/api/ingests/${hash}/unarchive`, { method: "POST" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `Unarchive failed (${res.status})`);
  }
}

/** An assembled knowledge-article page (the public, post-digest content layer).
 *  Read-only listing for the Articles tab. `record_hash` is set only for the
 *  records page-class (its 56-char id, deep-linkable to the in-app record view);
 *  entity articles have it null and link to the public site at `url`. */
export interface Article {
  section: string;
  slug: string;
  title: string;
  description: string;
  tags: string[];
  url: string;
  record_hash: string | null;
  /** Presentation directives for this article (a YAML sidecar in the content
   *  repo). Read-only in the listing; edited via setArticleDirectives. */
  directives: string[];
}

export async function fetchArticles(): Promise<Article[]> {
  const res = await fetch(readPath("/api/articles"));
  // Snapshot may predate the articles render (older build): treat absence as empty.
  if (res.status === 404 && STATIC_READS) return [];
  if (!res.ok) throw new Error(`Failed to fetch articles: ${res.status}`);
  return res.json();
}

/** Set an article's presentation-directive list. Always dynamic (the live
 *  edge/FastAPI commits the content-repo sidecar, never the static snapshot).
 *  Presentation-only - the server trims/dedupes/caps and returns the stored
 *  list. The edge enforces login; a 401 means the session lapsed. */
export async function setArticleDirectives(
  section: string,
  slug: string,
  directives: string[],
): Promise<string[]> {
  const res = await fetch(`/api/articles/${section}/${slug}/directives`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ directives }),
  });
  if (!res.ok) throw new Error(`Failed to save directives: ${res.status}`);
  return (await res.json()).directives ?? [];
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

/** A member claim within an audit cluster: one variant's phrasing of a fact,
 *  plus how it framed it epistemically (hearsay vs fact, attestation, refs) so a
 *  flattening by one variant is visible against another. */
export interface AuditMember {
  variant: string;
  model: string;
  claim_id: string;
  location: string;
  quote: string;
  text: string;
  claim_type: string;
  attestation: string;
  speaker: string;
  refs: string[];
}

/** A reviewer's per-member judgement within an adjudicated cluster. */
export interface AuditGoldMember {
  variant: string;
  claim_id: string;
  verdict: string; // correct | flattened | misattributed | overhedged
}

/** The reviewer's adjudication (gold) on a cluster or a missed source claim. */
export interface AuditGold {
  gold_id?: string;
  verdict: string; // real | hallucinated | not_asserted | missed
  location?: string;
  text?: string;
  members?: AuditGoldMember[];
  attribution?: Record<string, unknown>;
  note?: string;
}

/** A meaning-cluster within a source passage - the same fact as one or more
 *  variants stated it. `singleton` = only one variant produced it. `gold` is the
 *  reviewer's adjudication, when marked. */
export interface AuditCluster {
  id: string;
  singleton: boolean;
  variants: string[];
  members: AuditMember[];
  gold?: AuditGold;
}

export interface AuditPassage {
  index: number;
  start: number;
  end: number;
  raw_locations: string[];
  clusters: AuditCluster[];
}

export interface AuditVariant {
  id: string;
  model: string;
  cost_usd: number | null;
  prompt_ids: string[];
  claim_count: number;
}

export interface AuditPayload {
  record: { hash: string; friendly_name: string };
  variants: AuditVariant[];
  passages: AuditPassage[];
  missed?: AuditGold[];
}

/** Fetch the model/digest audit comparison for a record. Null when no extraction
 *  variant has been produced yet (404). */
export async function fetchAudit(hash: string): Promise<AuditPayload | null> {
  const res = await fetch(readPath(`/api/ingests/${hash}/audit`));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch audit: ${res.status}`);
  return res.json();
}

/** Record an adjudication (the reviewer's gold) on a cluster or missed claim.
 *  Returns the assigned gold_id. */
export async function putAuditVerdict(
  hash: string,
  adjudication: AuditGold,
): Promise<{ gold_id: string }> {
  const res = await fetch(`/api/ingests/${hash}/audit/verdict`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(adjudication),
  });
  if (!res.ok) throw new Error(`Failed to save verdict: ${res.status}`);
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
// A submit request must never hang indefinitely with no feedback - a stuck
// backend/network once left the submit dialog silently open for an hour with
// no error, so the reviewer had no signal to retry before the browser crashed
// and the (unsaved) review was lost. 45s is generous for a large record's PUT
// on a slow connection but still bounds the wait to something a reviewer would
// notice and can act on.
const SUBMIT_TIMEOUT_MS = 45_000;

export async function submitReview(
  fullHash: string,
  content: string,
  notes: string,
  spans?: KindedSpan[],
  verdict?: { observed_coverage: number; digestible: boolean; total_units: number },
  options?: { deferPush?: boolean },
): Promise<{ ok: boolean; error?: string; synced?: boolean; syncDetail?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`/api/ingests/${fullHash}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        notes,
        ...(spans && spans.length > 0 ? { spans } : {}),
        ...(verdict ? { verdict } : {}),
        // Two-phase submit (local backend): save+commit now, push as its own
        // step via pushOrigin() so the UI can report the slow half distinctly.
        ...(options?.deferPush ? { push: false } : {}),
      }),
      signal: controller.signal,
    });
  } catch (e) {
    const timedOut = e instanceof DOMException && e.name === "AbortError";
    return {
      ok: false,
      error: timedOut
        ? "Submit timed out - your edits are still safe in this browser. Check your connection and try again."
        : "Network error while submitting - your edits are still safe in this browser. Try again.",
    };
  } finally {
    clearTimeout(timer);
  }
  if (res.ok) {
    // The local backend reports whether the review commit reached origin;
    // synced false means it is safe locally but NOT on GitHub / the live
    // site yet. The edge deploy writes to GitHub directly (always synced),
    // and older backends omit the field - treat absence as synced.
    const data = await res.json().catch(() => ({}));
    return {
      ok: true,
      synced: data.synced !== false,
      syncDetail: data.sync_detail || "",
    };
  }
  const data = await res.json().catch(() => ({}));
  return { ok: false, error: data.detail || `Error ${res.status}` };
}

import type { KindedSpan, CoverageReview } from "$lib/coverage";

/** Fetch all reviewers' coverage entries for a record. Empty when no
 *  coverage has been recorded yet. */
/** The gate's verify/submit response. On a PASS for a gated record the edge also
 *  returns the record body + raw_frontmatter (withheld from the public snapshot),
 *  so a proven possessor can review and edit the text. */
export interface VerificationResult {
  passed: boolean;
  method?: string;
  score?: number | null;
  needed?: number | null;
  url?: string;
  expires_in?: number;
  body?: string;
  raw_frontmatter?: string;
}

/** Prove possession to the gate (a source-file SHA-256, or a cloze session +
 *  responses). Always dynamic - the live edge serves it; the static snapshot
 *  never carries the gated body. */
export async function submitVerification(
  fullHash: string,
  proof: {
    sha256?: string;
    session_id?: string;
    responses?: Record<string, string>;
    ext?: string;
  },
): Promise<VerificationResult> {
  const res = await fetch(`/api/ingests/${fullHash}/verification/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(proof),
  });
  if (!res.ok) throw new Error(`Verification failed: ${res.status}`);
  return res.json();
}

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

// Relevance-tuning highlights (anomalica/highlights/1). Span offsets are
// Unicode code points into the raw stored body - src/lib/highlights.ts
// converts to/from the UI's UTF-16 offsets.

export interface HighlightSpan {
  start: number;
  end: number;
  text: string;
  note?: string;
}

export interface HighlightsSidecar {
  schema: string;
  record_hash: string;
  body_sha256: string;
  complete: boolean;
  /** Pseudonymous author; "fable-draft" for an unconfirmed AI draft. */
  reviewed_by: string;
  /** Null on an AI draft that no reviewer has saved yet. */
  reviewed_at: string | null;
  spans: HighlightSpan[];
  rejected: HighlightSpan[];
}

/** The raw stored body (the reference text highlight offsets index) and its
 *  hash. This is the same text the digester pins body_sha256 from.
 *  DYNAMIC (the live FastAPI only) - tuning mode is not part of the static
 *  snapshot, and its entry point is hidden on static builds. */
export async function fetchRawBody(hash: string): Promise<{ body: string; body_sha256: string }> {
  const res = await fetch(`/api/ingests/${hash}/body`);
  if (!res.ok) throw new Error(`Failed to fetch body: ${res.status}`);
  return res.json();
}

export async function fetchHighlights(
  hash: string,
): Promise<{ highlights: HighlightsSidecar | null; body_sha256: string }> {
  const res = await fetch(`/api/ingests/${hash}/highlights`);
  if (!res.ok) throw new Error(`Failed to fetch highlights: ${res.status}`);
  return res.json();
}

export async function saveHighlights(
  hash: string,
  payload: { complete: boolean; spans: HighlightSpan[]; rejected: HighlightSpan[] },
): Promise<{ saved: boolean; body_sha256: string }> {
  const res = await fetch(`/api/ingests/${hash}/highlights`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `Save failed (${res.status})`);
  }
  return res.json();
}

export interface GradingItem {
  /** Null when the re-aligner could not map the item's quote to a span. */
  start: number | null;
  end: number | null;
  text: string;
  kind?: "claim" | "node";
  summary?: string;
  overlap_fraction?: number;
}

/** anomalica/grading/2 (ADR 0042): coverage-only. Partial highlights cannot
 *  yield precision - an unhighlighted extraction is not wrong - so the one
 *  corpus-wide number is coverage (highlighted spans that survived into the
 *  output), and `unmarked` is informational, never a penalty. */
export interface GradingModelResult {
  model: string;
  prompts?: unknown;
  coverage: number;
  missed: HighlightSpan[];
  unmarked: GradingItem[];
}

export interface GradingResults {
  schema: string;
  record_hash: string;
  body_sha256: string;
  graded_at?: string;
  models: GradingModelResult[];
}

/** Grading results the digester emitted for this record's current body.
 *  Null when no grading exists (or on any error) - the tuning page then
 *  simply shows no results section. DYNAMIC (the live FastAPI only). */
export async function fetchGrading(hash: string): Promise<GradingResults | null> {
  const res = await fetch(`/api/ingests/${hash}/grading`);
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.available ? (data.grading as GradingResults) : null;
}

/** The pre-digest computed live (ADR 0042): the exact model input, derived
 *  on demand by the same shared materialise() the digester runs - preview
 *  equals digest input byte-for-byte. Read-only; corrections go to the
 *  ingest. Null on any error. DYNAMIC (the live FastAPI only). */
export interface Predigest {
  predigest_sha256: string;
  prep_version: string | number | null;
  generated_at: string | null;
  body: string;
  /** The active extraction passes (nodes, claims) - what the next run sends. */
  prompts: { name: string; version: string; text: string }[];
  /** The digester's stored artefact from the LAST digest, if any. */
  stored: {
    predigest_sha256: string;
    prep_version: string | number | null;
    generated_at: string | null;
  } | null;
  /** Whether the live input still matches the last digested one (null when
   *  nothing has been digested yet). */
  stored_matches: boolean | null;
}

/** Compute the pre-digest for a record - from `workingBody` when given (so
 *  unsubmitted irrelevant marks preview immediately), else the stored body. */
export async function fetchPredigest(
  hash: string,
  workingBody?: string,
): Promise<Predigest | null> {
  try {
    const res = await fetch(`/api/ingests/${hash}/predigest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(workingBody !== undefined ? { body: workingBody } : {}),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.available ? (data as Predigest) : null;
  } catch {
    return null;
  }
}

/** Whether the open record was superseded/re-ingested underneath the view.
 *  Null on any error or a deployment without the endpoint. DYNAMIC. */
export interface Supersession {
  exists: boolean;
  superseded_by: string | null;
  public_supersedes: string | null;
}

export async function fetchSupersession(hash: string): Promise<Supersession | null> {
  try {
    const res = await fetch(`/api/ingests/${hash}/supersession`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Sync state of the local ingests clone vs origin (local backend only -
 *  the static deploy has no clone and 404s, which callers treat as null). */
export interface SyncStatus {
  ahead: number;
  behind: number;
  dirty: boolean;
  offline: boolean;
  last_error: string;
  checked_at: string | null;
}

export async function fetchSyncStatus(): Promise<SyncStatus | null> {
  try {
    const res = await fetch("/api/sync");
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Push local ingests commits to origin - the deferred second phase of a
 *  review submit. Null ONLY when the deployment has no local clone (404:
 *  the edge writes straight to GitHub, so the review is already synced).
 *  Any other failure reports synced: false - the commit is safe locally
 *  but did not reach GitHub. */
export async function pushOrigin(): Promise<{ synced: boolean; syncDetail: string } | null> {
  try {
    const res = await fetch("/api/sync/push", { method: "POST" });
    if (res.status === 404) return null;
    if (!res.ok) return { synced: false, syncDetail: `push endpoint error ${res.status}` };
    const data = await res.json();
    return { synced: data.synced !== false, syncDetail: data.sync_detail || "" };
  } catch {
    return { synced: false, syncDetail: "network error during push" };
  }
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

/** The logged-in user's contribution role (contributor|reviewer|editor), so the
 *  UI can show the Review tab and the propose-vs-commit affordance. Enforced
 *  server-side regardless. Defaults to contributor when not logged in. */
export async function fetchMyRole(): Promise<string> {
  const res = await fetch("/api/me/role");
  if (!res.ok) return "contributor";
  return (await res.json()).role ?? "contributor";
}

/** A pending proposal's metadata (no content - the diff is fetched per item). */
export interface ProposalSummary {
  id: string;
  record_hash: string;
  author_login: string;
  author_name: string;
  author_email: string;
  notes: string;
  created_at: string;
  status: string;
}

export interface ProposalDetail {
  proposal: ProposalSummary & { content: string };
  current_content: string;
  record_exists: boolean;
  record_title: string;
}

export async function fetchProposals(): Promise<ProposalSummary[]> {
  const res = await fetch("/api/proposals");
  if (!res.ok) return [];
  return (await res.json()).proposals ?? [];
}

export async function fetchProposal(id: string): Promise<ProposalDetail | null> {
  const res = await fetch(`/api/proposals/${id}`);
  if (!res.ok) return null;
  return await res.json();
}

export async function approveProposal(id: string): Promise<boolean> {
  const res = await fetch(`/api/proposals/${id}/approve`, { method: "POST" });
  return res.ok;
}

export async function rejectProposal(id: string): Promise<boolean> {
  const res = await fetch(`/api/proposals/${id}/reject`, { method: "POST" });
  return res.ok;
}

export interface RolesResponse {
  roles: Record<string, string>;
  options: string[];
  self: string;
}

export async function fetchRoles(): Promise<RolesResponse> {
  const res = await fetch("/api/roles");
  if (!res.ok) return { roles: {}, options: ["contributor", "reviewer", "editor"], self: "" };
  return await res.json();
}

/** Set a login's role. Returns the new map, or an error message (e.g. the
 *  last-editor guard) on failure. */
export async function setRole(
  login: string,
  role: string,
): Promise<{ roles?: Record<string, string>; error?: string }> {
  const res = await fetch(`/api/roles/${encodeURIComponent(login)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: data.detail ?? "Failed to set role" };
  return { roles: data.roles };
}

export async function removeRole(
  login: string,
): Promise<{ roles?: Record<string, string>; error?: string }> {
  const res = await fetch(`/api/roles/${encodeURIComponent(login)}`, { method: "DELETE" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: data.detail ?? "Failed to remove role" };
  return { roles: data.roles };
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
