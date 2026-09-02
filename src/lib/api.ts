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
  document_type?: string;
  source_url: string;
  /** Extraction generation that produced this record (anomalica decision 0040),
   *  or null when not declared. Below `pipeline_current` = stale (badged). */
  pipeline_version?: number | null;
  /** Current extraction generation for this record's media type, from the
   *  ingester's manifest, or null when the media type isn't in the manifest. */
  pipeline_current?: number | null;
  /** The pipeline tried to refresh this stale record and refused: the fresh
   *  extraction lost words a reviewer had kept. `reason` names them. Absent
   *  when never tried, or when a later refresh succeeded. */
  refresh_refused?: { at: string; reason: string } | null;
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
  /** The reviewer's last-submitted verdict, from the sidecar. The display shows
   *  this, never a live recompute (a recompute skews when the body is edited).
   *  Absent on the static/edge read path. */
  observed_coverage?: number;
  digestible?: boolean;
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

import type { KnownSpeaker } from "$lib/speaker-suggest";

export async function fetchIngests(): Promise<IngestSummary[]> {
  const res = await fetch(readPath("/api/ingests"));
  if (!res.ok) throw new Error(`Failed to fetch ingests: ${res.status}`);
  return res.json();
}

/** Speaker names already used anywhere in the corpus, commonest first. Fetched
 *  once and offered while a new name is typed, so the same person does not end
 *  up spelled two ways. */
export async function fetchSpeakers(): Promise<KnownSpeaker[]> {
  const res = await fetch(readPath("/api/speakers"));
  if (!res.ok) throw new Error(`Failed to fetch speakers: ${res.status}`);
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
  /** False when the quote cannot be found in the record - the claim's evidence
   *  is not in the source. A finding, not a defect of the view. */
  located?: boolean;
  text: string;
  claim_type: string;
  attestation: string;
  speaker: string;
  refs: string[];
  /** The digester's check of the claim against its own quote. `score` is the
   *  probability of the label. Absent = not assessed (no quote or no text),
   *  which is not the same as neutral. */
  entailment?: Entailment | null;
}

export interface Entailment {
  label: "entails" | "neutral" | "contradicts";
  score: number;
  model: string;
}

/** A reviewer's per-member judgement within an adjudicated cluster. */
export interface AuditGoldMember {
  variant: string;
  claim_id: string;
  verdict: string; // correct | flattened | misattributed | overhedged
}

/** The reviewer's adjudication (gold) on a cluster or a missed source claim. */
export interface AuditGold {
  /** Orthogonal to `verdict`: is a correctly-extracted claim worth having?
   *  Optional - absent means not yet judged, never "fine". Only on `real`. */
  worth?: string;
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
  /** Did this passage actually compare models? False = it holds claims from one
   *  model only, so its clusters are singletons BY CONSTRUCTION and must not be
   *  graded - regardless of whether other passages compared fine. */
  compared?: boolean;
  clusters: AuditCluster[];
  /** "source" = grouped by measured quote overlap (a lone model here is a real
   *  finding); "location" = the older axis, where a lone model may be an
   *  artefact of how the models wrote their timecodes. */
  grouped_by?: "source" | "location";
}

export interface AuditVariant {
  id: string;
  model: string;
  cost_usd: number | null;
  prompt_ids: string[];
  /** Digest of the prompt SHAs this variant ran. Two variants are like-for-like
   *  ONLY if this matches - `prompt_ids` carries the version LABEL, which lies
   *  (two variants both say "claims:v3" while running different prompts). Empty
   *  = unknown, which must never be treated as a match. */
  prompt_fingerprint: string;
  claim_count: number;
  node_count?: number;
  /** ISO timestamp of the extraction run - the readable way to tell two
   *  variants of one model apart. */
  extracted_at?: string;
  /** Per-pass prompt identity. The VERSION LABEL LIES (two variants both say
   *  v3 with different prompts), so `sha` is the real identity and is what a
   *  diff between variants must compare. */
  prompts?: AuditPromptRef[];
}

