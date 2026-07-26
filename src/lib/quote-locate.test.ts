import { describe, expect, it } from "vitest";
import {
  claimKey,
  coverageRuns,
  findQuote,
  indexRenderedText,
  normaliseForMatch,
  rangeFor,
} from "./quote-locate";

const SOURCE = normaliseForMatch(`
  Yeah. And, you know, it's really helpful. So, you know, today I will be asking
  you about a few things that I might want you to clear up.

  This film was filmed on April 22, 1991 at 3:15 in the afternoon on behalf of
  the Department of Naval Intelligence, coordinated by the Defense Intelligence
  Agency.
`);

describe("findQuote", () => {
  it("finds a quote that survived verbatim, across line wrapping", () => {
    // The model's quote is one line; the source wraps it over three.
    const m = findQuote(SOURCE, "This film was filmed on April 22, 1991 at 3:15 in the afternoon");
    expect(m?.kind).toBe("exact");
    expect(SOURCE.slice(m!.start, m!.end)).toBe(
      "This film was filmed on April 22, 1991 at 3:15 in the afternoon",
    );
  });

  it("falls back to the opening when the tail diverges", () => {
    // A long quote breaks on ONE altered word. Its first sentence still points
    // at the right place, which is what a reader needs to check the claim.
    const m = findQuote(
      SOURCE,
      "This film was filmed on April 22, 1991 at 3:15 in the afternoon on behalf of the DEPARTMENT OF NAVY INTEL",
    );
    expect(m?.kind).toBe("prefix");
    expect(SOURCE.slice(m!.start, m!.end)).toContain("This film was filmed");
  });

  it("returns null when the quote is not in the source at all", () => {
    // The signal, not a failure: a claim whose evidence is not in the text is
    // mangled or fabricated, and the caller must SAY so rather than scroll
    // somewhere arbitrary.
    expect(findQuote(SOURCE, "The Rendlesham Forest incident occurred in 1980.")).toBeNull();
  });

  it("refuses to anchor on a too-short fragment", () => {
    // "Yeah." appears everywhere; anchoring on it would point at noise.
    expect(findQuote(SOURCE, "Yeah.")).toBeNull();
  });

  it("ignores an empty or whitespace-only quote", () => {
    expect(findQuote(SOURCE, "")).toBeNull();
    expect(findQuote(SOURCE, "   \n ")).toBeNull();
  });

  it("is case-sensitive - the source's own distinctions are kept", () => {
    expect(findQuote(SOURCE, "this film was filmed on april 22, 1991 at 3:15")).toBeNull();
  });
});

describe("normaliseForMatch", () => {
  it("collapses every run of whitespace to one space", () => {
    expect(normaliseForMatch("a\n\n  b\tc  ")).toBe("a b c");
  });
});

describe("indexRenderedText / rangeFor", () => {
  function render(html: string): HTMLElement {
    const el = document.createElement("div");
    el.innerHTML = html;
    document.body.appendChild(el);
    return el;
  }

  it("indexes across element boundaries as one continuous text", () => {
    // The markdown render splits a paragraph into elements; the quote does not
    // know about them, so the index must not either.
    const el = render("<p>This film was <em>filmed</em> on April 22.</p>");
    const idx = indexRenderedText(el);
    expect(idx.text).toBe("This film was filmed on April 22.");
    expect(idx.pos.length).toBe(idx.text.length);
  });

  it("maps a match back to a DOM range covering the right text", () => {
    const el = render("<p>Alpha beta</p><p>This film was filmed on April 22.</p>");
    const idx = indexRenderedText(el);
    const m = findQuote(idx.text, "This film was filmed");
    const range = rangeFor(idx, m!.start, m!.end);
    expect(range?.toString()).toBe("This film was filmed");
  });

  it("spans a match that crosses an inline element", () => {
    const el = render("<p>This film was <em>filmed on April</em> 22, 1991.</p>");
    const idx = indexRenderedText(el);
    const m = findQuote(idx.text, "film was filmed on April 22");
    expect(m).not.toBeNull();
    expect(rangeFor(idx, m!.start, m!.end)?.toString()).toContain("filmed on April");
  });

  it("returns null for offsets outside the rendered text", () => {
    const el = render("<p>short</p>");
    const idx = indexRenderedText(el);
    expect(rangeFor(idx, 100, 120)).toBeNull();
  });
});

