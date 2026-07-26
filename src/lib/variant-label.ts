/**
 * Naming a model-variant on screen.
 *
 * A MODEL NAME IS NOT AN IDENTITY. One record can hold two variants of the same
 * model that ran different prompts - jon-stewart carries two opus digests, one
 * at prompt 515508ce with 756 claims and one at ba1de88a with 407 - and showing
 * both as "opus" is unreadable: two rows with the same name, one of them
 * silent, and no way to tell which is which or which to switch off.
 *
 * So a label is only shortened to the bare model name when that name is UNIQUE
 * in the set being displayed. Where it repeats, the prompt fingerprint is
 * appended, because the prompt is what actually differs and it is the thing a
 * reviewer needs in order to read the comparison correctly (a gap between two
 * different prompts is a prompt difference, not a model difference).
 */

export interface LabelledVariant {
  /** Unique per variant - the file stem. Never the model name. */
  id: string;
  model: string;
  /** Digest of the prompt SHAs the variant ran; "" when unknown. */
  prompt_fingerprint?: string;
  /** ISO timestamp of the extraction run. */
  extracted_at?: string;
}

/** `24 Jul` from an ISO timestamp, or "" if it isn't one. */
function runDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** Map of variant id -> display label, disambiguated only where needed. */
export function variantLabels(variants: LabelledVariant[]): Map<string, string> {
  const seen = new Map<string, number>();
  for (const v of variants) seen.set(v.model, (seen.get(v.model) ?? 0) + 1);

  const out = new Map<string, string>();
  const dateCounts = new Map<string, number>();
  for (const v of variants) {
    const k = `${v.model}|${runDate(v.extracted_at)}`;
    dateCounts.set(k, (dateCounts.get(k) ?? 0) + 1);
  }
  for (const v of variants) {
    if ((seen.get(v.model) ?? 0) < 2) {
      out.set(v.id, v.model);
      continue;
    }
    // Ambiguous: qualify it. Prefer the RUN DATE - "opus · 24 Jul" tells a
    // reader something, where "opus · ba1de88a" only tells them the two are not
    // the same. Fall back to the fingerprint, then the id, so a variant is never
    // rendered indistinguishable from another.
    // A date only disambiguates if it is itself unique for this model.
    const date = runDate(v.extracted_at);
    const dateIsUnique = date && (dateCounts.get(`${v.model}|${date}`) ?? 0) === 1;
    const qualifier = (dateIsUnique ? date : "") || v.prompt_fingerprint || v.id;
    out.set(v.id, `${v.model} · ${qualifier}`);
  }
  return out;
}

/** True when any model name appears more than once - the case where the bare
 *  name misleads and the view should say so. */
export function hasAmbiguousModels(variants: LabelledVariant[]): boolean {
  const seen = new Set<string>();
  for (const v of variants) {
    if (seen.has(v.model)) return true;
    seen.add(v.model);
  }
  return false;
}
