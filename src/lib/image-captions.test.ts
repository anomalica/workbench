import { describe, expect, it } from "vitest";
import yaml from "js-yaml";
import {
  hasPrecedingImage,
  imageRefsInBody,
  imageIsIrrelevantAt,
  imageDescriptionAt,
  markAsCaption,
  moveCaptionTo,
  remapSpans,
  setImageRelevanceAt,
  setImageDescriptionAt,
} from "./image-captions";
import { parseTextBlocks, totalUnits } from "./text-blocks";

// A body with a structured image annotation followed by a loose caption
// paragraph, then more prose. Line indices (0-based):
//  0 ""                    5 "-->"
//  1 "Intro."              6 ""
//  2 ""                    7 "*Photo: a man in a suit. (c) D. Grusch.*"
//  3 "<!--"                8 ""
//  4 "image:"              9 "Body continues here."
//    ...
const BODY = [
  "",
  "Intro.",
  "",
  "<!--",
  "image:",
  "  file: abc123def456.jpg",
  '  alt: "a man"',
  "-->",
  "",
  "*Photo: a man in a suit. (c) D. Grusch.*",
  "",
  "Body continues here.",
].join("\n");

const CAPTION_FROM = 9;
const CAPTION_TO = 9;
// The image annotation's opening fence - an image's identity, not its `file`.
const IMAGE_LINE = 3;

function parseAnnotation(body: string): Record<string, unknown> {
  const lines = body.split("\n");
  const from = lines.indexOf("<!--");
  const to = lines.indexOf("-->");
  const inner = lines.slice(from + 1, to).join("\n");
  return (yaml.load(inner) as { image: Record<string, unknown> }).image;
}

describe("hasPrecedingImage", () => {
  it("is true for a block below an image annotation", () => {
    expect(hasPrecedingImage(BODY, CAPTION_FROM)).toBe(true);
  });
  it("is false with no image above", () => {
    expect(hasPrecedingImage("No images here.\n\nJust prose.", 2)).toBe(false);
  });
});

describe("markAsCaption", () => {
  it("moves the prose into the annotation caption, verbatim minus emphasis", () => {
    const { ok, body } = markAsCaption(BODY, CAPTION_FROM, CAPTION_TO);
    expect(ok).toBe(true);
    // The loose paragraph is gone from the body prose.
    expect(body).not.toContain("*Photo: a man in a suit");
    expect(body).not.toMatch(/^\*Photo/m);
    // ... and now lives on the image, emphasis unwrapped, copyright kept.
    const img = parseAnnotation(body);
    expect(img.caption).toBe("Photo: a man in a suit. (c) D. Grusch.");
    expect(img.file).toBe("abc123def456.jpg");
    expect(img.alt).toBe("a man");
    // The following prose survives.
    expect(body).toContain("Body continues here.");
  });

  it("does not leave a double blank where the prose was", () => {
    const { body } = markAsCaption(BODY, CAPTION_FROM, CAPTION_TO);
    expect(body).not.toContain("\n\n\n");
  });

  it("attaches to the NEAREST preceding image when several exist", () => {
    const body = [
      "<!--",
      "image:",
      "  file: aaa111bbb222.jpg",
      "-->",
      "",
      "First figure text.",
      "",
      "<!--",
      "image:",
      "  file: ccc333ddd444.jpg",
      "-->",
      "",
      "Second figure caption.",
    ].join("\n");
    const out = markAsCaption(body, 12, 12);
    expect(out.ok).toBe(true);
    const lines = out.body.split("\n");
    // The second annotation (ccc333) gained the caption; the first did not.
    const second = lines.slice(lines.lastIndexOf("<!--") + 1, lines.lastIndexOf("-->"));
    expect(second.join("\n")).toContain("Second figure caption.");
    const first = lines.slice(lines.indexOf("<!--") + 1, lines.indexOf("-->"));
    expect(first.join("\n")).not.toContain("caption");
  });

  it("replaces an existing caption rather than duplicating it", () => {
    const body = [
      "<!--",
      "image:",
      "  file: abc123def456.jpg",
      '  caption: "Old caption."',
      "-->",
      "",
      "New caption text.",
    ].join("\n");
    const out = markAsCaption(body, 6, 6);
    const img = parseAnnotation(out.body);
    expect(img.caption).toBe("New caption text.");
    // Exactly one caption line.
    expect(out.body.match(/caption:/g)?.length).toBe(1);
  });

  it("quotes captions containing YAML-special characters safely", () => {
    const body = [
      "<!--",
      "image:",
      "  file: abc123def456.jpg",
      "-->",
      "",
      'He said: "it was 40:1", really.',
    ].join("\n");
    const out = markAsCaption(body, 5, 5);
    // Round-trips through the YAML parser unchanged.
    const img = parseAnnotation(out.body);
    expect(img.caption).toBe('He said: "it was 40:1", really.');
  });

  it("refuses to caption an annotation block (its own markup)", () => {
    // Selecting the image annotation itself (lines 3-6) must not move its
    // markup into a preceding image's caption.
    const body = [
      "<!--",
      "image:",
      "  file: aaa111bbb222.jpg",
      "-->",
      "",
      "<!--",
      "image:",
      "  file: ccc333ddd444.jpg",
      "-->",
    ].join("\n");
    const out = markAsCaption(body, 5, 8);
    expect(out.ok).toBe(false);
    expect(out.body).toBe(body);
  });

  it("is a no-op with no preceding image", () => {
    const body = "Just prose.\n\nMore prose.";
    const out = markAsCaption(body, 2, 2);
    expect(out.ok).toBe(false);
    expect(out.body).toBe(body);
  });

  it("strips inline emphasis around only part of the caption (attribution)", () => {
    const body = [
      "<!--",
      "image:",
      "  file: abc123def456.jpg",
      "-->",
      "",
      "Major Jesse Marcel with the debris, 1947. *(University of Texas Library)*",
    ].join("\n");
    const out = markAsCaption(body, 5, 5);
    expect(parseAnnotation(out.body).caption).toBe(
      "Major Jesse Marcel with the debris, 1947. (University of Texas Library)",
    );
  });

  it("joins a soft-wrapped multi-line caption into one", () => {
    const body = [
      "<!--",
      "image:",
      "  file: abc123def456.jpg",
      "-->",
      "",
      "A caption that wraps",
      "across two source lines.",
    ].join("\n");
    const out = markAsCaption(body, 5, 6);
    expect(parseAnnotation(out.body).caption).toBe("A caption that wraps across two source lines.");
  });
});

