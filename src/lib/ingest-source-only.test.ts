import { describe, expect, it } from "vitest";
import yaml from "js-yaml";
import { stripSourceOnlyInline, visibleAnnotationContent } from "./ingest-source-only";

describe("source-only annotations in the Ingest reading view", () => {
  it("hides both fields of the existing Transformation 2026 Kindle comments", () => {
    expect(visibleAnnotationContent("kindle_position: 2147\nelement_id: 392")).toBe("");
    expect(visibleAnnotationContent("kindle_position: 89")).toBe("");
  });

  it("keeps visible fields in the same block without displaying hidden ones", () => {
    const speaker = visibleAnnotationContent("speaker: Jane\n_start_seconds: 42.1");
    expect(yaml.load(speaker)).toEqual({ speaker: "Jane" });

    const image = visibleAnnotationContent(
      'image:\n  _file: abc123def4567.jpg\n  description: "Map labels the site"',
    );
    expect(yaml.load(image)).toEqual({ image: { description: "Map labels the site" } });
  });

  it("removes only source-only inline markers, leaving the words and notes", () => {
    expect(stripSourceOnlyInline("{{_kindle_position: 2147}}Text {{_t: 2.50}}here {{laughs}}")).toBe(
      "Text here {{laughs}}",
    );
  });

  it("keeps other annotations and malformed comments visible for review", () => {
    expect(visibleAnnotationContent("redacted: two lines")).toBe("redacted: two lines");
    expect(visibleAnnotationContent("_new: [broken")).toBe("_new: [broken");
  });

  it("does not hide an exclusion marker without excluding its prose", () => {
    expect(visibleAnnotationContent("_irrelevant: start")).toBe("_irrelevant: start");
    expect(stripSourceOnlyInline("{{_irrelevant: start}}kept visible")).toBe(
      "{{_irrelevant: start}}kept visible",
    );
  });
});