export interface AuditPromptRef {
  pass: string;
  version: string;
  sha: string;
}

/** One entity and which variants extracted it - Pass A's half of the two-pass
 *  output. Outside the passage axis: nodes carry no source location, so this is
 *  a whole-record comparison. Matched across models on (type, name), exactly -
 *  a fuzzy merge would invent agreement a reviewer would read as recall. */
/** Entity forms that may be the same thing. Shown side by side, never merged. */
export interface AuditNodeGroup {
  alternatives: AuditNode[];
  found_by: string[];
}

/** A reviewer's verdict on one entity form. */
export interface AuditNodeGold {
  variant: string;
  type: string;
  name: string;
  quality: "irrelevant" | "too_generic" | "incorrect_formatting" | "good";
}

export async function putAuditNodes(hash: string, nodes: AuditNodeGold[]): Promise<void> {
  const res = await fetch(`/api/ingests/${hash}/audit/nodes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodes }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.detail || `Save failed (${res.status})`);
  }
}

export interface AuditNode {
  type: string;
  name: string;
  /** Variant ids that extracted this entity. */
  found_by: string[];
  singleton: boolean;
  node_ids: Record<string, string>;
}

/** Which similarity produced the clusters below. `degraded` = the embedding
 *  endpoint was unreachable and a crude lexical placeholder ran instead: the
 *  singleton/overlap structure is real but the meaning-merge is approximate,
 *  which the reviewer must be told before grading against it. */
export interface AuditSimilarity {
  method: "embedding" | "lexical";
  model_id: string | null;
  threshold: number;
  degraded: boolean;
}

/** Whether the singleton signal means anything for this record. Confounded =
 *  no passage ever compared two models, so every cluster is a singleton by
 *  construction and the UI must not let it be graded. */
export interface AuditAxis {
  confounded: boolean;
  reason: string;
}

export interface AuditPayload {
  axis?: AuditAxis;
  similarity?: AuditSimilarity;
  record: { hash: string; friendly_name: string };
  variants: AuditVariant[];
  nodes?: AuditNodeGroup[];
  passages: AuditPassage[];
  missed?: AuditGold[];
  /** anomalica/audit/2 gold as stored: raw claim verdicts + cluster best-ofs.
   *  Matching onto the displayed run is the client's job, by (variant, claim_id). */
  gold?: {
    claims: AuditClaimGold[];
    clusters: Record<string, unknown>[];
    nodes?: AuditNodeGold[];
  };
}

/** Fetch the model/digest audit comparison for a record. Null when no extraction
 *  variant has been produced yet (404). */
/** Thrown when the audit is refused rather than unavailable. A permission error
 *  rendered as a load failure sends the reader looking for a bug that isn't
 *  there - it cost an hour once already. `status` lets the view say which. */
export class AuditAccessError extends Error {
  constructor(readonly status: number) {
    super(status === 403 ? "Requires reviewer access" : "Login required");
  }
}

export async function fetchAudit(hash: string): Promise<AuditPayload | null> {
  const res = await fetch(readPath(`/api/ingests/${hash}/audit`));
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) throw new AuditAccessError(res.status);
  if (!res.ok) throw new Error(`Failed to fetch audit: ${res.status}`);
  return res.json();
}

/** One claim verdict in the anomalica/audit/2 gold: quality (bad|okay|good,
 *  "bad" includes misrepresents-the-source) and/or the orthogonal irrelevant
 *  mark. Keyed to a variant's claim; carries the anchors and the raw digest
 *  claim so the server computes the digester's fingerprint with zero mapping. */
export interface AuditClaimGold {
  gold_id?: string;
  variant: string;
  model: string;
  prompt_sha: string;
  claim_id: string;
  location: string;
  text: string;
  quote: string;
  claim_type: string;
  /** FAITHFULNESS - how well the model did the extraction. */
  quality?: "bad" | "okay" | "good";
  /** VALUE - whether the claim is worth having, independent of how well it was
   *  made. A faultless extraction of trivia is `good` and `irrelevant`. */
  value?: "irrelevant" | "potentially" | "gold";
  irrelevant?: boolean;
  claim?: Record<string, unknown>;
}

/** Record MANY claim verdicts in one write - and one commit. Grading happens in
 *  bursts, so a request per keystroke made the git log a keystroke log. */
export async function putAuditClaims(
  hash: string,
  claims: AuditClaimGold[],
): Promise<{ saved: number; gold_ids: string[] }> {
  const res = await fetch(`/api/ingests/${hash}/audit/claims`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claims }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `Save failed (${res.status})`);
  }
  return res.json();
}

/** Record one claim verdict (anomalica/audit/2). Returns the assigned gold_id. */
export async function putAuditClaim(
  hash: string,
  entry: AuditClaimGold,
): Promise<{ gold_id: string }> {
  const res = await fetch(`/api/ingests/${hash}/audit/claim`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
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
  complete_ranges?: { start: number; end: number; note?: string }[];
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
  payload: {
    complete: boolean;
    spans: HighlightSpan[];
    rejected: HighlightSpan[];
    /** Which regions the reviewer actually swept. Inside one, an unhighlighted
     *  sentence means "judged not claim-worthy"; outside every range it means
     *  "not looked at", and eval scores nothing there. */
    complete_ranges?: { start: number; end: number; note?: string }[];
  },
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
  /** Unique per variant (the file stem). The MODEL NAME IS NOT UNIQUE - a
   *  record can carry two opus digests at different prompts - so anything that
   *  identifies, keys or grades a variant must use this, never `model`. */
  variant: string;
  /** Digest of the prompt SHAs this variant ran; what differs when one model
   *  appears twice. */
  prompt_fingerprint?: string;
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
  /** Model names in variant order - NOT unique, kept for compatibility. */
  models: string[];
  /** Unique variant ids, parallel to per_model. */
  variants?: string[];
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

/** A claim the extraction filed as infrastructure rather than domain. */
export interface InfrastructureClaim {
  content: string;
  claim_type: string;
  attestation: string | null;
  location_in_record: string | null;
  origin: string | null;
  relay: string | null;
  record_title: string | null;
  record_hash: string | null;
}

export interface InfrastructureSummary {
  claims: number;
  records: number;
  entities: { document: number; person: number; organisation: number };
  connected: Record<string, number>;
  /** Works named by the material, and how many of them the corpus holds. */
  works_named: number;
  works_held: number;
  /** How many works sit at each pipeline stage, or null when there is no
   *  record list to compare against. */
  works_by_stage: Record<string, number> | null;
  by_type: { type: string; count: number }[];
  suspect: number;
  /** Works the graph lists under more than one name, so the counts above
   *  report them twice. */
  works_double_listed: number;
}

export interface InfrastructureEntity {
  id: string;
  name: string;
  mentions: number;
  records: number;
  /** Works only: how far along the pipeline this one has got. */
  stage: PipelineStage;
  /** Ingested by a superseded version of the ingester. */
  stale: boolean;
}

/** Where a named work has got to. A work starts as a title in someone else's
 *  bibliography and then walks the same path as everything else. */
export type PipelineStage = "named" | "queued" | "ingested" | "reviewed" | "digested";

export interface InfrastructureEntityDetail {
  id: string;
  name: string;
  kind: string;
  stage: PipelineStage;
  stale: boolean;
  /** The record we hold for this work, when we hold one. */
  record_hash: string | null;
  /** Other names this same work is listed under, unmerged. */
  also_listed_as: string[];
  aliases: string[];
  claims: InfrastructureClaim[];
  connected: { id: string; name: string; kind: string; shared: number }[];
}

// The infrastructure views read the assimilator's second database, which a
// static build does not ship - hence no readPath fallback.
export interface InfrastructureRecord {
  title: string;
  hash: string;
  claims: number;
}

export async function fetchInfrastructure(): Promise<{
  summary: InfrastructureSummary | null;
  records: InfrastructureRecord[];
}> {
  const res = await fetch("/api/infrastructure");
  if (res.status === 503 || res.status === 404) return { summary: null, records: [] };
  if (!res.ok) throw new Error(`Failed to fetch infrastructure summary: ${res.status}`);
  return res.json();
}

export async function fetchInfrastructureEntities(
  kind: string,
  q = "",
): Promise<InfrastructureEntity[]> {
  const params = new URLSearchParams({ kind });
  if (q.trim()) params.set("q", q.trim());
  const res = await fetch(`/api/infrastructure/entities?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch infrastructure entities: ${res.status}`);
  return (await res.json()).entities;
}

export async function fetchInfrastructureEntity(
  nodeId: string,
): Promise<InfrastructureEntityDetail | null> {
  const res = await fetch(`/api/infrastructure/entities/${encodeURIComponent(nodeId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch infrastructure entity: ${res.status}`);
  return res.json();
}

export async function fetchInfrastructureClaims(
  claimType = "",
  q = "",
  // The whole set. A cap here would show "500 claims" beside a header saying
  // 1,830 and give no sign which 1,330 were dropped.
  limit = 2500,
): Promise<InfrastructureClaim[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (claimType) params.set("claim_type", claimType);
  if (q.trim()) params.set("q", q.trim());
  const res = await fetch(`/api/infrastructure/claims?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch infrastructure claims: ${res.status}`);
  return (await res.json()).claims;
}

// --- Housekeeping ----------------------------------------------------------
// Proposed frontmatter corrections awaiting a human decision, per item. See
// anomalica/architecture/housekeeping.md.

export interface HousekeepingRow {
  content_hash: string;
  title: string | null;
  copyright_status: string | null;
  checked_at: string | null;
  checker_version: number;
  proposed: number;
  approved: number;
  rejected: number;
}

export interface HousekeepingItem {
  id: string;
  check: string;
  field: string;
  to_field?: string;
  operation: "set" | "clear" | "move";
  current: unknown;
  proposed: unknown;
  confidence: "high" | "medium" | "low";
  evidence: { reasoning: string; sources: string[]; record_spans: string[] };
  status: "proposed" | "approved" | "rejected";
  /** Items that must be approved alongside this one, or it destroys data. */
  depends_on?: string[];
  /** The exact frontmatter lines the commit will remove and add. */
  preview?: { removed: string[]; added: string[] };
}

export interface HousekeepingSidecar {
  content_hash: string;
  checked_at: string;
  checker_version: number;
  items: HousekeepingItem[];
  /** True when the copyright allow-list withheld items about gated fields. */
  gated?: boolean;
}

export async function fetchHousekeepingQueue(): Promise<HousekeepingRow[]> {
  const res = await fetch(readPath("/api/housekeeping"));
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Failed to fetch housekeeping queue: ${res.status}`);
  return (await res.json()).queue ?? [];
}

export async function fetchHousekeeping(contentHash: string): Promise<HousekeepingSidecar | null> {
  const h = contentHash.replace(/^sha256:/, "");
  const res = await fetch(readPath(`/api/ingests/${h}/housekeeping`));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch housekeeping: ${res.status}`);
  return res.json();
}

/** Record per-item decisions. Never readPath: this is always a live write. */
export async function decideHousekeeping(
  contentHash: string,
  decisions: { item_id: string; status: "approved" | "rejected" }[],
): Promise<{ applied: number; rejected: number }> {
  const h = contentHash.replace(/^sha256:/, "");
  const res = await fetch(`/api/ingests/${h}/housekeeping/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decisions }),
  });
  if (!res.ok) throw new Error(`Failed to record decisions: ${res.status}`);
  return res.json();
}