describe("remapSpans", () => {
  it("shifts a read-mark below the edit and drops the captioned block's mark", () => {
    // Reviewer had read the caption block (line 9) and the body after it (11).
    const spans = [
      { from: 1, to: 1 }, // Intro, above the image - unmoved
      { from: 9, to: 9 }, // the caption block - removed
      { from: 11, to: 11 }, // Body continues - shifts by the net line delta
    ];
    const { oldToNew } = markAsCaption(BODY, CAPTION_FROM, CAPTION_TO);
    const shifted = remapSpans(spans, oldToNew);
    // Intro stays; the caption-block mark is gone; the trailing mark survives
    // and still points at "Body continues here.".
    expect(shifted.find((s) => s.from === 1)).toBeTruthy();
    expect(shifted.some((s) => s.from === oldToNew[11])).toBe(true);
    const newLines = markAsCaption(BODY, CAPTION_FROM, CAPTION_TO).body.split("\n");
    const mark = shifted.find((s) => s.from === oldToNew[11])!;
    expect(newLines[mark.from]).toBe("Body continues here.");
  });
});

describe("caption re-targeting", () => {
  const TWO_IMAGES = [
    "<!--",
    "image:",
    "  file: aaa111bbb222.jpg",
    "-->",
    "",
    "<!--",
    "image:",
    "  file: ccc333ddd444.jpg",
    "-->",
    "",
    "The caption paragraph.",
  ].join("\n");

  it("markAsCaption reports the annotation it attached to", () => {
    const out = markAsCaption(TWO_IMAGES, 10, 10);
    expect(out.ok).toBe(true);
    expect(out.imageLine).toBe(5); // nearest preceding
    expect(out.imageFile).toBe("ccc333ddd444.jpg");
  });

  it("imageRefsInBody lists every image in order, by line", () => {
    expect(imageRefsInBody(TWO_IMAGES)).toEqual([
      { line: 0, file: "aaa111bbb222.jpg" },
      { line: 5, file: "ccc333ddd444.jpg" },
    ]);
  });

  it("moves a caption from one image to another", () => {
    // First attach to nearest (ccc333 at line 5), then re-target to aaa111.
    const attached = markAsCaption(TWO_IMAGES, 10, 10);
    const moved = moveCaptionTo(attached.body, 5, 0);
    expect(moved.ok).toBe(true);
    expect(moved.imageLine).toBe(0);
    expect(moved.imageFile).toBe("aaa111bbb222.jpg");
    const lines = moved.body.split("\n");
    // The target (aaa111) now carries the caption; the source (ccc333) doesn't.
    const firstEnd = lines.indexOf("-->");
    const first = lines.slice(0, firstEnd + 1).join("\n");
    const second = lines.slice(firstEnd + 1).join("\n");
    expect(first).toContain('caption: "The caption paragraph."');
    expect(second).not.toContain("caption");
    // Exactly one caption line survives the move.
    expect(moved.body.match(/caption:/g)?.length).toBe(1);
  });

  it("re-target is a no-op to the same image or a missing one", () => {
    const attached = markAsCaption(TWO_IMAGES, 10, 10);
    expect(moveCaptionTo(attached.body, 5, 5).ok).toBe(false);
    expect(moveCaptionTo(attached.body, 5, 99).ok).toBe(false);
    expect(moveCaptionTo(attached.body, 5, 1).ok).toBe(false); // mid-annotation line
  });
});

