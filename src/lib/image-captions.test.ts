import { describe, expect, it } from "vitest";
import yaml from "js-yaml";
import {
  hasPrecedingImage,
  imageFilesInBody,
  imageIsIrrelevant,
  imageDescription,
  markAsCaption,
  moveCaptionByFile,
  remapSpans,
  setImageRelevanceByFile,
  setImageDescriptionByFile,
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

  it("markAsCaption reports the image file it attached to", () => {
    const out = markAsCaption(TWO_IMAGES, 10, 10);
    expect(out.ok).toBe(true);
    expect(out.imageFile).toBe("ccc333ddd444.jpg"); // nearest preceding
  });

  it("imageFilesInBody lists every image in order", () => {
    expect(imageFilesInBody(TWO_IMAGES)).toEqual(["aaa111bbb222.jpg", "ccc333ddd444.jpg"]);
  });

  it("moves a caption from one image to another", () => {
    // First attach to nearest (ccc333), then re-target to the earlier aaa111.
    const attached = markAsCaption(TWO_IMAGES, 10, 10);
    const moved = moveCaptionByFile(attached.body, "ccc333ddd444.jpg", "aaa111bbb222.jpg");
    expect(moved.ok).toBe(true);
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
    expect(moveCaptionByFile(attached.body, "ccc333ddd444.jpg", "ccc333ddd444.jpg").ok).toBe(false);
    expect(moveCaptionByFile(attached.body, "ccc333ddd444.jpg", "nope999zzz000.jpg").ok).toBe(
      false,
    );
  });
});

describe("setImageRelevanceByFile / imageIsIrrelevant", () => {
  const FILE = "abc123def456.jpg";

  it("marks an image irrelevant by adding `irrelevant: true` under the mapping", () => {
    const { ok, body } = setImageRelevanceByFile(BODY, FILE, true);
    expect(ok).toBe(true);
    expect(parseAnnotation(body).irrelevant).toBe(true);
    expect(imageIsIrrelevant(body, FILE)).toBe(true);
    // Round-trips back to keep: clearing removes the line (absent = keep).
    const cleared = setImageRelevanceByFile(body, FILE, false);
    expect(cleared.ok).toBe(true);
    expect(cleared.body).toBe(BODY);
    expect(imageIsIrrelevant(cleared.body, FILE)).toBe(false);
  });

  it("is a no-op when already in the requested state or the image is missing", () => {
    expect(setImageRelevanceByFile(BODY, FILE, false).ok).toBe(false); // already keep
    const marked = setImageRelevanceByFile(BODY, FILE, true).body;
    expect(setImageRelevanceByFile(marked, FILE, true).ok).toBe(false); // already irrelevant
    expect(setImageRelevanceByFile(BODY, "nope999zzz000.jpg", true).ok).toBe(false);
  });

  it("does not change reviewable coverage - the image block stays zero-unit", () => {
    const before = totalUnits(parseTextBlocks(BODY));
    const { body } = setImageRelevanceByFile(BODY, FILE, true);
    expect(totalUnits(parseTextBlocks(body))).toBe(before);
  });

  it("shifts line-anchored spans past the inserted flag line", () => {
    const { oldToNew } = setImageRelevanceByFile(BODY, FILE, true);
    // The prose after the annotation ("Body continues here." at line 11) moves
    // down one, so a coverage span on it follows.
    expect(remapSpans([{ from: 11, to: 11 }], oldToNew)).toEqual([{ from: 12, to: 12 }]);
  });
});

describe("setImageDescriptionByFile / imageDescription", () => {
  const FILE = "abc123def456.jpg";

  it("writes the description into the annotation and reads it back", () => {
    const text = "Tweet by @user: the object remains unidentified.";
    const { ok, body } = setImageDescriptionByFile(BODY, FILE, text);
    expect(ok).toBe(true);
    expect(parseAnnotation(body).description).toBe(text);
    expect(imageDescription(body, FILE)).toBe(text);
  });

  it("replaces an existing description rather than duplicating it", () => {
    const first = setImageDescriptionByFile(BODY, FILE, "Old text.").body;
    const second = setImageDescriptionByFile(first, FILE, "New text.");
    expect(parseAnnotation(second.body).description).toBe("New text.");
    expect(second.body.match(/description:/g)?.length).toBe(1);
  });

  it("clears the description when set to empty, back to no field", () => {
    const set = setImageDescriptionByFile(BODY, FILE, "Something.").body;
    const cleared = setImageDescriptionByFile(set, FILE, "  ");
    expect(cleared.ok).toBe(true);
    expect(cleared.body).toBe(BODY);
    expect(imageDescription(cleared.body, FILE)).toBe("");
  });

  it("is a no-op when unchanged or the image is missing", () => {
    expect(setImageDescriptionByFile(BODY, FILE, "").ok).toBe(false); // no description, still none
    const set = setImageDescriptionByFile(BODY, FILE, "Same.").body;
    expect(setImageDescriptionByFile(set, FILE, "Same.").ok).toBe(false);
    expect(setImageDescriptionByFile(BODY, "nope999zzz000.jpg", "x").ok).toBe(false);
  });

  it("quotes YAML-special and multi-line text so it round-trips", () => {
    const text = 'Line one: "quoted 40:1".\nLine two.';
    const { body } = setImageDescriptionByFile(BODY, FILE, text);
    expect(parseAnnotation(body).description).toBe(text);
    // Stays a single YAML line (newline escaped inside the quoted scalar).
    expect(body.match(/description:/g)?.length).toBe(1);
  });

  it("does not change reviewable coverage - the image block stays zero-unit", () => {
    const before = totalUnits(parseTextBlocks(BODY));
    const { body } = setImageDescriptionByFile(BODY, FILE, "A description.");
    expect(totalUnits(parseTextBlocks(body))).toBe(before);
  });
});
