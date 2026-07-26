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
