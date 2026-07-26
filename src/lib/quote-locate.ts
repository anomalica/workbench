/**
 * Finding the source text a claim was drawn from.
 *
 * The audit shows what each model CLAIMED; the pane beside it shows what the
 * models read. Without a link between them the source pane is decoration - you
 * cannot check a claim against its evidence by scrolling two panes by hand.
 *
 * Every claim carries a verbatim `quote`, and the pre-digest is the text that
 * quote was taken from, so locating one inside the other is the link. It is the
 * same lookup the digester's grader performs to score a claim, which is why the
 * failures matter as much as the hits: a quote that CANNOT be found is a claim
 * whose evidence is not in the source - mangled (a speaker label folded into the
 * quote, an exchange stitched across speakers) or fabricated. Measured on
 * jon-stewart, 79-89% of quotes locate and 10-21% do not, and that miss rate
 * tracks the grader's own broken-quote count. So a miss is REPORTED, never
 * silently ignored.
 */

/** Collapse whitespace so a quote matches across line wrapping and the
 *  markdown render. Case is preserved - a case-insensitive match would join
 *  text the source distinguishes. */
export function normaliseForMatch(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export type QuoteMatch = {
  /** Offsets into the NORMALISED haystack. */
  start: number;
  end: number;
  /** "exact" = the whole quote; "prefix" = only its opening ran, so the tail
   *  diverges from the source (a stitched or altered quote). */
  kind: "exact" | "prefix";
};

/** How much of a quote's opening must match for a prefix hit to mean anything.
 *  Short enough to survive a mangled tail, long enough not to land on a common
 *  phrase by chance. */
const PREFIX_CHARS = 60;

/** Below this, a quote cannot anchor anything - ANY match, exact included.
 *  "Yeah." occurs all over a transcript, so its first occurrence is a guess
 *  wearing the costume of an answer: the pane would scroll somewhere confident
 *  and wrong, which is worse than admitting it cannot place the claim. */
const MIN_ANCHOR_CHARS = 20;

/** Locate a claim's quote inside the source text.
 *
 *  Exact first. Failing that, the quote's OPENING - a long quote breaks on a
 *  single altered word, and its first sentence still points at the right place,
 *  which is what a reader needs in order to check the claim. Null when neither
 *  lands: the caller must say so rather than scroll somewhere arbitrary. */
export function findQuote(haystackNorm: string, quote: string): QuoteMatch | null {
  const q = normaliseForMatch(quote);
  if (q.length < MIN_ANCHOR_CHARS) return null;

  const exact = haystackNorm.indexOf(q);
  if (exact >= 0) return { start: exact, end: exact + q.length, kind: "exact" };

  const head = q.slice(0, PREFIX_CHARS);
  if (head.length < MIN_ANCHOR_CHARS) return null;
  const loose = haystackNorm.indexOf(head);
  if (loose >= 0) return { start: loose, end: loose + head.length, kind: "prefix" };

  return null;
}

/** A character of rendered text and where it lives in the DOM. Built by walking
 *  text nodes so a normalised offset maps back to an exact Range - the rendered
 *  markdown's element structure is then irrelevant. */
interface CharPos {
  node: Text;
  offset: number;
}

export interface RenderedText {
  /** Whitespace-normalised text of the whole container. */
  text: string;
  /** Parallel to `text`: where each character came from. */
  pos: CharPos[];
}

/** Walk an element's text nodes into a normalised string plus a per-character
 *  index back into the DOM. */
export function indexRenderedText(root: Node): RenderedText {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = "";
  const pos: CharPos[] = [];
  let pendingSpace = false;

  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    const raw = node.data;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (/\s/.test(ch)) {
        pendingSpace = text.length > 0;
        continue;
      }
      if (pendingSpace) {
        text += " ";
        pos.push({ node, offset: i });
        pendingSpace = false;
      }
      text += ch;
      pos.push({ node, offset: i });
    }
  }
  return { text, pos };
}

/** A DOM Range covering [start, end) of the indexed text, or null if the
 *  offsets fall outside it. */
export function rangeFor(indexed: RenderedText, start: number, end: number): Range | null {
  const first = indexed.pos[start];
  const last = indexed.pos[Math.min(end, indexed.pos.length) - 1];
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
  return range;
}

/** One stretch of source and the claims drawn from it. */
export interface CoverageRun {
  start: number;
  end: number;
  /** Distinct variants whose quote covers this stretch. 0 = nothing claimed it. */
  count: number;
  /** The claims themselves, as `variant\u0000claim_id` keys - what to show when
   *  the reader clicks this stretch and asks "what did they make of THIS?". */
  claims: string[];
}

export interface LocatableClaim {
  quote?: string;
  variant: string;
  /** The claim's own id within its digest. */
  id?: string;
}

/** The key that identifies a claim across the comparison payload and the audit
 *  payload - both carry the digest's own claim id alongside its variant. */
export function claimKey(variant: string, id: string | undefined): string {
  return `${variant}\u0000${id ?? ""}`;
}

