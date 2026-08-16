/**
 * Catching a typed speaker name that is one slip away from one already in use.
 *
 * Every misspelling in the corpus was typed in this UI: the ingester's audio
 * handler only ever writes `Speaker 1`, `Speaker 2`, `Speaker 3`, and the
 * variants appear in the very next commit, the review. "Jessie Michaels" for
 * Jesse Michels, "Ross Couthart" for Ross Coulthart, "Derakhsani" for
 * "Derakshani" - these are typing errors, not knowledge errors. The reviewer
 * knew the name.
 *
 * It SUGGESTS and never rewrites. The assimilator once filed thirty claims
 * about a Pentagon official under a late US Senator because a fuzzy matcher
 * landed on its threshold, and misattributing one person's words to another is
 * the worst thing this system can do - and it does it silently. So a near miss
 * asks; people with genuinely similar names exist.
 */

/** Levenshtein, capped: anything past `max` is not a near miss and the exact
 *  distance stops mattering. */
export function editDistance(a: string, b: string, max = 3): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  if (Math.abs(s.length - t.length) > max) return max + 1;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      best = Math.min(best, row[j]);
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[t.length];
}

/** How close two names may be before the difference is probably deliberate.
 *  Short names get a tighter budget: "Ben" and "Ken" are two different people,
 *  while two characters in a twenty-letter name is a slip. */
function budget(name: string): number {
  if (name.length <= 6) return 1;
  return name.length <= 12 ? 1 : 2;
}

/** The existing name a newly typed one is probably a misspelling of, or null.
 *  Exact matches return null - that is not a near miss, it is the same name. */
export function nearMiss(typed: string, existing: readonly string[]): string | null {
  const name = typed.trim();
  if (name.length < 3) return null;
  const allowed = budget(name);
  let best: string | null = null;
  let bestDistance = allowed + 1;
  for (const other of existing) {
    const d = editDistance(name, other, allowed);
    if (d === 0) return null;
    if (d <= allowed && d < bestDistance) {
      bestDistance = d;
      best = other;
    }
  }
  return best;
}
