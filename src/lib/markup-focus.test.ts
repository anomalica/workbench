import { describe, it, expect } from "vitest";

/**
 * The side-list's focus emphasis must never become a stuck selection.
 *
 * Clicking a row in the Markup side-list scrolls the transcript to that mark and
 * emphasises it. That emphasis is a POINTER ("here it is"), not a selection that
 * holds something - so the reviewer is never given a thing to dismiss, and must
 * never have to hunt for the way to clear it.
 *
 * It shipped stuck: `focusedMarkId` was assigned and never assigned back. The
 * emphasis survived clicking elsewhere, switching pane, and changing record. The
 * reviewer's only apparent escape was the ✕ on the row - which DELETED the mark.
 * A destructive action wearing the dismiss glyph, reached by trying to undo
 * something that shouldn't have persisted.
 *
 * This is the second time this exact shape has bitten here: a value declared and
 * documented as cleared, with nothing connected to clear it (see `mediaDuration`,
 * "documented but not connected"). The unit suite can't press a mouse, so these
 * guard the WIRING - that each clear path exists and is reachable. The behaviour
 * itself is verified by real clicks in the browser.
 */

const wordTranscript = (await import("./components/WordTranscript.svelte?raw")).default as string;
const ingestViewer = (await import("./components/IngestViewer.svelte?raw")).default as string;

describe("markup focus: the emphasis is always escapable", () => {
  it("a press anywhere in the transcript asks the owner to clear", () => {
    const handler = wordTranscript.slice(
      wordTranscript.indexOf("function onContainerPointerDown"),
      wordTranscript.indexOf("function onContainerPointerOver"),
    );
    expect(handler).toContain("onclearfocus");

    // Before the word lookup returns early, or pressing the gaps between words
    // silently keeps the emphasis alive.
    const clearAt = handler.indexOf("onclearfocus");
    const bailAt = handler.indexOf("if (!el) return");
    expect(clearAt).toBeGreaterThan(-1);
    expect(bailAt).toBeGreaterThan(-1);
    expect(clearAt).toBeLessThan(bailAt);
  });

  it("the owner actually connects that request to its state", () => {
    expect(ingestViewer).toContain("onclearfocus={clearMarkFocus}");
    const clear = ingestViewer.slice(
      ingestViewer.indexOf("function clearMarkFocus"),
      ingestViewer.indexOf("function clearMarkFocus") + 200,
    );
    // BOTH halves: the range drives the transcript emphasis, the id drives the
    // row tint. Clearing one alone leaves the other visibly stuck.
    expect(clear).toContain("markupFocus = null");
    expect(clear).toContain("focusedMarkId = null");
  });

  it("re-clicking the focused row toggles it off", () => {
    const focus = ingestViewer.slice(
      ingestViewer.indexOf("function focusMark"),
      ingestViewer.indexOf("function clearMarkFocus"),
    );
    expect(focus).toMatch(/focusedMarkId === id/);
    expect(focus).toContain("clearMarkFocus()");
  });

  it("changing record or pane drops it", () => {
    // Scoped to one mark on one record in one view - otherwise the emphasis can
    // reappear pointing at a range the reviewer is no longer looking at.
    const effect = ingestViewer.slice(
      ingestViewer.indexOf("void ingest.content_hash;"),
      ingestViewer.indexOf("void ingest.content_hash;") + 160,
    );
    expect(effect).toContain("void view;");
    expect(effect).toContain("clearMarkFocus()");
  });
});

describe("markup focus: delete does not wear the dismiss glyph", () => {
  it("the row's destructive button is a bin, and says so", async () => {
    const markupList = (await import("./components/MarkupList.svelte?raw")).default as string;
    const button = markupList.slice(
      markupList.indexOf("remove(m);"),
      markupList.indexOf("</button>"),
    );

    // The ✕ path. It reads as "close/dismiss" - fatal on a row that is tinted as
    // though it were holding a selection.
    expect(button).not.toContain("M6 18L18 6");
    expect(button).toContain("M4 7h16");
    expect(button).toMatch(/aria-label="Delete this/);
  });
});