// --- Topics: what earns a page, and what goes into it ---

export interface Topic {
  node_id: string;
  name: string;
  node_type: string;
  tier: string;
  /** Where the page would be published: people, events, projects... A page is
   *  the pair (section, slug) - two sections can hold one slug. */
  section: string;
  slug: string;
  claims: number;
  sources: number;
  independent_sources: number | null;
  /** A second work contributes fewer than three claims: the page rests on one voice. */
  single_source: boolean;
  status: string;
  has_brief: boolean;
  brief_claims: number | null;
}

export interface SeededTopic {
  name: string;
  note?: string | null;
  at?: string;
  by?: string | null;
}

/** A page that already exists in the content repo. */
export interface PublishedPage {
  slug: string;
  name: string;
  kind: string | null;
  brief_hash: string;
  /** The brief moved after the page was written; null when the brief is gone. */
  stale: boolean | null;
}

export async function fetchTopics(): Promise<{
  topics: Topic[];
  seeded: SeededTopic[];
  published: PublishedPage[];
}> {
  const res = await fetch(readPath("/api/topics"));
  if (!res.ok) throw new Error(`Failed to fetch topics: ${res.status}`);
  return await res.json();
}

/** The brief whole, not summarised - the point is seeing what actually goes in. */
export async function fetchTopicBrief(
  section: string,
  slug: string,
): Promise<Record<string, unknown> | null> {
  const res = await fetch(
    readPath(`/api/topics/${encodeURIComponent(section)}/${encodeURIComponent(slug)}/brief`),
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch brief: ${res.status}`);
  return await res.json();
}

export async function vetoTopic(nodeIds: string[], reason: string): Promise<void> {
  const res = await fetch("/api/topics/veto", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_ids: nodeIds, reason }),
  });
  if (!res.ok)
    throw new Error((await res.json().catch(() => ({}))).detail ?? `Veto failed: ${res.status}`);
}

export async function seedTopic(name: string, note: string): Promise<void> {
  const res = await fetch("/api/topics/seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, note }),
  });
  if (!res.ok)
    throw new Error((await res.json().catch(() => ({}))).detail ?? `Seed failed: ${res.status}`);
}

export async function unseedTopic(name: string): Promise<void> {
  const res = await fetch(`/api/topics/seed/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Remove failed: ${res.status}`);
}

/** One record's place in the review queue: what reading it costs and what it
 *  would feed. Server-computed - the ranking reads the knowledge graph, which
 *  the browser has no access to. */
export interface ReviewPriority {
  content_hash: string;
  /** Minutes to read the content, annotations stripped. */
  minutes: number;
  /** Distinct page-worthy entities the record names. */
  reach: number;
  high_bar: number;
  /** Undecided housekeeping proposals. Non-zero means "not ready to read". */
  housekeeping_open: number;
  /** The entities it reaches, most-mentioned first - the "why" behind a row. */
  unlocks: string[];
  score: number;
}

export interface ReviewQueue {
  queue: ReviewPriority[];
  /** False when there is no knowledge graph behind the ranking, so the order is
   *  reading cost alone. Stated rather than inferred from an empty result:
   *  "no graph" and "nothing reaches a page" are different answers. */
  graph_available: boolean;
}

export async function fetchReviewQueue(): Promise<ReviewQueue | null> {
  // Local-only by construction: the ranking reads the knowledge graph, which a
  // static deployment does not carry. Not called there at all.
  //
  // The content-type guard is not belt-and-braces, it is the actual failure. A
  // static host answers an unknown path with the SPA shell and status 200, so
  // `res.ok` is TRUE and `res.json()` then throws on "<!doctype" - an uncaught
  // rejection on every page load. A missing endpoint is not always a 404.
  if (STATIC_READS) return null;
  try {
    const res = await fetch("/api/review-queue");
    if (!res.ok) return null;
    if (!(res.headers.get("content-type") || "").includes("application/json")) return null;
    return await res.json();
  } catch {
    // A ranking is a convenience; failing to get one must never break the list.
    return null;
  }
}
