import { describe, expect, it } from "vitest";

/** Mirrors IngestViewer.hardenLinks. Kept here as an executable statement of
 *  the rule: an ingest's links are unvetted URLs from documents we did not
 *  write, so the workbench renders them as text and never as links. */
const harden = (html: string) =>
  html
    .replace(/<a\b[^>]*>(\s*<img\b[^>]*>\s*)<\/a>/gi, "$1")
    .replace(/<a\b([^>]*)>/gi, (_m, attrs: string) => {
      const href = /href\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? "";
      const safe = href.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
      return `<span class="dead-link" title="Link in the source, not followed here: ${safe}">`;
    })
    .replace(/<\/a>/gi, "</span>");

describe("an ingest's links are text, not links", () => {
  it("leaves nothing clickable", () => {
    const out = harden('<p>see <a href="http://malware.example/x">this</a> now</p>');
    expect(out).not.toContain("<a ");
    expect(out).not.toContain("href");
    expect(out).toContain("see ");
    expect(out).toContain("this");
    expect(out).toContain("now");
  });

  it("keeps the target readable without making it reachable", () => {
    // Inspectable, so a reviewer can see where the source pointed - the record
    // itself is never rewritten, and Raw still shows the real markdown.
    expect(harden('<a href="http://example.com/a">t</a>')).toContain(
      'title="Link in the source, not followed here: http://example.com/a"',
    );
  });

  it("escapes a hostile href instead of pasting it into an attribute", () => {
    const out = harden('<a href="x&quot; onmouseover=&quot;alert(1)">t</a>');
    expect(out).not.toContain('onmouseover="');
  });

  it("unwraps a link that only wraps an image, leaving no marker", () => {
    // The Fourth Mind: the anchor swallowed the click meant for the image's
    // mark-irrelevant control and navigated to the publisher instead.
    expect(harden('<p><a href="http://www.unknowncountry.com"><img src="/x.jpg"></a></p>')).toBe(
      '<p><img src="/x.jpg"></p>',
    );
  });

  it("keeps the words of a link that wraps text as well as an image", () => {
    const out = harden('<a href="http://e.com"><img src="/x.jpg"> see this</a>');
    expect(out).toContain("<img");
    expect(out).toContain("see this");
    expect(out).not.toContain("<a ");
  });

  it("leaves link-free markup alone", () => {
    expect(harden("<p>no links here</p>")).toBe("<p>no links here</p>");
  });
});
