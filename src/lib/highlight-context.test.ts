import { describe, it, expect } from "vitest";
import { parseWords, serializeWords } from "./transcript-words";

/** Round-trip a body through parse -> serialize, as a real edit does. */
function roundTrip(body: string): string {
  const p = parseWords(body);
  return serializeWords(
    p.words,
    p.runs,
    p.lineEndWords,
    p.preamble,
    p.highlights,
    p.spanNotes,
    p.highlightContexts,
  );
}

const BODY = `<!-- speaker: Alice -->
{{t:0.0}}Doctor {{t:0.5}}Green {{t:1.0}}explained {{t:1.5}}it
<!-- speaker: Bob -->
{{t:2.0}}He {{t:2.5}}said {{t:3.0}}no
`;

describe("highlight-context: parsing", () => {
  it("reads an edge: first id needs the rest", () => {
    const p = parseWords(`${BODY}{{highlight-context: [h7, h3]}}\n`);
    expect(p.highlightContexts).toEqual([{ of: "h7", needs: ["h3"] }]);
  });

  it("reads multiple dependencies", () => {
    const p = parseWords(`${BODY}{{highlight-context: [h7, h3, h5]}}\n`);
    expect(p.highlightContexts).toEqual([{ of: "h7", needs: ["h3", "h5"] }]);
  });

  it("is position-independent - an edge anywhere means the same thing", () => {
    const atTop = parseWords(`{{highlight-context: [h7, h3]}}\n${BODY}`);
    const atEnd = parseWords(`${BODY}{{highlight-context: [h7, h3]}}\n`);
    expect(atTop.highlightContexts).toEqual(atEnd.highlightContexts);
  });

  it("NEVER leaks the marker into the words - it is notation, not content", () => {
    const p = parseWords(`${BODY}{{highlight-context: [h7, h3]}}\n`);
    const text = p.words.map((w) => w.text).join(" ");
    expect(text).not.toMatch(/highlight-context|h7|h3|\{\{/);
    // and the word sequence is exactly the same as without the edge
    expect(p.words.map((w) => w.text)).toEqual(parseWords(BODY).words.map((w) => w.text));
  });

  it("drops a lone id - an edge with no dependency says nothing", () => {
    expect(parseWords(`${BODY}{{highlight-context: [h7]}}\n`).highlightContexts).toEqual([]);
  });

  it("has no edges when the body has none", () => {
    expect(parseWords(BODY).highlightContexts).toEqual([]);
  });
});

describe("highlight-context: round trip", () => {
  it("survives parse -> serialize unchanged", () => {
    const src = `${BODY}{{highlight-context: [h7, h3, h5]}}\n`;
    expect(parseWords(roundTrip(src)).highlightContexts).toEqual([
      { of: "h7", needs: ["h3", "h5"] },
    ]);
  });

  it("survives repeated round trips without duplicating or drifting", () => {
    let out = `${BODY}{{highlight-context: [h7, h3]}}\n`;
    for (let i = 0; i < 4; i++) out = roundTrip(out);
    expect(parseWords(out).highlightContexts).toEqual([{ of: "h7", needs: ["h3"] }]);
    expect((out.match(/highlight-context/g) ?? []).length).toBe(1);
  });

  it("keeps a DANGLING edge - the reviewer decides, we never silently drop it", () => {
    // h3 does not exist as a highlight. Spec: retained + rendered unresolved.
    const src = `${BODY}{{highlight-context: [h7, h3]}}\n`;
    const p = parseWords(roundTrip(src));
    expect(p.highlights).toEqual([]);
    expect(p.highlightContexts).toEqual([{ of: "h7", needs: ["h3"] }]);
  });

  it("coexists with real highlights and keeps both", () => {
    const src =
      `<!-- speaker: Alice -->\n` +
      `{{highlight-start: 10}}{{t:0.0}}Doctor {{t:0.5}}Green{{highlight-end: 10}} {{t:1.0}}spoke\n` +
      `{{highlight-context: [11, 10]}}\n`;
    const p = parseWords(roundTrip(src));
    expect(p.highlights.map((h) => h.id)).toEqual(["10"]);
    expect(p.highlightContexts).toEqual([{ of: "11", needs: ["10"] }]);
  });
});
