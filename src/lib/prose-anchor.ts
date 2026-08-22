/**
 * Anchoring a reviewer's prose selection back into the record body.
 *
 * A word record can anchor by index: every word is an element, so a selection
 * IS a pair of word numbers. A document has no such handle - the reviewer
 * selects rendered HTML, and by then marked has eaten the markdown syntax, the
 * page-marker comments have become divs, and the emphasis markers are gone.
 * There is no offset in the rendered text that means anything in the body.
 *
 * So the selection is anchored the way the record format anchors everything
 * else that has to survive a re-render - by its text (`ingest-format.md`,
 * "Anchor by quote, re-derived"). The body is normalised into something close
 * to what the reader saw, carrying a per-character map back to the real
 * offsets; the selected text is found in THAT, and the map converts the hit
 * back into body offsets the markers can be spliced at.
 *
 * When the same words occur more than once - "Security Inspection" appears on
 * every page of a memo - the text preceding the selection disambiguates. A
 * failure to anchor returns null and the caller declines to write: a note
 * spliced at the wrong offset is worse than one the reviewer has to re-place.
 */

/** Normalised text plus, per character, the offset it came from in the raw
 *  body. */
export interface AnchorIndex {
  text: string;
  /** `map[i]` is the raw offset of `text[i]`. */
  map: number[];
}

/** What the reader saw, near enough to match against: HTML comments dropped
 *  (they are structure, rendered as dividers or not at all), emphasis and code
 *  markers dropped (they are syntax, not words), whitespace collapsed. */
export function indexBody(raw: string): AnchorIndex {
  let text = "";
  const map: number[] = [];
  let pendingSpace = false;
  let i = 0;

  const skipTo = (end: number) => {
    // A dropped run still breaks words apart: "a<!-- x -->b" is two words.
    pendingSpace = text.length > 0;
    i = end;
  };

  while (i < raw.length) {
    if (raw.startsWith("<!--", i)) {
      const close = raw.indexOf("-->", i);
      skipTo(close === -1 ? raw.length : close + 3);
      continue;
    }
    // An equation is dropped, exactly like a marker. It renders as glyphs that
    // are nothing like its source, so it can never be matched by text - and
    // dropping it means no offset ever points inside one, which is what stops
    // a note's marker being spliced into the middle of the LaTeX. A selection
    // spanning an equation anchors on the prose either side and the equation
    // falls inside the span.
    if (raw.startsWith("\\[", i) || raw.startsWith("\\(", i)) {
      const closer = raw[i + 1] === "[" ? "\\]" : "\\)";
      const close = raw.indexOf(closer, i + 2);
      if (close !== -1) {
        skipTo(close + 2);
        continue;
      }
    }
    // Inline annotations are markers, not prose - including any note or
    // highlight already anchored here, so a second note can be placed over
    // words the first one already spans.
    if (raw.startsWith("{{", i)) {
      const close = raw.indexOf("}}", i);
      if (close !== -1) {
        skipTo(close + 2);
        continue;
      }
    }
    const ch = raw[i];
    if (/\s/.test(ch)) {
      pendingSpace = text.length > 0;
      i++;
      continue;
    }
    // Emphasis, code and heading syntax vanish in the render, so they must
    // vanish here too or a selection spanning `**SUBJECT:** Security` never
    // matches. Bare `#` and `>` only count at the start of a line.
    if (ch === "*" || ch === "_" || ch === "`") {
      i++;
      continue;
    }
    if ((ch === "#" || ch === ">") && (i === 0 || raw[i - 1] === "\n" || text.length === 0)) {
      i++;
      continue;
    }
    if (pendingSpace) {
      text += " ";
      map.push(i);
      pendingSpace = false;
    }
    text += ch;
    map.push(i);
    i++;
  }
  return { text, map };
}

/**
 * The text of a range, with rendered equations left out.
 *
 * `range.toString()` reads what KaTeX drew - glyphs bearing no relation to the
 * `\sqrt{\beta}` in the body - so a selection spanning an equation could
 * never be matched back. `indexBody` drops equations for the same reason, and
 * the two only agree if both do.
 */
export function rangeText(range: Range): string {
  const clone = range.cloneContents();
  for (const el of clone.querySelectorAll(".wb-math, .katex")) el.remove();
  return clone.textContent ?? "";
}

/**
 * Which occurrence of `selected` this is, counting from the start of `whole`.
 *
 * The two strings are the rendered text before the selection and the selection
 * itself, both normalised - so this is the same count `locateSelection` makes
 * over the body, and the answer transfers.
 */
export function occurrenceIndex(before: string, selected: string): number {
  const needle = normaliseSelection(selected);
  const lead = normaliseSelection(before);
  if (!needle) return 0;
  let n = 0;
  for (let at = lead.indexOf(needle); at !== -1; at = lead.indexOf(needle, at + 1)) n++;
  return n;
}

