/**
 * Equations in a record body.
 *
 * The whole reason this is a pre-pass rather than KaTeX's own auto-render is
 * measurable and is the first test here: markdown eats the delimiters, so by
 * the time anything walks the rendered DOM there is nothing left to find.
 */

import { describe, expect, it } from "vitest";
import { liftMath, marked, withMath } from "./markdown";

const render = (src: string) => withMath(src, (text) => marked.parse(text) as string);

describe("why the maths has to come out first", () => {
  it("markdown destroys the delimiters", () => {
    // CommonMark treats \( and \[ as escaped punctuation and drops the
    // backslash. An auto-render pass over this HTML finds no delimiters, raises
    // no error, and leaves a page of LaTeX source.
    const html = marked.parse("The radius is \\( r = R\\sqrt{\\beta} \\).") as string;
    expect(html).toContain("( r = R\\sqrt{\\beta} )");
    expect(html).not.toContain("\\(");
  });

  it("lifts the maths before markdown sees it", () => {
    const { text, held } = liftMath("The radius is \\( r = R\\sqrt{\\beta} \\).");
    expect(held).toEqual([{ tex: "r = R\\sqrt{\\beta}", display: false }]);
    expect(text).not.toContain("\\sqrt");
  });
});

describe("rendering", () => {
  it("renders an inline equation into the prose around it", () => {
    const html = render("The radius is \\( r = R\\sqrt{\\beta} \\) in the paper.");
    expect(html).toContain("The radius is");
    expect(html).toContain("in the paper.");
    expect(html).toContain('data-tex="r = R\\sqrt{\\beta}"');
    expect(html).toContain("katex");
  });

  it("marks a display equation as its own block", () => {
    const html = render("Result:\n\n\\[ F_{sky} \\Omega \\]\n");
    expect(html).toContain("wb-math-display");
  });

  it("emits no MathML copy", () => {
    // The default output duplicates every equation as MathML, and both copies
    // land in a text selection - which makes the paragraph unanchorable, so a
    // reviewer cannot place a note anywhere near an equation.
    const html = render("Inline \\( x^2 \\) here.");
    expect(html).not.toContain("katex-mathml");
    expect(html).not.toContain("<math");
  });

  it("keeps two equations in one paragraph separate", () => {
    const html = render("First \\( a \\) then \\( b \\).");
    expect(html).toContain('data-tex="a"');
    expect(html).toContain('data-tex="b"');
  });

  it("leaves a body with no maths exactly as markdown rendered it", () => {
    const src = "Just *prose* here.";
    expect(render(src)).toBe(marked.parse(src));
  });
});

describe("what must not be mistaken for maths", () => {
  it("leaves dollar figures alone", () => {
    // The reason the delimiters are not dollars: "$50-$60 million" would open
    // an equation at $5 and close it before 60, swallowing the prose between.
    const html = render("The programme cost $50-$60 million over two years.");
    expect(html).toContain("$50-$60 million");
    expect(html).not.toContain("katex");
  });

  it("carries doubled braces through untouched", () => {
    // The ingester forbids {{ inside a math span because it collides with the
    // annotation grammar. If one arrives anyway, lifting first means it reaches
    // KaTeX rather than being read as a marker.
    const { held } = liftMath("Value \\( x^{{n}} \\) follows.");
    expect(held[0].tex).toBe("x^{{n}}");
  });
});

describe("unparseable LaTeX", () => {
  it("renders as its own source instead of blanking the record", () => {
    // Faithfulness over presentation: the source is still readable and still
    // correct, where a thrown error would take the whole body with it.
    const html = render("Broken \\( \\frac{1}{ \\) here.");
    expect(html).toContain("katex-error");
    expect(html).toContain("Broken");
    expect(html).toContain("here.");
  });

  it("keeps the source recoverable whatever the render did", () => {
    const html = render("Broken \\( \\frac{1}{ \\) here.");
    expect(html).toContain("data-tex=");
  });
});
