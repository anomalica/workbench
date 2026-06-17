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
  publisher: string;
  copyright_status: CopyrightStatus;
  /** True when a reviewer has observed 100% of the record's content units
   *  (the digester gate's rule). See observed_coverage for the fraction. */
  digestible: boolean;
  /** Observed fraction (0..1) of the record's content units. */
  observed_coverage: number;
  /** Present when the ingester carried a prior review onto this re-ingested
   *  record; null/absent otherwise. */
  review_carryover?: ReviewCarryover | null;
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
  attestation: string;
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
