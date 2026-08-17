/**
 * One markdown configuration for every prose path in the workbench.
 *
 * `breaks: true` is the whole reason this module exists. CommonMark folds a
 * single newline into a space, which is right for a wrapped paragraph and wrong
 * for everything a record actually contains: a letterhead
 *
 *     HEADQUARTERS, DETACHMENT D
 *     1100TH USAF SPECIAL REPORTING GROUP
 *     Campbell Air Force Base
 *
 * rendered as one run-on line, an address block folded into its recipient, a
 * signature block where the name, rank and role become a sentence. The record
 * stores those as separate lines because they ARE separate lines in the source
 * document, and a reviewer judging whether the extraction is faithful is
 * looking at the shape as much as the words.
 *
 * The cost is records whose prose was hard-wrapped at extraction (a couple of
 * emails, wrapped at ~72 columns by the mail client that sent them). Those now
 * render at their original wrap - which is also what the source looked like, so
 * it is not a regression to trade for.
 */

import katex from "katex";
import { marked } from "marked";

marked.use({ breaks: true });

export { marked };

/**
 * Mathematics: lifted out of the source before anything else parses it.
 *
 * Records carry equations as LaTeX (`ingest-format.md`, "Mathematics") because
 * flattening them to unicode loses the maths. In `r = R · √β · Fsky · Ω/(Fsun ·
 * α)` a reader cannot tell whether the radical covers `β` alone or the whole
 * product, and the subscripts on `F_sky` and `α_moon` are simply gone.
 *
 * The delimiters are `\[ ... \]` and `\( ... \)` rather than dollars, because
 * this corpus is full of budget figures and "$50-$60 million" would open an
 * equation at `$5` and close it before `60`, swallowing the prose between.
 *
 * KaTeX's usual auto-render walks the RENDERED page looking for those
 * delimiters, and here it would find none: CommonMark treats `\(` and `\[` as
 * escaped punctuation, so `\( r = R\sqrt{\beta} \)` reaches the DOM as
 * `( r = R\sqrt{\beta} )` with the backslashes gone. Nothing to match, no
 * error raised, and a page of LaTeX source that reads as the model having
 * written bad LaTeX. So the maths comes out FIRST, marked renders the prose
 * around a placeholder, and the rendered maths goes back in.
 *
 * Lifting first also settles two collisions at once, rather than requiring
 * every later stage to know about maths: the annotation grammar owns `{{ }}`
 * and `\frac{{a}}{{b}}` is indistinguishable from a marker, and a note
 * anchored inside an equation would splice a marker into the LaTeX.
 */

/** Display `\[ ... \]` or inline `\( ... \)`. Non-greedy, so two equations in
 *  one paragraph stay two. */
const MATH = /\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)/g;

/** Marks a lifted equation's place in the text. A private-use character
 *  because the placeholder has to survive markdown, the annotation pass, the
 *  redaction pass and the span-marker pass untouched: no record body contains
 *  one, and nothing downstream treats it as syntax. */
const SLOT_OPEN = "\uE000";
const SLOT_CLOSE = "\uE001";
const SLOT_PATTERN = /\uE000(\d+)\uE001/g;

export interface LiftedMath {
  tex: string;
  display: boolean;
}

export function liftMath(src: string): { text: string; held: LiftedMath[] } {
  const held: LiftedMath[] = [];
  const text = src.replace(MATH, (_match, block, inline) => {
    held.push({ tex: (block ?? inline).trim(), display: block !== undefined });
    return `${SLOT_OPEN}${held.length - 1}${SLOT_CLOSE}`;
  });
  return { text, held };
}

function escapeAttribute(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Render one equation. Errors do not throw: unparseable LaTeX renders as its
 *  own source, which is still faithful and still readable - the reason for
 *  carrying LaTeX at all - where a thrown error would blank the whole record. */
function renderOne({ tex, display }: LiftedMath): string {
  const rendered = katex.renderToString(tex, {
    displayMode: display,
    throwOnError: false,
    strict: false,
    // HTML only. The default emits a MathML copy as well, and BOTH land in a
    // text selection - "The radius is \n(r)\n=\n(R)\n(beta)\nr=R√β in the
    // paper." - which no anchor can match back to the body, so a reviewer
    // could not place a note on any paragraph containing an equation.
    output: "html",
  });
  const kind = display ? "wb-math wb-math-display" : "wb-math";
  return `<span class="${kind}" data-tex="${escapeAttribute(tex)}">${rendered}</span>`;
}

export function restoreMath(html: string, held: LiftedMath[]): string {
  return html.replace(SLOT_PATTERN, (_match, index) => {
    const equation = held[Number(index)];
    return equation ? renderOne(equation) : "";
  });
}

/**
 * Render prose that may contain equations.
 *
 * `render` is the caller's existing chain - annotations, markdown, redactions,
 * span markers - and it never sees a `\[`. A body with no maths pays one
 * regex miss and is passed through untouched.
 */
export function withMath(src: string, render: (text: string) => string): string {
  const { text, held } = liftMath(src);
  const html = render(text);
  return held.length ? restoreMath(html, held) : html;
}
