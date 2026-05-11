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
  authors: string[];
  date: string;
  source_type: string;
  source_url: string;
  publisher: string;
  copyright_status: CopyrightStatus;
}

export interface IngestDetail {
  content_hash: string;
  public_hash: string;
  copyright_status: CopyrightStatus;
  authors: string[];
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

/** Check whether an ingest exists for a given full hash. */
export async function ingestExists(fullHash: string): Promise<boolean> {
  const res = await fetch(`/api/ingests/${fullHash}`);
  return res.ok;
}

/** Submit a review: save changes and commit with reviewer identity. */
export async function submitReview(
  fullHash: string,
  content: string,
  notes: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/api/ingests/${fullHash}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, notes }),
  });
  if (res.ok) return { ok: true };
  const data = await res.json().catch(() => ({}));
  return { ok: false, error: data.detail || `Error ${res.status}` };
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
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Per-record review state for the currently logged-in user. */
export interface ReviewState {
  reviewed_at: string;
}

/** Fetch the current user's review state. Returns an empty map if the
 *  user is not logged in or the backend has no record for them. */
export async function fetchReviews(): Promise<Record<string, ReviewState>> {
  const res = await fetch("/api/me/reviews");
  if (!res.ok) return {};
  const data = await res.json().catch(() => ({}));
  return data.reviews || {};
}

export async function markReviewed(fullHash: string): Promise<boolean> {
  const res = await fetch(`/api/me/reviews/${fullHash}`, { method: "POST" });
  return res.ok;
}

export async function unmarkReviewed(fullHash: string): Promise<boolean> {
  const res = await fetch(`/api/me/reviews/${fullHash}`, { method: "DELETE" });
  return res.ok;
}
