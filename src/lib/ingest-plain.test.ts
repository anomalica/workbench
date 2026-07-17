import { describe, it, expect } from "vitest";
import { plainLines, stripAnnotations, bodyWordCount } from "./ingest-plain";

describe("stripAnnotations", () => {
  it("removes markers but keeps the words they wrap", () => {
    expect(stripAnnotations("the pilot {{t:8.31}}reported a light")).toBe(
      "the pilot reported a light",
    );
    expect(stripAnnotations("{{highlight-start: h1}}a light was seen{{highlight-end: h1}}")).toBe(
      "a light was seen",
    );
    expect(stripAnnotations('{{note-start: [n1,"check this"]}}odd claim{{note-end: n1}}')).toBe(
      "odd claim",
    );
  });

  it("leaves ordinary prose untouched", () => {
    const prose = "The Department of Defense has authorized the release of three videos.";
    expect(stripAnnotations(prose)).toBe(prose);
  });

  it("does not eat square brackets that are part of the text", () => {
    // [irrelevant] speaker turns are handled at the line level; a bracket inside
    // a sentence is content and must survive.
    expect(stripAnnotations("the report [sic] said so")).toBe("the report [sic] said so");
  });
});

describe("plainLines", () => {
  it("keeps transcript turns with their speaker", () => {
    const body = "[Speaker 1]: {{t:8.31}}a light was seen\n[Speaker 2]: I remember that";
    expect(plainLines(body)).toEqual([
      { speaker: "Speaker 1", text: "a light was seen", start: 8.31 },
      { speaker: "Speaker 2", text: "I remember that" },
    ]);
  });

  it("keeps prose paragraphs, dropping blank lines", () => {
    const body = "\nFirst paragraph.\n\n\nSecond paragraph.\n";
    expect(plainLines(body)).toEqual([{ text: "First paragraph." }, { text: "Second paragraph." }]);
  });

  it("keeps a speaker turn that strips to nothing - the turn still happened", () => {
    expect(plainLines("[Speaker 1]: {{t:1.0}}")).toEqual([
      { speaker: "Speaker 1", text: "", start: 1 },
    ]);
  });

  it("survives an empty or absent body rather than throwing", () => {
    expect(plainLines("")).toEqual([]);
    expect(plainLines(undefined as unknown as string)).toEqual([]);
  });
});

describe("bodyWordCount", () => {
  it("counts the readable words, not the markers", () => {
    expect(bodyWordCount("[Speaker 1]: {{t:8.31}}a light was seen")).toBe(4);
    expect(bodyWordCount("")).toBe(0);
  });
});
