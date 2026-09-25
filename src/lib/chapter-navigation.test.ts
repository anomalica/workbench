import { describe, expect, it } from "vitest";
import { chapterSections } from "./chapter-navigation";

describe("ingest chapter navigation", () => {
  it("identifies a real chapter heading despite an inline Kindle coordinate", () => {
    const sections = chapterSections(`Before.

<!-- chapter: 18 -->
<!-- chapter_title: "A Soul’s Journey" -->

{{_kindle_position: 443604}}**Chapter Eighteen: A Soul’s Journey**

{{_kindle_position: 443638}}Iwas lying down.`);
    expect(sections).toEqual([{
      markerLine: 2,
      headingLine: 5,
      number: "18",
      title: "A Soul’s Journey",
      printedHeading: "Chapter Eighteen: A Soul’s Journey",
      label: "Chapter 18: A Soul’s Journey",
    }]);
  });

  it("uses the source's section label when an image precedes prose but no printed heading exists", () => {
    const sections = chapterSections(`<!-- chapter_title: "Foreword" -->

<!--
image:
  file: abc.jpg
-->

{{_kindle_position: 12}}This is a foreword.`);
    expect(sections).toEqual([{
      markerLine: 0,
      headingLine: 7,
      number: null,
      title: "Foreword",
      printedHeading: null,
      label: "Foreword",
    }]);
  });

  it("does not turn an unrelated bold paragraph into a chapter heading", () => {
    const sections = chapterSections('<!-- chapter: 1 -->\n<!-- chapter_title: "Origin" -->\n\n**Important warning**');
    expect(sections[0].printedHeading).toBeNull();
    expect(sections[0].label).toBe("Chapter 1: Origin");
  });
});
