/**
 * Applying an approved housekeeping proposal, at the edge.
 *
 * A FAITHFUL PORT of `apply_items` in
 * anomalica-common/src/anomalica_common/llm/../housekeeping.py. That is a
 * liability, not a design preference: this is a second implementation of the one
 * function that guarantees housekeeping never touches body prose, and it exists
 * only because production has no Python - the deployed workbench is a static SPA
 * plus this Deno edge, so the local FastAPI route cannot serve it.
 *
 * The Python test cases are ported alongside in main_test.ts. If you change
 * either implementation, change both and run both suites.
 *
 * See anomalica/architecture/housekeeping.md and housekeeping-format.md.
 */

export type HousekeepingOperation = "set" | "clear" | "move";
export type HousekeepingStatus = "proposed" | "approved" | "rejected";

export interface HousekeepingItem {
  id: string;
  check: string;
  field: string;
  to_field?: string;
  operation: HousekeepingOperation;
  current: unknown;
  proposed: unknown;
  confidence: string;
  evidence: { reasoning: string; sources?: string[]; record_spans?: string[] };
  status: HousekeepingStatus;
  /** Items that must be approved alongside this one, or it destroys data. */
  depends_on?: string[];
}

/**
 * Approved ids whose prerequisites are not also approved.
 *
 * Enforced, not advisory: the dependent case exists because applying it alone
 * destroys data - setting date_published without the move that frees it
 * overwrites the upload date instead of relocating it.
 */
export function unmetDependencies(items: HousekeepingItem[], approved: Set<string>): string[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const bad: string[] = [];
  for (const id of approved) {
    const item = byId.get(id);
    if (!item) continue;
    if ((item.depends_on ?? []).some((d) => !approved.has(d))) bad.push(id);
  }
  return bad.sort();
}

export interface HousekeepingSidecar {
  schema: string;
  content_hash: string;
  checked_at: string;
  checker_version: number;
  usage?: unknown;
  items: HousekeepingItem[];
}

export class BodyChanged extends Error {}
export class MultilineField extends Error {}

const FIELD_LINE = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Same shape the edge already uses to split a record (main.ts). */
const FRONTMATTER = /^(---\n)([\s\S]*?)(\n---\n)([\s\S]*)$/;

/**
 * Digest of everything after the frontmatter fence.
 *
 * Deliberately does NOT reuse splitRecord. The guard compares a record before and
 * after, and a guard sharing its parser with the code it guards is cancelled out
 * by a fault in that parser: a mis-split corrupts both sides identically and the
 * comparison passes. This does its own minimal match so the two disagree when
 * anything is wrong.
 */
export async function bodyDigest(text: string): Promise<string> {
  const stripped = text.replace(/^---\n[\s\S]*?\n---\n/, "");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stripped));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function splitRecord(text: string): { frontmatter: string; body: string } | null {
  const m = text.match(FRONTMATTER);
  if (!m) return null;
  return { frontmatter: m[2], body: m[4] };
}

/**
 * Render a proposed value the way the corpus writes it.
 *
 * A full ISO date goes bare so it parses as a date. Everything else is quoted -
 * including a reduced-precision date like "1967", which must stay a string:
 * ingest-format makes precision the evidence marker, and a bare 1967 parses as an
 * integer.
 */
export function scalar(value: unknown): string {
  const v = String(value);
  if (ISO_DATE.test(v)) return v;
  return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** [start, end) of `name:` and any continuation lines, or null if absent. */
function fieldSpan(lines: string[], name: string): [number, number] | null {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(FIELD_LINE);
    if (!m || m[1] !== name) continue;
    let j = i + 1;
    while (j < lines.length && /^[ \t-]/.test(lines[j]) && lines[j].trim() !== "") j++;
    return [i, j];
  }
  return null;
}

/**
 * The record text with the APPROVED items applied to its frontmatter.
 *
 * Splices individual lines. It deliberately does NOT parse the YAML and
 * re-serialise: a no-op round-trip rewrites 200 of the 288 records in the store -
 * it re-quotes every string and turns `date_accessed: 2026-07-18T13:13:13+00:00`
 * into `2026-07-18 13:13:13+00:00`, dropping the ISO `T`. That buries the one
 * approved change in a whole-frontmatter diff and silently reformats timestamps
 * nobody agreed to touch. Splicing leaves every unapproved byte identical, so the
 * commit diff IS the approved items.
 */
export async function applyItems(original: string, items: HousekeepingItem[]): Promise<string> {
  const split = splitRecord(original);
  if (!split) throw new BodyChanged("no parseable frontmatter");
  const lines = split.frontmatter.split("\n");

  for (const item of items) {
    if (item.status !== "approved") continue;
    const span = fieldSpan(lines, item.field);
    if (span && span[1] - span[0] > 1) {
      throw new MultilineField(`${item.id}: ${item.field} spans lines`);
    }

    if (item.operation === "set") {
      const line = `${item.field}: ${scalar(item.proposed)}`;
      if (span) lines[span[0]] = line;
      else lines.push(line);
    } else if (item.operation === "clear") {
      if (span) lines.splice(span[0], span[1] - span[0]);
    } else if (item.operation === "move") {
      if (!item.to_field) throw new Error(`${item.id}: move without to_field`);
      const line = `${item.to_field}: ${scalar(item.proposed)}`;
      const dest = fieldSpan(lines, item.to_field);
      if (span) {
        if (dest) lines.splice(span[0], span[1] - span[0]);
        else lines[span[0]] = line;
      } else if (!dest) {
        lines.push(line);
      }
    } else {
      throw new Error(`${item.id}: unknown operation ${item.operation}`);
    }
  }

  const updated = "---\n" + lines.join("\n") + "\n---\n" + split.body;
  if ((await bodyDigest(updated)) !== (await bodyDigest(original))) {
    throw new BodyChanged("body changed during a frontmatter-only apply");
  }
  return updated;
}
