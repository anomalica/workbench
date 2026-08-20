/**
 * Rendering a redaction marker whatever the record states inside it.
 *
 * The spec's example is an extent; the corpus overwhelmingly carries the
 * exemption the redactor cited. Both have to render, and anything else has to
 * render too - annotation syntax leaking into the prose is the one outcome
 * worth ruling out.
 */

import { describe, expect, it } from "vitest";

// The renderer under test, extracted verbatim in shape from IngestViewer's
// renderRedactions so the rules can be exercised without the component.
function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

function renderRedactions(html: string): string {
  return html.replace(/\{\{(redacted|illegible)(?::\s*([^{}]*))?\}\}/g, (_, type, rawValue) => {
    const label = type === "illegible" ? "illegible" : "redacted";
    const parts = String(rawValue ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    let words = 0;
    let chars = 0;
    const citations: string[] = [];
    for (const part of parts) {
      const extent = part.match(/^~\s*(\d+)\s*(word|character|char)s?$/i);
      if (!extent) {
        citations.push(part);
        continue;
      }
      if (extent[2].toLowerCase().startsWith("word")) words += Number(extent[1]);
      else chars += Number(extent[1]);
    }
    const em = chars > 0 ? chars * 0.55 : (words || 1) * 2.5;
    const stated = [
      words ? `~${words} word${words === 1 ? "" : "s"}` : "",
      chars ? `~${chars} character${chars === 1 ? "" : "s"}` : "",
      ...citations,
    ].filter(Boolean);
    const title = escapeHtml(`${label}${stated.length ? `: ${stated.join(", ")}` : ""}`);
    const inside = citations.join(", ");
    const showInside = inside && inside.length <= 12;
    return (
      `<span class="redaction${showInside ? " redaction-cited" : ""}"` +
      ` title="${title}" style="min-width:${em.toFixed(2)}em">` +
      `${showInside ? escapeHtml(inside) : ""}</span>`
    );
  });
}

const render = (s: string) => renderRedactions(s);

describe("nothing leaks as text", () => {
  // 160 of the corpus's 271 markers stated an exemption rather than a size and
  // were shown to the reviewer as raw {{redacted: 1.4a}} mid-sentence.
  const forms = [
    "{{redacted}}",
    "{{redacted: ~2 words}}",
    "{{redacted: 1.4a}}",
    "{{redacted: (b)(6)}}",
    "{{redacted: 3.5c, FOIA Exemption (b)(6)}}",
    "{{redacted: 1.4a, 1.4g}}",
    "{{illegible: possibly March 2004}}",
    "{{redacted: something nobody planned for}}",
  ];
  for (const form of forms) {
    it(`renders ${form}`, () => {
      const out = render(`before ${form} after`);
      expect(out).not.toContain("{{");
      expect(out).toContain('class="redaction');
      expect(out).toContain("before ");
      expect(out).toContain(" after");
    });
  }
});

describe("what the bar says and how wide it is", () => {
  it("prints a short citation inside the bar, as the source does in the box", () => {
    const out = render("{{redacted: 1.4a}}");
    expect(out).toContain("redaction-cited");
    expect(out).toContain(">1.4a<");
  });

  it("keeps a long citation to the tooltip", () => {
    // Otherwise the bar's width comes from its own label rather than from how
    // much was actually removed.
    const out = render("{{redacted: 3.5c, FOIA Exemption (b)(6)}}");
    expect(out).not.toContain("redaction-cited");
    expect(out).toContain('title="redacted: 3.5c, FOIA Exemption (b)(6)"');
  });

  it("sizes from words when the extent is stated", () => {
    expect(render("{{redacted: ~4 words}}")).toContain("min-width:10.00em");
  });

  it("sizes from characters, which is what a boxed redaction actually gives", () => {
    expect(render("{{redacted: ~20 chars}}")).toContain("min-width:11.00em");
    expect(render("{{redacted: ~20 characters}}")).toContain("min-width:11.00em");
  });

  it("takes an extent and a citation together, in either order", () => {
    const both = render("{{redacted: ~12 chars, 1.4a}}");
    expect(both).toContain("min-width:6.60em");
    expect(both).toContain(">1.4a<");
    expect(render("{{redacted: 1.4a, ~12 chars}}")).toContain("min-width:6.60em");
  });

  it("falls back to one word when nothing says how much", () => {
    expect(render("{{redacted}}")).toContain("min-width:2.50em");
    expect(render("{{redacted: 1.4a}}")).toContain("min-width:2.50em");
  });

  it("does not let a citation inject markup", () => {
    expect(render("{{redacted: <img src=x onerror=1>}}")).not.toContain("<img");
  });
});