/** Collapse a selection's text the same way, so the two can be compared. */
export function normaliseSelection(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export interface BodySpan {
  /** Offsets into the RAW body: `[start, end)`. */
  start: number;
  end: number;
}

/**
 * Where in the body a selection sits, or null when it cannot be placed
 * unambiguously.
 *
 * `before` is the rendered text immediately preceding the selection; when the
 * selected words occur more than once it picks the occurrence whose lead-in
 * matches, which is what makes a note on page 2's "Security Inspection" land
 * on page 2.
 */
export function locateSelection(
  raw: string,
  selected: string,
  before = "",
  index?: AnchorIndex,
  occurrence?: number,
): BodySpan | null {
  const needle = normaliseSelection(selected);
  if (!needle) return null;
  const idx = index ?? indexBody(raw);

  const hits: number[] = [];
  for (let at = idx.text.indexOf(needle); at !== -1; at = idx.text.indexOf(needle, at + 1)) {
    hits.push(at);
    if (hits.length > 200) break;
  }
  if (hits.length === 0) return null;

  // WHICH occurrence, counted in the rendered text the reviewer was looking at.
  // The reader did not choose an arbitrary "FVEY", they chose the third one,
  // and that is knowable exactly rather than inferred from surrounding words.
  // Guessing from the lead-in was the old way and it declines whenever two
  // passages read alike - which in a military report with a repeating
  // classification banner and identical timestamped lines is most of them.
  if (occurrence !== undefined && occurrence >= 0 && occurrence < hits.length) {
    const start = idx.map[hits[occurrence]];
    const lastChar = idx.map[hits[occurrence] + needle.length - 1];
    if (start === undefined || lastChar === undefined) return null;
    return { start, end: lastChar + 1 };
  }

  let hit = hits[0];
  if (hits.length > 1) {
    const lead = normaliseSelection(before);
    // Longest matching lead-in wins; a tie means the context does not
    // distinguish them, and guessing would put the note in the wrong place.
    let best = -1;
    let bestLen = -1;
    let tied = false;
    for (const at of hits) {
      // trimEnd, because the gap between the lead-in and the selection is
      // whitespace the reader's copy of the text does not carry - without it
      // every candidate scores zero and every repeat looks ambiguous.
      const preceding = idx.text
        .slice(0, at)
        .trimEnd()
        .slice(-lead.length || undefined);
      let n = 0;
      while (
        n < preceding.length &&
        preceding[preceding.length - 1 - n] === lead[lead.length - 1 - n]
      )
        n++;
      if (n > bestLen) {
        bestLen = n;
        best = at;
        tied = false;
      } else if (n === bestLen) {
        tied = true;
      }
    }
    if (tied || best === -1) return null;
    hit = best;
  }

  const start = idx.map[hit];
  const lastChar = idx.map[hit + needle.length - 1];
  if (start === undefined || lastChar === undefined) return null;
  return { start, end: lastChar + 1 };
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A short id no live marker in this body is already using. Ids are opaque and
 *  only have to be unique within the record. */
export function mintId(raw: string, seed = 0): string {
  for (let n = seed; ; n++) {
    let id = "";
    let v = n;
    do {
      id = ID_ALPHABET[v % ID_ALPHABET.length] + id;
      v = Math.floor(v / ID_ALPHABET.length);
    } while (v > 0);
    if (!raw.includes(`[${id},`) && !raw.includes(`: ${id}}}`)) return id;
  }
}

/** YAML flow-list scalars are quoted, so a note containing a colon, a quote or
 *  a brace stays one scalar and the `}}` scan stays safe. */
export function quoteScalar(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s+/g, " ").trim()}"`;
}

/** Splice a span note's marker pair around `[start, end)`. The end marker goes
 *  in first so the start offset is still valid when the second splice runs. */
export function insertSpanNote(raw: string, span: BodySpan, id: string, note: string): string {
  const withEnd = `${raw.slice(0, span.end)}{{note-end: ${id}}}${raw.slice(span.end)}`;
  return `${withEnd.slice(0, span.start)}{{note-start: [${id}, ${quoteScalar(note)}]}}${withEnd.slice(span.start)}`;
}

/** Splice a highlight's marker pair around `[start, end)`. */
export function insertHighlight(raw: string, span: BodySpan, id: string): string {
  const withEnd = `${raw.slice(0, span.end)}{{highlight-end: ${id}}}${raw.slice(span.end)}`;
  return `${withEnd.slice(0, span.start)}{{highlight-start: ${id}}}${withEnd.slice(span.start)}`;
}

/** Wrap `[start, end)` in markdown's strikethrough.
 *
 *  For text the SOURCE struck and the extraction did not: a declassification
 *  line ruled through a classification banner, an editor's deletion. The
 *  extraction model reliably strikes some of these and reliably misses others
 *  - it recognises a classification marking and tags it instead - so a
 *  reviewer needs to be able to say so by hand.
 *
 *  Markdown's `~~` does not span a blank line, so a selection crossing one
 *  would produce two stray pairs rather than a strike. The caller checks with
 *  `spansBlankLine` and declines rather than writing something that renders as
 *  tildes.
 */