// Media dedupes by content hash, so a figure that repeats in the source (a
// chapter ornament, a re-used plate) is annotated twice with the SAME `file` -
// American Cosmic opens with two of 6f27aaa3c75c.jpg. Identity is therefore the
// annotation's line: keyed by file, both controls resolved to the first
// annotation, so the second figure edited the wrong one and then went dead (the
// flag was already set, so every further click no-op'd).
describe("a file annotated twice is two independent images", () => {
  const REPEATED = [
    "<!--",
    "image:",
    "  file: 6f27aaa3c75c.jpg",
    '  alt: "image"',
    "-->",
    "",
    "<!--",
    "image:",
    "  file: 6f27aaa3c75c.jpg",
    '  alt: "image"',
    "-->",
    "",
    "Chapter one begins.",
  ].join("\n");
  const FIRST = 0;
  const SECOND = 6;

  it("lists both occurrences, distinguished by line", () => {
    expect(imageRefsInBody(REPEATED)).toEqual([
      { line: FIRST, file: "6f27aaa3c75c.jpg" },
      { line: SECOND, file: "6f27aaa3c75c.jpg" },
    ]);
  });

  it("marks the second one irrelevant without touching the first", () => {
    const { ok, body } = setImageRelevanceAt(REPEATED, SECOND, true);
    expect(ok).toBe(true);
    expect(imageIsIrrelevantAt(body, SECOND)).toBe(true);
    expect(imageIsIrrelevantAt(body, FIRST)).toBe(false);
    expect(body.match(/irrelevant: true/g)?.length).toBe(1);
  });

  it("marks both, one click each, and clears them independently", () => {
    const first = setImageRelevanceAt(REPEATED, FIRST, true);
    expect(first.ok).toBe(true);
    // The first annotation grew a line, so the second one moved down with it.
    const secondLine = first.oldToNew[SECOND];
    const both = setImageRelevanceAt(first.body, secondLine, true);
    expect(both.ok).toBe(true);
    expect(both.body.match(/irrelevant: true/g)?.length).toBe(2);
    const cleared = setImageRelevanceAt(both.body, FIRST, false);
    expect(cleared.ok).toBe(true);
    expect(imageIsIrrelevantAt(cleared.body, FIRST)).toBe(false);
    expect(imageIsIrrelevantAt(cleared.body, cleared.oldToNew[secondLine])).toBe(true);
  });

  it("describes each occurrence separately", () => {
    const set = setImageDescriptionAt(REPEATED, SECOND, "The second plate.");
    expect(set.ok).toBe(true);
    expect(imageDescriptionAt(set.body, SECOND)).toBe("The second plate.");
    expect(imageDescriptionAt(set.body, FIRST)).toBe("");
  });
});

describe("setImageRelevanceAt / imageIsIrrelevantAt", () => {
  it("marks an image irrelevant by adding `irrelevant: true` under the mapping", () => {
    const { ok, body } = setImageRelevanceAt(BODY, IMAGE_LINE, true);
    expect(ok).toBe(true);
    expect(parseAnnotation(body).irrelevant).toBe(true);
    expect(imageIsIrrelevantAt(body, IMAGE_LINE)).toBe(true);
    // Round-trips back to keep: clearing removes the line (absent = keep).
    const cleared = setImageRelevanceAt(body, IMAGE_LINE, false);
    expect(cleared.ok).toBe(true);
    expect(cleared.body).toBe(BODY);
    expect(imageIsIrrelevantAt(cleared.body, IMAGE_LINE)).toBe(false);
  });

  it("is a no-op when already in the requested state or the image is missing", () => {
    expect(setImageRelevanceAt(BODY, IMAGE_LINE, false).ok).toBe(false); // already keep
    const marked = setImageRelevanceAt(BODY, IMAGE_LINE, true).body;
    expect(setImageRelevanceAt(marked, IMAGE_LINE, true).ok).toBe(false); // already irrelevant
    expect(setImageRelevanceAt(BODY, 99, true).ok).toBe(false);
  });

  it("does not change reviewable coverage - the image block stays zero-unit", () => {
    const before = totalUnits(parseTextBlocks(BODY));
    const { body } = setImageRelevanceAt(BODY, IMAGE_LINE, true);
    expect(totalUnits(parseTextBlocks(body))).toBe(before);
  });

  it("shifts line-anchored spans past the inserted flag line", () => {
    const { oldToNew } = setImageRelevanceAt(BODY, IMAGE_LINE, true);
    // The prose after the annotation ("Body continues here." at line 11) moves
    // down one, so a coverage span on it follows.
    expect(remapSpans([{ from: 11, to: 11 }], oldToNew)).toEqual([{ from: 12, to: 12 }]);
  });
});

