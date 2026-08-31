/**
 * Markup-mode pointer semantics.
 *
 * 1. CHAIN HOVER: hovering a highlight that has context (needs / needed by)
 *    lights up BOTH ends of the link, so the connection is visible without
 *    clicking. Hovering plain text clears it.
 *
 * 2. CLICK PLAYS, DRAG PAUSES: a bare click on a word plays it (on pointerup),
 *    but a press that becomes a drag is the reviewer lining up a highlight -
 *    the pending play is cancelled and playback pauses out of the way. Edit
 *    mode keeps its immediate seek-on-press, unchanged.
 *
 * 3. THE CONTEXT-PICK CLICK IS CONSUMED: clicking the earlier highlight to
 *    complete a "Link to previous highlight" edge creates the edge and must NOT also start
 *    playback from there.
 *
 * All three hinge on pointer coordinates carried by the events themselves, so
 * they are testable here without layout: a drag is coords that moved, a click
 * is coords that didn't (see drag-intent.ts).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/svelte";
import WordTranscript from "./WordTranscript.svelte";

// Words: 0=alpha 1=beta (highlight 10), 2=gap, 3=gamma 4=delta (highlight 11),
// 5=tail. Edge: 11 needs 10. Marker order matches what serializeWords emits -
// highlight-start BEFORE the {{t:}} marker; reversed, the parser reads the
// highlight as starting one word later.
const BODY =
  "<!-- speaker: Speaker 1 -->\n" +
  "00:00:01.0 {{highlight-start: 10}}{{t:1.00}}alpha {{t:1.50}}beta{{highlight-end: 10}} " +
  "{{t:2.00}}gap {{highlight-start: 11}}{{t:2.50}}gamma {{t:3.00}}delta{{highlight-end: 11}} " +
  "{{t:3.50}}tail.\n{{highlight-context: [11, 10]}}\n";

const word = (g: number) => document.querySelector<HTMLElement>(`[data-word-index="${g}"]`)!;
const chained = () =>
  [...document.querySelectorAll<HTMLElement>(".wt-chain")]
    .map((e) => Number(e.dataset.wordIndex))
    .sort((a, b) => a - b);

const settle = () => new Promise((r) => setTimeout(r, 40));

function props(over: Record<string, unknown> = {}) {
  return {
    body: BODY,
    mode: "markup" as const,
    storageKey: "workbench:observed:markup-pointer-test",
    serverObserved: [],
    currentTime: 0,
    // Every test here but the hold one is asserting CLICK behaviour, and the
    // suite's own scheduling can put 400ms between a press and its release -
    // which used to turn those clicks into holds and made the file fail at
    // random. The gesture is stated, not timed.
    holdMs: 1_000_000,
    onreassign: () => {},
    ...over,
  };
}

/** A press-and-release in place: pointer coords identical, so it reads as a
 *  click, never a drag. */
async function click(g: number, at = { clientX: 100, clientY: 100 }) {
  await fireEvent.pointerDown(word(g), { button: 0, ...at });
  await fireEvent.pointerUp(window, { button: 0, ...at });
  await settle();
}

/** A real drag: press on `a`, cross into `b` with moved coordinates, release. */
async function drag(a: number, b: number) {
  await fireEvent.pointerDown(word(a), { button: 0, clientX: 100, clientY: 100 });
  await fireEvent.pointerOver(word(b), { button: 0, clientX: 180, clientY: 100 });
  await fireEvent.pointerUp(window, { button: 0, clientX: 180, clientY: 100 });
  await settle();
}

