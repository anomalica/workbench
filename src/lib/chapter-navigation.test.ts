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
      sourceHeadings: [{ line: 5, text: "Chapter Eighteen: A Soul’s Journey" }],
      label: "Chapter 18: A Soul’s Journey",
    }]);
  });

  it("removes combined bold-italic markup from a Kindle chapter heading", () => {
    const sections = chapterSections(`<!-- chapter_title: "Hypnotic Regression" -->

{{_kindle_position: 122870}}***Hypnotic Regression***`);

    expect(sections[0].sourceHeadings).toEqual([{ line: 2, text: "Hypnotic Regression" }]);
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
      sourceHeadings: [],
      label: "Foreword",
    }]);
  });

  it("does not turn an unrelated bold paragraph into a chapter heading", () => {
    const sections = chapterSections('<!-- chapter: 1 -->\n<!-- chapter_title: "Origin" -->\n\n**Important warning**');
    expect(sections[0].sourceHeadings).toEqual([]);
    expect(sections[0].label).toBe("Chapter 1: Origin");
  });

  it("coalesces the exact Chapter 1 source sequence into one navigation section", () => {
    const sections = chapterSections(`<!-- chapter: 1 -->

{{_kindle_position: 14776}}**CHAPTER 1**

<!-- chapter_title: "An Introduction to the Study of Reincarnation" -->

{{_kindle_position: 14785}}**An Introduction to the Study of Reincarnation**

{{_kindle_position: 14830}}It may disappoint some readers to learn that this book is not about reincarnation directly.`);

    expect(sections).toEqual([{
      markerLine: 0,
      headingLine: 2,
      number: "1",
      title: "An Introduction to the Study of Reincarnation",
      sourceHeadings: [
        { line: 2, text: "CHAPTER 1" },
        { line: 6, text: "An Introduction to the Study of Reincarnation" },
      ],
      label: "Chapter 1: An Introduction to the Study of Reincarnation",
    }]);
  });

  it("does not coalesce across unrelated prose", () => {
    const sections = chapterSections(`<!-- chapter: 1 -->

{{_kindle_position: 14776}}**CHAPTER 1**

This paragraph is not part of the heading sequence.

<!-- chapter_title: "An Introduction to the Study of Reincarnation" -->

{{_kindle_position: 14785}}**An Introduction to the Study of Reincarnation**`);

    expect(sections).toHaveLength(2);
    expect(sections.map((section) => section.label)).toEqual([
      "Chapter 1",
      "An Introduction to the Study of Reincarnation",
    ]);
  });
});