describe("setImageDescriptionAt / imageDescriptionAt", () => {
  it("writes the description into the annotation and reads it back", () => {
    const text = "Tweet by @user: the object remains unidentified.";
    const { ok, body } = setImageDescriptionAt(BODY, IMAGE_LINE, text);
    expect(ok).toBe(true);
    expect(parseAnnotation(body).description).toBe(text);
    expect(imageDescriptionAt(body, IMAGE_LINE)).toBe(text);
  });

  it("replaces an existing description rather than duplicating it", () => {
    const first = setImageDescriptionAt(BODY, IMAGE_LINE, "Old text.").body;
    const second = setImageDescriptionAt(first, IMAGE_LINE, "New text.");
    expect(parseAnnotation(second.body).description).toBe("New text.");
    expect(second.body.match(/description:/g)?.length).toBe(1);
  });

  it("clears the description when set to empty, back to no field", () => {
    const set = setImageDescriptionAt(BODY, IMAGE_LINE, "Something.").body;
    const cleared = setImageDescriptionAt(set, IMAGE_LINE, "  ");
    expect(cleared.ok).toBe(true);
    expect(cleared.body).toBe(BODY);
    expect(imageDescriptionAt(cleared.body, IMAGE_LINE)).toBe("");
  });

  it("is a no-op when unchanged or the image is missing", () => {
    expect(setImageDescriptionAt(BODY, IMAGE_LINE, "").ok).toBe(false); // no description, still none
    const set = setImageDescriptionAt(BODY, IMAGE_LINE, "Same.").body;
    expect(setImageDescriptionAt(set, IMAGE_LINE, "Same.").ok).toBe(false);
    expect(setImageDescriptionAt(BODY, 99, "x").ok).toBe(false);
  });

  it("quotes YAML-special and multi-line text so it round-trips", () => {
    const text = 'Line one: "quoted 40:1".\nLine two.';
    const { body } = setImageDescriptionAt(BODY, IMAGE_LINE, text);
    expect(parseAnnotation(body).description).toBe(text);
    // Stays a single YAML line (newline escaped inside the quoted scalar).
    expect(body.match(/description:/g)?.length).toBe(1);
  });

  it("does not change reviewable coverage - the image block stays zero-unit", () => {
    const before = totalUnits(parseTextBlocks(BODY));
    const { body } = setImageDescriptionAt(BODY, IMAGE_LINE, "A description.");
    expect(totalUnits(parseTextBlocks(body))).toBe(before);
  });
});

describe("an annotation that does not start its own line", () => {
  // The Fourth Mind wraps its title image in a markdown link, so the opener is
  // `[<!--` and the closer is `-->](http://www.unknowncountry.com)`. Requiring
  // the line to BE the marker found no image at all: every control on that
  // record rendered with line -1 and "Mark irrelevant" did nothing.
  const WRAPPED = [
    "# THE FOURTH MIND",
    "",
    "[<!--",
    "image:",
    "  file: e8bda5ecb164.jpg",
    '  alt: "Walker &amp; Collier, Inc"',
    "-->](http://www.unknowncountry.com)",
    "",
    "Body text.",
  ].join("\n");

  it("finds the image and reports the line the annotation opens on", () => {
    const refs = imageRefsInBody(WRAPPED);
    expect(refs).toHaveLength(1);
    expect(refs[0].file).toBe("e8bda5ecb164.jpg");
    expect(refs[0].line).toBe(2);
  });

  it("can mark that image irrelevant", () => {
    const edit = setImageRelevanceAt(WRAPPED, 2, true);
    expect(edit.ok).toBe(true);
    expect(edit.body).toContain("irrelevant: true");
    // The link around it is left exactly as the source had it.
    expect(edit.body).toContain("[<!--");
    expect(edit.body).toContain("-->](http://www.unknowncountry.com)");
  });

  it("still handles a single-line annotation wrapped in a link", () => {
    const one = "[<!-- image: {file: a1b2c3d4e5f6.jpg} -->](http://e.com)";
    expect(imageRefsInBody(one)).toHaveLength(1);
  });

  it("leaves an ordinary annotation exactly as it was", () => {
    const plain = ["<!--", "image:", "  file: 0123456789ab.jpg", "-->"].join("\n");
    expect(imageRefsInBody(plain)).toEqual([{ line: 0, file: "0123456789ab.jpg" }]);
  });
});
