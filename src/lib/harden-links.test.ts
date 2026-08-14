import { describe, expect, it } from "vitest";

/** Mirrors IngestViewer.hardenLinks. Kept here as an executable statement of
 *  the rule: a rendered ingest is somebody else's document, and its links must
 *  never carry the reviewer out of the workbench or eat a click meant for the
 *  editor's own controls. */
const harden = (html: string) =>
  html
    .replace(/<a\b[^>]*>(\s*<img\b[^>]*>\s*)<\/a>/gi, "$1")
    .replace(/<a\b(?![^>]*\btarget=)/gi, '<a target="_blank" rel="noopener noreferrer nofollow"');

describe("hardening a rendered ingest's links", () => {
  it("unwraps a link that only wraps an image", () => {
    // The Fourth Mind: `[<!-- image -->](http://www.unknowncountry.com)`. The
    // anchor swallowed the click meant for the image's mark-irrelevant control
    // and navigated the workbench to the publisher instead.
    const out = harden(
      '<p><a href="http://www.unknowncountry.com"><img src="/x.jpg" alt="a"></a></p>',
    );
    expect(out).toBe('<p><img src="/x.jpg" alt="a"></p>');
    expect(out).not.toContain("<a");
  });

  it("sends every other link to a new tab, with the opener severed", () => {
    const out = harden('<a href="http://example.com">a source</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });

  it("leaves a link that already chose a target alone", () => {
    const out = harden('<a target="_self" href="#x">x</a>');
    expect(out).toBe('<a target="_self" href="#x">x</a>');
  });

  it("keeps a link that wraps text as well as an image", () => {
    // Only the image-only case is publisher chrome; a link with words is
    // something the reader may want to follow.
    const html = '<a href="http://e.com"><img src="/x.jpg"> see this</a>';
    expect(harden(html)).toContain("<a target=");
    expect(harden(html)).toContain("<img");
  });

  it("does not touch the page's own markup outside the body", () => {
    expect(harden("<p>no links here</p>")).toBe("<p>no links here</p>");
  });
});
