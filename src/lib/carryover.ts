/** A prior review the ingester carried onto a re-ingested record. */
export interface ReviewCarryover {
  /** ISO-8601 Zulu time of the re-ingest that carried the labels. */
  at: string;
  /** content hash of the v1 record the labels came from. */
  from: string;
  /** v1 had manual text edits beyond speaker labels - flag a re-check. */
  had_text_edits: boolean;
}

export type CarryoverState = "none" | "needs_verify" | "verified";

/** Whether a carried-over record still needs the reviewer's verification.
 *  ISO-8601 Zulu timestamps compare lexicographically, so a string compare is
 *  correct. A record is:
 *  - "none" when there is no carryover marker;
 *  - "verified" when the reviewer reviewed it AT OR AFTER the carry (i.e. they
 *    re-verified the re-ingested record);
 *  - "needs_verify" otherwise - carried but not yet re-verified, which includes
 *    a review that PREDATES the re-ingest (stale: the record changed under it,
 *    even though the content hash stayed the same). */
export function carryoverState(
  carriedAt: string | undefined | null,
  reviewedAt: string | undefined | null,
): CarryoverState {
  if (!carriedAt) return "none";
  if (reviewedAt && reviewedAt >= carriedAt) return "verified";
  return "needs_verify";
}