describe("chain hover lights both ends of the link", () => {
  beforeEach(() => {
    localStorage.clear();
    Element.prototype.scrollTo = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("hovering the dependent highlight lights it AND what it needs", async () => {
    render(WordTranscript, { props: props() });
    await settle();
    await fireEvent.pointerOver(word(3), { clientX: 50, clientY: 50 });
    await settle();
    expect(chained()).toEqual([0, 1, 3, 4]);
  });

  it("hovering the needed highlight lights it AND its dependent - both directions", async () => {
    render(WordTranscript, { props: props() });
    await settle();
    await fireEvent.pointerOver(word(0), { clientX: 50, clientY: 50 });
    await settle();
    expect(chained()).toEqual([0, 1, 3, 4]);
  });

  it("moving onto plain text clears the emphasis", async () => {
    render(WordTranscript, { props: props() });
    await settle();
    await fireEvent.pointerOver(word(3), { clientX: 50, clientY: 50 });
    await settle();
    await fireEvent.pointerOver(word(2), { clientX: 60, clientY: 50 });
    await settle();
    expect(chained()).toEqual([]);
  });

  it("an unchained highlight gets no chain emphasis", async () => {
    const solo =
      "<!-- speaker: Speaker 1 -->\n" +
      "00:00:01.0 {{highlight-start: 10}}{{t:1.00}}alpha {{t:1.50}}beta{{highlight-end: 10}} {{t:2.00}}tail.\n";
    render(WordTranscript, { props: props({ body: solo }) });
    await settle();
    await fireEvent.pointerOver(word(0), { clientX: 50, clientY: 50 });
    await settle();
    expect(chained()).toEqual([]);
  });

  it("shows the chain in the editing view too - there is one view now", async () => {
    // Chain hover used to be markup-only, and highlights rendered as a faint
    // undifferentiated band while editing. With a single view there is one
    // rendering: the link is visible wherever the words are.
    render(WordTranscript, { props: props({ mode: "edit" }) });
    await settle();
    await fireEvent.pointerOver(word(3), { clientX: 50, clientY: 50 });
    await settle();
    expect(chained().length).toBeGreaterThan(0);
  });
});

describe("markup: click plays, drag pauses", () => {
  beforeEach(() => {
    localStorage.clear();
    Element.prototype.scrollTo = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("a bare click seeks on pointerup, not on press", async () => {
    const onseek = vi.fn();
    render(WordTranscript, { props: props({ onseek }) });
    await settle();
    await fireEvent.pointerDown(word(2), { button: 0, clientX: 100, clientY: 100 });
    expect(onseek).not.toHaveBeenCalled(); // still a candidate drag
    await fireEvent.pointerUp(window, { button: 0, clientX: 100, clientY: 100 });
    await settle();
    expect(onseek).toHaveBeenCalledTimes(1);
    expect(onseek).toHaveBeenCalledWith(2.0);
  });

  it("a drag cancels the play and pauses instead", async () => {
    const onseek = vi.fn();
    const onpause = vi.fn();
    render(WordTranscript, { props: props({ onseek, onpause }) });
    await settle();
    await drag(2, 4);
    expect(onpause).toHaveBeenCalledTimes(1);
    expect(onseek).not.toHaveBeenCalled();
  });

  it("defers the seek in the editing view too, so a drag can cancel it", async () => {
    // Editing used to seek on press. That started audio under a gesture which
    // often turned out to be a selection, so the press now only ARMS the play
    // and pointerup fires it - the behaviour markup already had.
    const onseek = vi.fn();
    render(WordTranscript, { props: props({ mode: "edit", onseek }) });
    await settle();
    await fireEvent.pointerDown(word(2), { button: 0, clientX: 100, clientY: 100 });
    expect(onseek).not.toHaveBeenCalled();
    await fireEvent.pointerUp(window, { clientX: 100, clientY: 100 });
    expect(onseek).toHaveBeenCalledWith(2.0);
  });

  it("a wiggle inside the pressed word is still a click", async () => {
    // Sub-word pointer movement (past the slop, same word) must not read as a
    // drag: words are wide, trackpads jitter.
    const onseek = vi.fn();
    const onpause = vi.fn();
    render(WordTranscript, { props: props({ onseek, onpause }) });
    await settle();
    await fireEvent.pointerDown(word(2), { button: 0, clientX: 100, clientY: 100 });
    await fireEvent.pointerOver(word(2), { button: 0, clientX: 110, clientY: 100 });
    await fireEvent.pointerUp(window, { button: 0, clientX: 110, clientY: 100 });
    await settle();
    // The press pauses (click-and-hold is a way to stop playback), the release
    // seeks - so a wiggled click still ENDS up playing that word, which is what
    // "still a click" means here.
    expect(onpause).toHaveBeenCalledTimes(1);
    expect(onseek).toHaveBeenCalledTimes(1);
  });
});

describe("the context-pick click is consumed, not played", () => {
  beforeEach(() => {
    localStorage.clear();
    Element.prototype.scrollTo = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("completing a link neither seeks nor pauses", async () => {
    const onseek = vi.fn();
    const onpause = vi.fn();
    const onhighlightcontext = vi.fn();
    render(WordTranscript, { props: props({ onseek, onpause, onhighlightcontext }) });
    await settle();

    // Select a word of the LATER highlight (this click legitimately plays)...
    await click(3);
    expect(onseek).toHaveBeenCalledTimes(1);
    // ...enter picking mode...
    // Markup now lives behind a menu, so it has to be opened first - the same
    // click the reviewer makes.
    await fireEvent.click(screen.getByLabelText("Markup"));
    await settle();
    await fireEvent.click(screen.getByText("Link to previous highlight"));
    await settle();
    onseek.mockClear();
    // The first click's press legitimately paused; this test is about the second.
    onpause.mockClear();

    // ...and click the EARLIER highlight to complete the link.
    await click(0);
    expect(onhighlightcontext).toHaveBeenCalledWith("11", "10");
    expect(onseek).not.toHaveBeenCalled();
    expect(onpause).not.toHaveBeenCalled();
  });

  it("the cancel click (empty text) does not play either", async () => {
    const onseek = vi.fn();
    render(WordTranscript, { props: props({ onseek }) });
    await settle();
    await click(3);
    // Markup now lives behind a menu, so it has to be opened first - the same
    // click the reviewer makes.
    await fireEvent.click(screen.getByLabelText("Markup"));
    await settle();
    await fireEvent.click(screen.getByText("Link to previous highlight"));
    await settle();
    onseek.mockClear();

    await click(5); // plain text: cancels picking
    expect(onseek).not.toHaveBeenCalled();
  });
});

describe("holding a word, without dragging", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("pauses and stays paused when the press is held", async () => {
    // holdMs 0: every release is a hold, which is the gesture under test.
    // A drag pauses because the reviewer is selecting. A hold means the same
    // thing without the movement - they want the audio to stop - so releasing
    // must not play from that word and undo it.
    const onseek = vi.fn();
    const onpause = vi.fn();
    render(WordTranscript, { props: props({ onseek, onpause, holdMs: 0 }) });
    await settle();
    await fireEvent.pointerDown(word(2), { button: 0, clientX: 100, clientY: 100 });
    await fireEvent.pointerUp(window, { button: 0, clientX: 100, clientY: 100 });
    await settle();
    expect(onpause).toHaveBeenCalledTimes(1);
    expect(onseek).not.toHaveBeenCalled();
  });

  it("still plays from the word on a quick click", async () => {
    const onseek = vi.fn();
    const onpause = vi.fn();
    render(WordTranscript, { props: props({ onseek, onpause }) });
    await settle();
    await fireEvent.pointerDown(word(2), { button: 0, clientX: 100, clientY: 100 });
    await fireEvent.pointerUp(window, { button: 0, clientX: 100, clientY: 100 });
    await settle();
    expect(onseek).toHaveBeenCalledTimes(1);
  });
});

describe("entering a picking mode pauses the video", () => {
  // Mark: "it's frustrating that it keeps playing the video". Both modes ask the
  // reviewer to go and find something on screen, which takes long enough that
  // audio running underneath is a fight rather than a nuisance.
  beforeEach(() => {
    Element.prototype.scrollTo = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
  });

  for (const label of ["Extend highlight", "Link to previous highlight"]) {
    it(`"${label}" pauses on entry`, async () => {
      const onpause = vi.fn();
      render(WordTranscript, { props: props({ onpause }) });
      await settle();
      await click(3);
      await fireEvent.click(screen.getByLabelText("Markup"));
      await settle();
      onpause.mockClear();
      await fireEvent.click(screen.getByText(label));
      await settle();
      expect(onpause).toHaveBeenCalled();
    });
  }
});
