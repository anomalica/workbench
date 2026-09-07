/**
 * Forgiving search over the record list.
 *
 * A reviewer looking for a record usually remembers a fragment and a shape,
 * not a string: the interviewee's name half-spelt, the outlet, "that ex-CIA
 * one". A plain substring filter answers that with an empty list, because the
 * remembered words are real but scattered across the title and nothing in the
 * record reads exactly as typed. So:
 *
 * - each whitespace-separated word of the query is matched on its own, and
 *   they may land anywhere and in any order ("john cia" finds "Ex-CIA Officer
 *   Confirms Alien Hybrids Exist - John Ramirez");
 * - a word that matches nothing outright is compared letter by letter against
 *   the words of the record, and a near miss counts ("ramirez" typed
 *   "ramriez");
 * - what came back is ordered by how well it matched, so the intended record
 *   is at the top rather than somewhere in a long forgiving list.
 *
 * A word containing a digit is held to an exact match. Dates and episode
 * numbers are the things a reviewer types precisely and the things a typo
 * tolerance ruins - "ep. 42" must not drag in 41, 43 and 47.
 */

/** How far a word may be from what was typed, by the length of what was
 *  typed. Short words are left alone: at three letters, one edit reaches too
 *  many unrelated words to be worth the reach. */
function allowedEdits(length: number): number {
  if (length <= 3) return 0;
  if (length <= 5) return 1;
  if (length <= 8) return 2;
  return 3;
}

/** Optimal string alignment distance - Levenshtein plus adjacent
 *  transposition, because a swapped pair ("Ramriez") is the typo people
 *  actually make. Abandons the comparison once every alignment in flight is
 *  already worse than `limit`, which is what keeps this cheap enough to run
 *  over the whole list on each keystroke. */
export function editDistance(a: string, b: string, limit: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  let curr: number[] = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let best = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      curr[j] = v;
      if (v < best) best = v;
    }
    if (best > limit) return limit + 1;
    prev2 = prev;
    prev = curr;
    curr = new Array(b.length + 1);
  }
  return prev[b.length];
}

/** Lowercase, and reduce every run of non-alphanumerics to one space, so
 *  "Ex-CIA", "ex cia" and "EX/CIA" all split into the same words. The raw
 *  lowercased text is kept alongside for substring tests, so a query that
 *  includes the punctuation ("ep. 42") still matches on its own terms. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

export interface SearchField {
  text: string;
  /** How much a match here counts. Title 1, the supporting metadata less:
   *  a name in the title is what the reviewer meant; the same name in the
   *  publisher column is usually coincidence. */
  weight: number;
}

export interface PreparedFields {
  fields: { raw: string; words: string[]; weight: number }[];
}

/** Split a record's fields into words once, so that work is not repeated on
 *  every keystroke. The record list is long and stable while the query
 *  changes on each letter, so this is the half of the search worth caching. */
export function prepareFields(fields: SearchField[]): PreparedFields {
  return {
    // Heaviest field first, so a word found in the title lets the search stop
    // before it starts spelling-correcting against the publisher column.
    fields: fields
      .filter((f) => f.text)
      .map((f) => ({ weight: f.weight, raw: f.text.toLowerCase(), words: words(f.text) }))
      .sort((a, b) => b.weight - a.weight),
  };
}

/** Best score for one query word against one field, or 0 for no match.
 *  Graded so the ordering reflects how the word was found: as typed, at the
 *  start of a word, inside one, or only after allowing for a typo. */
function scoreTerm(term: string, field: { raw: string; words: string[] }): number {
  if (field.raw.includes(term)) {
    if (field.words.some((w) => w === term)) return 1;
    if (field.words.some((w) => w.startsWith(term))) return 0.9;
    return 0.75;
  }
  // A number is a number: no near misses on dates or episode numbers.
  if (/\d/.test(term)) return 0;
  const limit = allowedEdits(term.length);
  if (limit === 0) return 0;
  let best = 0;
  for (const w of field.words) {
    const d = editDistance(term, w, limit);
    if (d > limit) continue;
    // A typo costs more the further out it is, and always ranks below a word
    // that was actually found.
    const score = 0.6 * (1 - d / (limit + 1));
    if (score > best) best = score;
  }
  return best;
}

/**
 * Score `query` against `fields`, or null when it does not match.
 *
 * Every word of the query has to be found somewhere - the words narrow the
 * list together, they do not each widen it - which is what lets a reviewer add
 * a word to cut a long result list down rather than watching it grow.
 */
export function fuzzyScore(query: string, fields: SearchField[]): number | null {
  return scorePrepared(query, prepareFields(fields));
}

/** As `fuzzyScore`, against fields already split by `prepareFields`. */
export function scorePrepared(query: string, prepared: PreparedFields): number | null {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return null;

  let total = 0;
  for (const term of terms) {
    let best = 0;
    for (const field of prepared.fields) {
      // Nothing left can beat what we have: a field scores at most its own
      // weight, and the fields are in descending weight order.
      if (best >= field.weight) break;
      const s = scoreTerm(term, field) * field.weight;
      if (s > best) best = s;
    }
    if (best === 0) return null;
    total += best;
  }

  // The whole query found intact outranks the same words gathered from across
  // the record, so an exact phrase still comes first.
  const phrase = query.toLowerCase().trim();
  if (terms.length > 1 && prepared.fields.some((f) => f.raw.includes(phrase))) {
    total += terms.length * 0.5;
  }
  return total / terms.length;
}
