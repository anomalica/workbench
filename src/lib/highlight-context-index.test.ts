import { describe, it, expect } from "vitest";
import { buildContextIndex } from "./highlight-context";
import { parseWords } from "./transcript-words";

describe("the multi-edge case is REACHABLE, not hypothetical", () => {
  // The justification for accumulating instead of `.find()`. If the parser could
  // not produce two edges for one highlight, the simpler read would be correct
  // and this module would be over-engineering. It can, so it isn't.
  const BODY = `<!-- speaker: A -->
{{t:0.0}}{{highlight-start: 10}}alpha{{t:0.5}} one{{highlight-end: 10}} {{t:1.0}}x
<!-- speaker: B -->
{{t:2.0}}{{highlight-start: 11}}beta{{t:2.5}} two{{highlight-end: 11}} {{t:3.0}}y
<!-- speaker: C -->
{{t:4.0}}{{highlight-start: 12}}gamma{{t:4.5}} three{{highlight-end: 12}} {{t:5.0}}z
{{highlight-context: [12, 10]}}
{{highlight-context: [12, 11]}}
`;

  it("two markers for one highlight parse as two separate edges", () => {
    expect(parseWords(BODY).highlightContexts).toEqual([
      { of: "12", needs: ["10"] },
      { of: "12", needs: ["11"] },
    ]);
  });

  it("a first-match read hides the second dependency entirely", () => {
    const found = parseWords(BODY).highlightContexts.find((c) => c.of === "12");
    expect(found?.needs).toEqual(["10"]);
    expect(found?.needs).not.toContain("11");
  });

  it("the index surfaces both, in both directions", () => {
    const ix = buildContextIndex(parseWords(BODY).highlightContexts);
    expect(ix.needs("12")).toEqual(["10", "11"]);
    expect(ix.dependents("10")).toEqual(["12"]);
    expect(ix.dependents("11")).toEqual(["12"]);
  });
});

describe("context index: both directions", () => {
  it("reads what a highlight needs", () => {
    const ix = buildContextIndex([{ of: "b", needs: ["a"] }]);
    expect(ix.needs("b")).toEqual(["a"]);
  });

  it("reads the reverse - what would be stranded", () => {
    const ix = buildContextIndex([{ of: "b", needs: ["a"] }]);
    expect(ix.dependents("a")).toEqual(["b"]);
  });

  it("an unchained highlight reports empty, not undefined", () => {
    const ix = buildContextIndex([{ of: "b", needs: ["a"] }]);
    expect(ix.needs("z")).toEqual([]);
    expect(ix.dependents("z")).toEqual([]);
    expect(ix.isChained("z")).toBe(false);
    expect(ix.isChained("a")).toBe(true);
    expect(ix.isChained("b")).toBe(true);
  });
});

describe("context index: several edges for one highlight", () => {
  // The workbench merges on author, so it never writes this. The record format
  // is an interchange contract and the parser emits one entry per marker, so a
  // hand-edited, digester-written, or merged record can legally carry two. A
  // `.find()`-style read shows the first and hides the rest - a chain that looks
  // complete and is not, which is worse than showing none.
  it("accumulates needs across every edge, not just the first", () => {
    const ix = buildContextIndex([
      { of: "c", needs: ["a"] },
      { of: "c", needs: ["b"] },
    ]);
    expect(ix.needs("c")).toEqual(["a", "b"]);
  });

  it("accumulates dependents across every edge", () => {
    const ix = buildContextIndex([
      { of: "b", needs: ["a"] },
      { of: "c", needs: ["a"] },
    ]);
    expect(ix.dependents("a")).toEqual(["b", "c"]);
  });

  it("dedupes a dependency named twice, keeping first-mentioned order", () => {
    const ix = buildContextIndex([
      { of: "c", needs: ["a", "b"] },
      { of: "c", needs: ["a"] },
    ]);
    expect(ix.needs("c")).toEqual(["a", "b"]);
  });
});

describe("context index: degenerate input is survived, not crashed on", () => {
  it("no edges", () => {
    const ix = buildContextIndex([]);
    expect(ix.needs("a")).toEqual([]);
    expect(ix.isChained("a")).toBe(false);
  });

  it("drops a self-reference rather than rendering 'needs itself'", () => {
    const ix = buildContextIndex([{ of: "a", needs: ["a"] }]);
    expect(ix.needs("a")).toEqual([]);
    expect(ix.dependents("a")).toEqual([]);
  });

  it("keeps the real dependency when an edge names itself alongside one", () => {
    const ix = buildContextIndex([{ of: "a", needs: ["a", "b"] }]);
    expect(ix.needs("a")).toEqual(["b"]);
  });

  it("holds a chain of three - each link readable from either end", () => {
    const ix = buildContextIndex([
      { of: "c", needs: ["b"] },
      { of: "b", needs: ["a"] },
    ]);
    expect(ix.needs("c")).toEqual(["b"]);
    expect(ix.needs("b")).toEqual(["a"]);
    expect(ix.dependents("a")).toEqual(["b"]);
    expect(ix.dependents("b")).toEqual(["c"]);
    // Not transitive by design: "c needs b" does not make "c needs a". The
    // reviewer stated one hop; inventing the rest would put words in their mouth.
    expect(ix.needs("c")).not.toContain("a");
  });

  it("a dangling id is indexed like any other - resolution is the caller's job", () => {
    // The index does not know which ids still have highlights. Keeping it that
    // way is what lets the caller render the dangling one as repairable rather
    // than dropping the link silently.
    const ix = buildContextIndex([{ of: "b", needs: ["gone"] }]);
    expect(ix.needs("b")).toEqual(["gone"]);
  });
});