/** Where each variant's claims landed in the source, as runs of equal coverage.
 *
 *  This is what makes the source pane observable WITHOUT clicking: shading it by
 *  how many models drew on each stretch shows, at a glance, what everything
 *  agreed on, what only one model took, and - the question the view exists to
 *  answer - which stretches nothing claimed at all. Clicking a claim then
 *  refines that picture rather than being the only way to see it.
 *
 *  Runs are merged so adjacent characters of equal coverage paint as one span:
 *  a highlight per claim would be thousands of overlapping ranges, where this is
 *  a few hundred. */
export function coverageRuns(haystackNorm: string, claims: LocatableClaim[]): CoverageRun[] {
  if (!haystackNorm) return [];
  // Per-character sets are too costly at this size; per-character bitmasks over
  // the variant list keep it to one integer per character.
  const variants = [...new Set(claims.map((c) => c.variant))];
  const bit = new Map(variants.map((v, i) => [v, 1 << i]));
  const mask = new Int32Array(haystackNorm.length);
  // Which claims touch each character. Sparse by design: only located claims
  // appear, and a reader clicking a stretch wants exactly these.
  const at = new Map<number, string[]>();

  for (const c of claims) {
    const hit = findQuote(haystackNorm, c.quote ?? "");
    if (!hit) continue;
    const b = bit.get(c.variant) ?? 0;
    const key = claimKey(c.variant, c.id);
    for (let i = hit.start; i < hit.end; i++) {
      mask[i] |= b;
      const list = at.get(i);
      if (list) list.push(key);
      else at.set(i, [key]);
    }
  }

  const runs: CoverageRun[] = [];
  let start = 0;
  let current = popcount(mask[0] ?? 0);
  const flush = (end: number) => {
    if (current <= 0) return;
    const keys = new Set<string>();
    for (let i = start; i < end; i++) for (const k of at.get(i) ?? []) keys.add(k);
    runs.push({ start, end, count: current, claims: [...keys] });
  };
  for (let i = 1; i <= mask.length; i++) {
    const count = i < mask.length ? popcount(mask[i]) : -1;
    if (count !== current) {
      flush(i);
      start = i;
      current = count;
    }
  }
  return runs;
}

function popcount(n: number): number {
  let c = 0;
  while (n) {
    n &= n - 1;
    c++;
  }
  return c;
}

/** Reverse of {@link indexRenderedText}: the normalised index of a DOM
 *  (node, offset), or -1.
 *
 *  Interaction must resolve a POINT to an OFFSET, not to a stored Range. Ranges
 *  captured at paint time go stale the moment the pane re-renders - their
 *  geometry then describes the old layout while the browser's caret reports the
 *  new one, so a click lands "inside" nothing and the pane appears dead.
 *  Offsets survive because they are recomputed from whatever is on screen now. */
export function offsetOfPoint(indexed: RenderedText, node: Node, offset: number): number {
  let lo = -1;
  let exact = -1;
  for (let i = 0; i < indexed.pos.length; i++) {
    const p = indexed.pos[i];
    if (p.node !== node) continue;
    // A collapsed space and the character after it share a raw offset (the
    // space is emitted at the following character's index), so the LAST entry
    // for an offset is the character itself - the one the reader clicked.
    if (p.offset === offset) exact = i;
    else if (p.offset < offset) lo = i;
    else break;
  }
  return exact >= 0 ? exact : lo;
}

/** The run covering a normalised offset, or null. */
export function runAtOffset(runs: CoverageRun[], offset: number): CoverageRun | null {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = runs[mid];
    if (offset < r.start) hi = mid - 1;
    else if (offset >= r.end) lo = mid + 1;
    else return r;
  }
  return null;
}

/** One piece of the source pane: a stretch of text, and the claims (if any)
 *  drawn from it. */
export interface SourceSegment {
  text: string;
  /** 0 when nothing extracted from this stretch. */
  count: number;
  claims: string[];
}

/** Cut the source into consecutive segments - covered and uncovered alternating
 *  - so the pane can be rendered as REAL ELEMENTS rather than painted ranges.
 *
 *  Painting with the Highlight API looked elegant and could not carry
 *  interaction: a highlight is not an element, so resolving a click meant
 *  mapping a screen point back through the caret API to a stored Range, and
 *  those ranges go stale on any re-render. Rendering a span per segment makes
 *  hover and click ordinary DOM events on the exact text they belong to. */
export function sourceSegments(haystackNorm: string, runs: CoverageRun[]): SourceSegment[] {
  const out: SourceSegment[] = [];
  let at = 0;
  for (const r of runs) {
    if (r.start > at) out.push({ text: haystackNorm.slice(at, r.start), count: 0, claims: [] });
    out.push({
      text: haystackNorm.slice(r.start, r.end),
      count: r.count,
      claims: r.claims,
    });
    at = r.end;
  }
  if (at < haystackNorm.length) {
    out.push({ text: haystackNorm.slice(at), count: 0, claims: [] });
  }
  return out;
}
