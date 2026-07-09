/** Smallest permitted spacing between two consecutive word starts, in seconds.
 *  One unit of the on-disk `{{t:N.NN}}` resolution, so a word pushed up against
 *  its neighbour still serialises to a distinct, strictly later timestamp. */
export const MIN_WORD_GAP = 0.01;

export interface RetimeBounds {
  /** Start of the word immediately BEFORE the range. Immovable: the push stops
   *  here rather than cascading back through the rest of the transcript. Null
   *  when the range opens the record, in which case the floor is 0. */
  prevStart?: number | null;
  /** Start of the word immediately AFTER the range. Immovable, same reasoning.
   *  Null when the range closes the record. */
  nextStart?: number | null;
  /** Media length: the ceiling when nothing follows the range. Null/omitted
   *  leaves the range unbounded above. */
  mediaDuration?: number | null;
}

/** Move `starts[index]` to `t`, bulldozing the neighbours it runs into.
 *
 *  A word that would land on (or past) a neighbour pushes that neighbour ahead
 *  of it by `MIN_WORD_GAP`, which in turn pushes its own neighbour, and so on.
 *  The cascade is bounded by `prevStart` and `nextStart` - the words either side
 *  of the range - which never move: retiming a selection can never disturb
 *  timestamps outside it. `starts` must be ascending; the result is too.
 *
 *  When the bounded window is too narrow to hold every word at `MIN_WORD_GAP`,
 *  the words compress evenly to fit rather than overflowing the window. */
export function retimeWithPush(
  starts: number[],
  index: number,
  t: number,
  bounds: RetimeBounds = {},
): number[] {
  const next = starts.slice();
  const n = next.length;
  if (index < 0 || index >= n) return next;

  const { prevStart = null, nextStart = null, mediaDuration = null } = bounds;
  // The window the whole range must fit inside: `first` is the lowest start the
  // range's first word may take, `last` the highest its last word may take.
  const first = prevStart === null ? 0 : prevStart + MIN_WORD_GAP;
  const last = Math.max(
    first,
    nextStart === null ? (mediaDuration ?? Number.POSITIVE_INFINITY) : nextStart - MIN_WORD_GAP,
  );

  const span = last - first;
  const gap =
    n > 1 && Number.isFinite(span) ? Math.min(MIN_WORD_GAP, span / (n - 1)) : MIN_WORD_GAP;

  // Room the words either side of `j` need within the window, so a word can
  // never be placed where its neighbours have nowhere left to go.
  const lo = (j: number) => first + j * gap;
  const hi = (j: number) => last - (n - 1 - j) * gap;

  next[index] = Math.min(Math.max(t, lo(index)), hi(index));
  // Each pass enforces the gap against the word just retimed, then re-clamps to
  // the window - so a word already outside it (from an earlier bound change) is
  // pulled back in rather than left stranded past `first`/`last`.
  for (let j = index - 1; j >= 0; j--)
    next[j] = Math.max(lo(j), Math.min(next[j], next[j + 1] - gap));
  for (let j = index + 1; j < n; j++)
    next[j] = Math.min(hi(j), Math.max(next[j], next[j - 1] + gap));

  return next;
}
