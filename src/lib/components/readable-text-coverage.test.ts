/**
 * Regression test for the suppressed-title coverage trap.
 *
 * A leading body heading that duplicates the frontmatter title is hidden from
 * the reading list (it is rendered separately as the document H1). But it still
 * carried a reviewable unit in `total`, with no gutter to click - so a reviewer
 * marking prose block-by-block could never cover it and the record capped at
 * (total - 1)/total, stuck below 100%. ("Mark all read" masked it because that
 * path covers hidden blocks invisibly.)
 *
 * The fix auto-observes content blocks that are counted but never displayed, so
 * a hidden title (and any annotation block that renders to nothing) can never
 * strand coverage. Those spans join the stored verdict too, so the digester
 * gate - which still counts those lines - sees them observed.
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

// Body: a leading heading that matches the title (block 0, suppressed) plus two
// prose paragraphs (blocks 1, 2). 3 content units; only 2 are displayed.
const BODY = "# The Report\n\nFirst paragraph.\n\nSecond paragraph.\n";

function props(onverdict: (v: Verdict) => void) {
  return {
    body: BODY,
    documentTitle: "The Report",
    renderBlock: (src: string) => src,
    previousObserved: [],
    storageKey: "workbench:read:suppressed-title-test",
    onverdict,
  };
}

describe("ReadableText coverage: a suppressed title never strands 100%", () => {
  beforeEach(() => {
    localStorage.clear();
    Element.prototype.scrollTo = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("auto-observes the hidden title span from the start", async () => {
    let verdict: Verdict | null = null;
    render(ReadableText, {
      props: props((v) => {
        verdict = v;
      }),
    });
    await waitFor(() => {
      // Title line (0) is auto-covered though nothing was marked by hand.
      expect((verdict as unknown as Verdict).total_units).toBe(3);
      expect((verdict as unknown as Verdict).observed_coverage).toBeCloseTo(1 / 3, 5);
      expect((verdict as unknown as Verdict).spans).toContainEqual({ from: 0, to: 0 });
    });
  });

  it("reaches digestible after marking only the displayed prose blocks", async () => {
    let verdict: Verdict | null = null;
    render(ReadableText, {
      props: props((v) => {
        verdict = v;
      }),
    });
    await waitFor(() => expect(verdict).not.toBeNull());
    // The reviewer can only click the two displayed prose gutters; the title
    // has none. With the auto-cover this still reaches 100%.
    const toggles = await waitFor(() => {
      const t = document.querySelectorAll('button[aria-label="Toggle read"]');
      expect(t.length).toBe(2);
      return t;
    });
    for (const btn of toggles) await fireEvent.click(btn);
    await waitFor(() => {
      expect((verdict as unknown as Verdict).digestible).toBe(true);
      expect((verdict as unknown as Verdict).observed_coverage).toBe(1);
    });
  });
});
