/**
 * Offering the names the corpus already uses, while one is being typed.
 *
 * The problem is not spelling, it is FORMAT. The same person is written
 * "Buzz Aldrin" in one ingest and "Buzz Aldrin (External Footage)" in another;
 * a nickname might be Bob, "Bob", or (Bob). Nobody remembers which they chose
 * three records ago, and by the time a duplicate exists nothing in the pipeline
 * can tell the two apart - they are simply two speakers.
 *
 * So the fix is to show the existing spelling at the moment the next one is
 * typed, and make taking it cheaper than retyping it.
 */

export interface KnownSpeaker {
  name: string;
  /** How many ingests use this exact spelling. */
  ingests: number;
}

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Where in the name the query hit, lower is better: 0 = the name starts with
 *  it, 1 = a word inside it does. */
function rank(name: string, query: string): number | null {
  const n = fold(name);
  const q = fold(query);
  if (n.startsWith(q)) return 0;
  // A word boundary, so typing "bob" reaches Robert "Bob" Bigelow but "ob"
  // does not - matching mid-word turns the list into noise.
  if (new RegExp(`[\\s"'“”‘’(\\[-]${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(n)) return 1;
  // No mid-word matching: "ob" would reach Robert, and a list that answers
  // every keystroke with everything is one nobody reads.
  return null;
}

/**
 * Existing names worth offering for `query`, best first.
 *
 * An exact match is dropped: the reviewer has already typed that name, so
 * offering it back is a row that cannot teach them anything. Names already
 * used in THIS record are dropped too - they are in the list above the input.
 */
export function suggestSpeakers(
  all: KnownSpeaker[],
  query: string,
  used: Iterable<string> = [],
  limit = 6,
): KnownSpeaker[] {
  const q = query.trim();
  if (q.length < 2) return [];
  const taken = new Set([...used].map(fold));
  const hits: { s: KnownSpeaker; r: number }[] = [];
  for (const s of all) {
    if (taken.has(fold(s.name)) || fold(s.name) === fold(q)) continue;
    const r = rank(s.name, q);
    if (r !== null) hits.push({ s, r });
  }
  hits.sort((a, b) => a.r - b.r || b.s.ingests - a.s.ingests || a.s.name.localeCompare(b.s.name));
  return hits.slice(0, limit).map((h) => h.s);
}
