import { describe, it, expect } from "vitest";
import { pointerMoved, DRAG_SLOP_PX } from "./drag-intent";

const at = (x: number, y: number) => ({ x, y });

describe("drag intent: a stationary cursor is not a drag", () => {
  it("the exact press point has not moved", () => {
    expect(pointerMoved(at(100, 200), at(100, 200))).toBe(false);
  });

  it("sub-slop jitter is not a drag", () => {
    expect(pointerMoved(at(100, 200), at(102, 201))).toBe(false);
    expect(pointerMoved(at(100, 200), at(97, 200))).toBe(false);
  });

  it("exactly at the slop is still not a drag - the boundary is exclusive", () => {
    expect(pointerMoved(at(100, 200), at(100 + DRAG_SLOP_PX, 200))).toBe(false);
    expect(pointerMoved(at(100, 200), at(100, 200 - DRAG_SLOP_PX))).toBe(false);
  });
});

describe("drag intent: a real drag still registers", () => {
  it("moving horizontally past the slop", () => {
    expect(pointerMoved(at(100, 200), at(120, 200))).toBe(true);
  });

  it("moving vertically past the slop - dragging down a column of lines", () => {
    expect(pointerMoved(at(100, 200), at(100, 240))).toBe(true);
  });

  it("either axis alone is enough", () => {
    expect(pointerMoved(at(100, 200), at(100 + DRAG_SLOP_PX + 1, 200))).toBe(true);
    expect(pointerMoved(at(100, 200), at(100, 200 + DRAG_SLOP_PX + 1))).toBe(true);
  });

  it("direction is irrelevant - dragging backwards is a drag", () => {
    expect(pointerMoved(at(100, 200), at(40, 200))).toBe(true);
    expect(pointerMoved(at(100, 200), at(100, 90))).toBe(true);
  });
});

describe("drag intent: the seek-scroll case this exists for", () => {
  // Clicking word 31 seeks the audio; the transcript scrolls to the active word;
  // word 12 lands under the cursor and the browser fires pointerover for it. The
  // cursor never moved, so the range must stay a single word. Before this, the
  // measured result was a 12-31 selection from one click.
  it("content scrolling under a still cursor does not extend the selection", () => {
    const press = at(640, 300);
    const overFiredAtSameSpot = at(640, 300);
    expect(pointerMoved(press, overFiredAtSameSpot)).toBe(false);
  });

  it("but once the reviewer actually drags, extension resumes", () => {
    const press = at(640, 300);
    expect(pointerMoved(press, at(640, 355))).toBe(true);
  });
});

describe("drag intent: no press recorded", () => {
  it("does not suppress - absent a press there is nothing to protect against", () => {
    expect(pointerMoved(null, at(0, 0))).toBe(true);
  });
});
