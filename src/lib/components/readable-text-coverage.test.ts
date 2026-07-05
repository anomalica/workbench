/**
 * Regression test for undisplayed-block coverage.
 *
 * The reading area renders the body faithfully (nothing suppressed), but a
 * content block can still render to nothing - e.g. a markdown link-reference
 * definition. Such a block counts a reviewable unit yet has no gutter to click,
 * so block-by-block review could never cover it and the record would stall
 * below 100%. autoObservedSpans auto-observes those unmarkable blocks (their
 * spans also join the stored verdict so the digester gate, which still counts
 * the line, sees it observed).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/svelte";
import ReadableText from "./ReadableText.svelte";

type Verdict = {
  spans: { from: number; to: number }[];
  observed_coverage: number;
  digestible: boolean;
  total_units: number;
};

// Block 1 is a link-reference definition: a content line that renders to empty
// HTML, so it is never displayed. Blocks 0 and 2 are ordinary prose.
const BODY = "First paragraph.\n\n[ref]: https://example.com\n\nSecond paragraph.\n";
// Mirror the parent's render: a link-reference definition produces no output.
const renderBlock = (src: string) => (src.trimStart().startsWith("[") ? "" : src);

function props(onverdict: (v: Verdict) => void) {
  return {
    body: BODY,
    renderBlock,
    previousObserved: [],
    storageKey: "workbench:read:undisplayed-block-test",
    onverdict,
  };
}

describe("ReadableText coverage: an undisplayed content block never strands 100%", () => {
  beforeEach(() => {
    localStorage.clear();
    Element.prototype.scrollTo = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("auto-observes the empty-render block's span from the start", async () => {
    let verdict: Verdict | null = null;
    render(ReadableText, {
      props: props((v) => {
        verdict = v;
      }),
    });
    await waitFor(() => {
      expect((verdict as unknown as Verdict).total_units).toBe(3);
      // The link-definition line (2) is auto-covered though nothing was marked.
      expect((verdict as unknown as Verdict).observed_coverage).toBeCloseTo(1 / 3, 5);
      expect((verdict as unknown as Verdict).spans).toContainEqual({ from: 2, to: 2 });
    });
  });

  it("reaches digestible after marking only the two displayed prose blocks", async () => {
    let verdict: Verdict | null = null;
    render(ReadableText, {
      props: props((v) => {
        verdict = v;
      }),
    });
    const toggles = await waitFor(() => {
      const t = document.querySelectorAll('button[aria-label="Toggle read"]');
      expect(t.length).toBe(2); // only the two displayed prose blocks have a gutter
      return t;
    });
    for (const btn of toggles) await fireEvent.click(btn);
    await waitFor(() => {
      expect((verdict as unknown as Verdict).digestible).toBe(true);
      expect((verdict as unknown as Verdict).observed_coverage).toBe(1);
    });
  });
});
