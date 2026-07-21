/**
 * Mark up and "show only observed" are INDEPENDENT of each other.
 *
 * They used to be the same thing: markup was a separate tab that also filtered
 * the transcript to observed words. Switching into it remounted the view AND
 * changed what was on screen. This pins the decoupling that fixed both:
 *
 *  - the observed-only filter hides unobserved words in EITHER mode;
 *  - the mode (edit vs markup) never changes which words are visible;
 *  - so flipping the mode with the filter on leaves the visible set identical.
 *
 * These render the real component and count word elements, so a regression that
 * re-welds the filter to the mode fails here rather than only in the browser.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "@testing-library/svelte";
import WordTranscript from "./WordTranscript.svelte";

// 5 words (gIndex 0..4). No speaker-run boundary complications.
const BODY =
  "<!-- speaker: Speaker 1 -->\n" +
  "00:00:01.0 {{t:1.00}}One {{t:1.50}}two {{t:2.00}}three {{t:2.50}}four {{t:3.00}}five.\n";

const visibleWordIndices = () =>
  [...document.querySelectorAll<HTMLElement>("[data-word-index]")]
    .map((e) => Number(e.dataset.wordIndex))
    .sort((a, b) => a - b);

function props(over: Record<string, unknown> = {}) {
  return {
    body: BODY,
    storageKey: "workbench:observed:mode-filter-test",
    // Words 0,1,2 observed; 3,4 not. A partial, RELIABLE set - unlike the live
    // record I first tested against, which was 100% observed so the filter
    // could not visibly bite.
    serverObserved: [0, 1, 2],
    currentTime: 0,
    onreassign: () => {},
    ...over,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 40));

describe("mode and the observed-only filter are independent", () => {
  beforeEach(() => {
    localStorage.clear();
    Element.prototype.scrollTo = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("filter OFF: every word shows, in edit mode", async () => {
    render(WordTranscript, { props: props({ mode: "edit", showObservedOnly: false }) });
    await settle();
    expect(visibleWordIndices()).toEqual([0, 1, 2, 3, 4]);
  });

  it("filter OFF: every word shows, in markup mode too - mode alone hides nothing", async () => {
    render(WordTranscript, { props: props({ mode: "markup", showObservedOnly: false }) });
    await settle();
    expect(visibleWordIndices()).toEqual([0, 1, 2, 3, 4]);
  });

  it("filter ON: only observed words show, in edit mode", async () => {
    render(WordTranscript, { props: props({ mode: "edit", showObservedOnly: true }) });
    await settle();
    expect(visibleWordIndices()).toEqual([0, 1, 2]);
  });

  it("filter ON: only observed words show, in markup mode", async () => {
    render(WordTranscript, { props: props({ mode: "markup", showObservedOnly: true }) });
    await settle();
    expect(visibleWordIndices()).toEqual([0, 1, 2]);
  });

  it("flipping the mode with the filter ON does not change the visible set", async () => {
    const { rerender } = render(WordTranscript, {
      props: props({ mode: "edit", showObservedOnly: true }),
    });
    await settle();
    const inEdit = visibleWordIndices();
    await rerender(props({ mode: "markup", showObservedOnly: true }));
    await settle();
    expect(visibleWordIndices()).toEqual(inEdit);
  });

  it("flipping the mode with the filter OFF does not change the visible set", async () => {
    const { rerender } = render(WordTranscript, {
      props: props({ mode: "edit", showObservedOnly: false }),
    });
    await settle();
    const inEdit = visibleWordIndices();
    await rerender(props({ mode: "markup", showObservedOnly: false }));
    await settle();
    expect(visibleWordIndices()).toEqual(inEdit);
    expect(inEdit).toEqual([0, 1, 2, 3, 4]);
  });
});
