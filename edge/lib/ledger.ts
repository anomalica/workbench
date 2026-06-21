/**
 * Curation ledger entries (serverless edition). Online, merge/reject decisions
 * are APPENDED to the durable git ledger (curation/merges.yaml + rejections.yaml)
 * instead of mutating a live DB - the assimilator replays them on the next local
 * rebuild (ADR 0038). This module BUILDS + SERIALISES entries byte-compatibly
 * with the assimilator's writer (merge.py _append + safe_dump):
 *   - a `---`-separated multi-document stream, one block-YAML doc per entry;
 *   - key order preserved (op first);
 *   - unicode kept readable (no \uXXXX escaping);
 *   - no document-end `...` marker.
 *
 * Natural identity (name + node_type + prior_names) is the replay key; the audit
 * ids snapshot the at-decision nodes (and are the same-snapshot queue-filter key).
 */

import { stringify } from "jsr:@std/yaml@1";

export interface NodeRef {
  id: string;
  name: string;
  node_type: string;
  /** the node's aliases at decision time -> prior_names (name-drift robustness). */
  aliases?: string[];
}

function natural(n: NodeRef) {
  return { name: n.name, node_type: n.node_type, prior_names: n.aliases ?? [] };
}

export interface MergeEntry {
  op: "merge";
  merge_id: string;
  at: string;
  by: string | null;
  canonical_name: string;
  survivor: ReturnType<typeof natural>;
  victims: ReturnType<typeof natural>[];
  audit: { survivor_id: string; victim_ids: string[] };
}

export function buildMergeEntry(opts: {
  mergeId: string;
  at: string;
  by: string | null;
  canonicalName: string;
  survivor: NodeRef;
  victims: NodeRef[];
}): MergeEntry {
  return {
    op: "merge",
    merge_id: opts.mergeId,
    at: opts.at,
    by: opts.by,
    canonical_name: opts.canonicalName,
    survivor: natural(opts.survivor),
    victims: opts.victims.map(natural),
    audit: {
      survivor_id: opts.survivor.id,
      victim_ids: opts.victims.map((v) => v.id),
    },
  };
}

export function buildUndoEntry(mergeId: string, by: string | null, at: string) {
  return { op: "undo" as const, merge_id: mergeId, at, by };
}

export function buildRejectEntry(opts: {
  rejectionId: string;
  at: string;
  by: string | null;
  reason: string | null;
  nodes: NodeRef[];
}) {
  return {
    op: "reject" as const,
    rejection_id: opts.rejectionId,
    at: opts.at,
    by: opts.by,
    reason: opts.reason,
    nodes: opts.nodes.map(natural),
    audit: { node_ids: opts.nodes.map((n) => n.id) },
  };
}

export function buildUnrejectEntry(rejectionId: string, by: string | null, at: string) {
  return { op: "unreject" as const, rejection_id: rejectionId, at, by };
}

/** Serialise one entry as a ledger document: `---\n` + block YAML (no `...`). */
export function serialiseEntry(entry: unknown): string {
  const body = stringify(entry as Record<string, unknown>, {
    sortKeys: false, // preserve op-first key order
    lineWidth: -1, // never wrap (keep names on one line)
    skipInvalid: false,
  });
  return `---\n${body}`;
}

/** Append an entry to existing ledger text (empty string if the file is new). */
export function appendEntry(existing: string, entry: unknown): string {
  const base = existing.length && !existing.endsWith("\n") ? existing + "\n" : existing;
  return base + serialiseEntry(entry);
}

/** ISO-8601 seconds + Z, matching the assimilator's _now() exactly. */
export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