describe("coverageRuns", () => {
  const TEXT = normaliseForMatch(
    "This film was filmed on April 22, 1991 at 3:15 in the afternoon. " +
      "An entirely separate sentence that nobody quoted at all whatsoever.",
  );

  it("counts DISTINCT variants over each stretch", () => {
    const runs = coverageRuns(TEXT, [
      { variant: "haiku", quote: "This film was filmed on April 22" },
      { variant: "sonnet", quote: "This film was filmed on April 22" },
      // same variant twice must not count as two models agreeing
      { variant: "haiku", quote: "This film was filmed on April 22" },
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].count).toBe(2);
    expect(TEXT.slice(runs[0].start, runs[0].end)).toBe("This film was filmed on April 22");
  });

  it("leaves unclaimed source out of the runs - the gap IS the finding", () => {
    const runs = coverageRuns(TEXT, [
      { variant: "haiku", quote: "This film was filmed on April 22" },
    ]);
    const covered = runs.map((r) => TEXT.slice(r.start, r.end)).join("");
    expect(covered).not.toContain("nobody quoted");
  });

  it("splits into separate runs where coverage changes", () => {
    const runs = coverageRuns(TEXT, [
      { variant: "haiku", quote: "This film was filmed on April 22, 1991 at 3:15" },
      { variant: "sonnet", quote: "This film was filmed on April 22" },
    ]);
    // the shared opening scores 2, the haiku-only tail scores 1
    expect(runs.map((r) => r.count)).toEqual([2, 1]);
  });

  it("ignores claims whose quote is not in the source", () => {
    expect(
      coverageRuns(TEXT, [{ variant: "haiku", quote: "Nothing like this appears here" }]),
    ).toEqual([]);
  });

  it("handles an empty source and no claims", () => {
    expect(coverageRuns("", [{ variant: "a", quote: "x" }])).toEqual([]);
    expect(coverageRuns(TEXT, [])).toEqual([]);
  });
});

describe("coverageRuns: which claims each stretch belongs to", () => {
  const TEXT = normaliseForMatch(
    "This film was filmed on April 22, 1991 at 3:15 in the afternoon on behalf of the Department of Naval Intelligence.",
  );

  it("names the claims drawn from a stretch, so a click can show them", () => {
    const runs = coverageRuns(TEXT, [
      { variant: "haiku", id: "h1", quote: "This film was filmed on April 22" },
      { variant: "sonnet", id: "s9", quote: "This film was filmed on April 22" },
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].claims.sort()).toEqual(
      [claimKey("haiku", "h1"), claimKey("sonnet", "s9")].sort(),
    );
  });

  it("keeps each stretch's own claims when coverage changes mid-quote", () => {
    const runs = coverageRuns(TEXT, [
      { variant: "haiku", id: "h1", quote: "This film was filmed on April 22, 1991 at 3:15" },
      { variant: "sonnet", id: "s9", quote: "This film was filmed on April 22" },
    ]);
    // shared opening carries both; the haiku-only tail carries just haiku
    expect(runs[0].claims.sort()).toEqual(
      [claimKey("haiku", "h1"), claimKey("sonnet", "s9")].sort(),
    );
    expect(runs[1].claims).toEqual([claimKey("haiku", "h1")]);
  });

  it("does not attribute a stretch to a claim that failed to locate", () => {
    const runs = coverageRuns(TEXT, [
      { variant: "haiku", id: "h1", quote: "This film was filmed on April 22" },
      { variant: "opus", id: "o2", quote: "A sentence that is simply not present here" },
    ]);
    expect(runs.flatMap((r) => r.claims)).toEqual([claimKey("haiku", "h1")]);
  });
});
