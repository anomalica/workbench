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
  date: string;
  source_type: string;
  source_url: string;
  copyright_status: CopyrightStatus;
}

export interface IngestDetail {
  content_hash: string;
  public_hash: string;
  copyright_status: CopyrightStatus;
  frontmatter: Record<string, string>;
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

/** Save modified markdown content for an ingest. */
export async function saveIngest(fullHash: string, content: string): Promise<boolean> {
  const res = await fetch(`/api/ingests/${fullHash}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  return res.ok;
}

export async function hashFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