export function insertStrikethrough(raw: string, span: BodySpan): string {
  const withEnd = `${raw.slice(0, span.end)}~~${raw.slice(span.end)}`;
  return `${withEnd.slice(0, span.start)}~~${withEnd.slice(span.start)}`;
}

/** Does this span cross a paragraph break? */
export function spansBlankLine(raw: string, span: BodySpan): boolean {
  return /\n[ \t]*\n/.test(raw.slice(span.start, span.end));
}

/** Is the span already struck - so the action is to remove it rather than add
 *  another pair? Looks just outside the span, which is where the markers sit. */
export function isStruck(raw: string, span: BodySpan): boolean {
  return (
    raw.slice(Math.max(0, span.start - 2), span.start) === "~~" &&
    raw.slice(span.end, span.end + 2) === "~~"
  );
}

/** Remove the strikethrough markers immediately around `[start, end)`. */
export function removeStrikethrough(raw: string, span: BodySpan): string {
  return raw.slice(0, span.start - 2) + raw.slice(span.start, span.end) + raw.slice(span.end + 2);
}

const CLASSIFICATION_MARKER = /\{\{classification:\s*([^{}]+?)\s*\}\}/g;

const bare = (s: string) => s.replace(/^[("']+|[)"']+$/g, "").trim();

/**
 * Strike a classification marking - by turning it into prose, not by wrapping
 * the annotation.
 *
 * `{{classification: X}}` asserts a marking IN FORCE. A struck banner says the
 * opposite: the marking was removed. So the annotation is REPLACED by the
 * struck text rather than wrapped in it, which is anomalica's rule and not a
 * workaround - `~~{{classification: X}}~~` would assert a live classification
 * AND a strike, and neither the ingester's quality strip nor the digester's
 * annotation strip keeps the marker, so the reviewer would be left with `~~~~`
 * around nothing and no way to tell it had failed.
 *
 * Returns the new body, or null when the selection is not a marking - the
 * caller then strikes it as ordinary text.
 *
 * `before` disambiguates a document that carries the same marking more than
 * once, which every multi-page classified record does.
 */
export function strikeClassification(raw: string, selected: string, before = ""): string | null {
  const want = bare(normaliseSelection(selected));
  if (!want) return null;

  const hits: { start: number; end: number; value: string }[] = [];
  CLASSIFICATION_MARKER.lastIndex = 0;
  for (let m = CLASSIFICATION_MARKER.exec(raw); m; m = CLASSIFICATION_MARKER.exec(raw)) {
    if (bare(normaliseSelection(m[1])) === want) {
      hits.push({ start: m.index, end: m.index + m[0].length, value: bare(m[1]) });
    }
  }
  if (hits.length === 0) return null;

  let hit = hits[0];
  if (hits.length > 1 && before.trim()) {
    // The marking sits just after the text that precedes it, so the first one
    // at or after the lead-in is the one the reviewer is looking at.
    const lead = locateSelection(raw, before);
    if (lead) hit = hits.find((h) => h.start >= lead.end) ?? hit;
  }
  return `${raw.slice(0, hit.start)}~~(${hit.value})~~${raw.slice(hit.end)}`;
}

/** A character that belongs to a word, for the purpose of snapping a
 *  selection. Apostrophes and hyphens are inside words - "Fravor's" and
 *  "forward-looking" are each one word to a reader, and snapping that splits
 *  them reads as a bug. */
const WORD_CHAR = /[\p{L}\p{N}_'’-]/u;

/**
 * Grow a selection out to whole words.
 *
 * A drag stops wherever the pointer was, so a highlight ends up starting
 * mid-word - "as been repeatedly proposed to ex". The word editor has never had
 * this problem because a word IS the unit there; in prose the reviewer is
 * dragging over characters and means words.
 *
 * Mutates and returns the range. Only the text nodes at each end are examined:
 * a selection that starts at the very beginning of a node is already at a
 * boundary, which is why crossing nodes needs no special case.
 */
export function expandToWords(range: Range): Range {
  const { startContainer, endContainer } = range;
  if (startContainer.nodeType === Node.TEXT_NODE) {
    const text = startContainer.textContent ?? "";
    let i = range.startOffset;
    while (i > 0 && WORD_CHAR.test(text[i - 1])) i--;
    range.setStart(startContainer, i);
  }
  if (endContainer.nodeType === Node.TEXT_NODE) {
    const text = endContainer.textContent ?? "";
    let i = range.endOffset;
    while (i < text.length && WORD_CHAR.test(text[i])) i++;
    range.setEnd(endContainer, i);
  }
  return range;
}
