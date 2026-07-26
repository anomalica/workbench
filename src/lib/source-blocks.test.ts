import { describe, expect, it } from "vitest";
import { parseSourceBlocks } from "./source-blocks";

const TRANSCRIPT = `
<!-- speaker: Chris Ramsay -->
Ladies and gentlemen, today I am joined by a very special guest.

<!-- speaker: Jon Stewart -->
Thank you for having me.
`;

describe("parseSourceBlocks", () => {
  it("turns a speaker annotation into structure, not text", () => {
    // Rendered as plain text these littered the transcript
    // ("<!-- speaker: Chris Ramsay -->" every few sentences); rendered as
    // markdown they vanished entirely, which loses who is talking.
    const { blocks, prose } = parseSourceBlocks(TRANSCRIPT);
    expect(blocks.map((b) => b.kind)).toEqual(["speaker", "prose", "speaker", "prose"]);
    expect(blocks[0]).toEqual({ kind: "speaker", label: "Chris Ramsay" });
    expect(prose).not.toContain("<!--");
    expect(prose).not.toContain("speaker");
  });

  it("keeps prose continuous so coverage offsets line up across blocks", () => {
    const { blocks, prose } = parseSourceBlocks(TRANSCRIPT);
    for (const b of blocks) {
      if (b.kind !== "prose") continue;
      expect(prose.slice(b.start, b.end)).toBe(b.text);
    }
  });

  it("labels pages and chapters as their own dividers", () => {
    const { blocks } = parseSourceBlocks(
      "<!-- printed_page: xiv -->text<!-- chapter_title: The Valley -->more",
    );
    expect(blocks[0]).toEqual({ kind: "page", label: "Page xiv" });
    expect(blocks[2]).toEqual({ kind: "chapter", label: "The Valley" });
  });

  it("SHOWS an unrecognised annotation rather than hiding it", () => {
    // A marker the reader cannot see is one they cannot question.
    const { blocks } = parseSourceBlocks("<!-- redacted: two lines -->after");
    expect(blocks[0]).toEqual({ kind: "note", label: "redacted: two lines" });
  });

  it("handles a body with no annotations at all", () => {
    const { blocks, prose } = parseSourceBlocks("Just prose, nothing else.");
    expect(blocks).toEqual([
      { kind: "prose", text: "Just prose, nothing else.", start: 0, end: 25 },
    ]);
    expect(prose).toBe("Just prose, nothing else.");
  });

  it("drops whitespace-only gaps between annotations", () => {
    const { blocks } = parseSourceBlocks("<!-- speaker: A -->\n\n  \n<!-- speaker: B -->x");
    expect(blocks.map((b) => b.kind)).toEqual(["speaker", "speaker", "prose"]);
  });

  it("keeps a colon inside a speaker's name", () => {
    const { blocks } = parseSourceBlocks("<!-- speaker: Dr. X: the second -->y");
    expect(blocks[0]).toEqual({ kind: "speaker", label: "Dr. X: the second" });
  });
});
