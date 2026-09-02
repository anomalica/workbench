/** A prior review the ingester carried onto a re-ingested record. */
export interface ReviewCarryover {
  /** ISO-8601 Zulu time of the re-ingest that carried the labels. */
  at: string;
  /** Content hash of the record the labels came from. Usually a retired
   *  predecessor; equal to the record's OWN hash when the ingester refreshed
   *  it in place (same source bytes, re-processed). Informational only -
   *  nothing here resolves it, and it must not be assumed to name another
   *  record. */
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

/** What the reviewer is being asked to look at again, and what they are not.
 *
 *  Said precisely because the cost of the two mistakes is not symmetric. A
 *  reviewer told "verify" who believes their highlights were lost will redo
 *  them; one who believes coverage was kept will not look at the prose that
 *  moved. The ingester places every inline marker - highlights, notes, links,
 *  citations, irrelevant regions - back on the same prose (a marker whose
 *  prose is gone refuses the refresh rather than being dropped), and does not
 *  touch the read-coverage sidecar. */
export function carryoverTooltip(c: ReviewCarryover | null | undefined): string {
  const moved = c?.had_text_edits
    ? "The text itself changed in re-processing. "
    : "The text was re-processed. ";
  return (
    moved +
    "Your earlier review - speakers, highlights, notes, links and irrelevant regions - " +
    "was placed back onto the new text. What you had marked as read was not: " +
    "look again and submit to confirm."
  );
}
