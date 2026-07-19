import { describe, it, expect, beforeEach } from "vitest";
import {
  saveScrollAnchor,
  loadScrollAnchor,
  resolveAnchorTarget,
  scrollAnchorKey,
  shouldPersistScroll,
} from "./scroll-anchor";

const HASH = "5a05136da7b7";
beforeEach(() => localStorage.clear());

describe("save / load", () => {
  it("remembers the word you were at", () => {
    expect(saveScrollAnchor(HASH, 1200)).toBe(true);
    expect(loadScrollAnchor(HASH)).toBe(1200);
  });

  it("is per record", () => {
    saveScrollAnchor(HASH, 10);
    saveScrollAnchor("other", 900);
    expect(loadScrollAnchor(HASH)).toBe(10);
    expect(loadScrollAnchor("other")).toBe(900);
  });

  it("word 0 is a real position and IS kept (unlike a playhead at 0)", () => {
    expect(saveScrollAnchor(HASH, 0)).toBe(true);
    expect(loadScrollAnchor(HASH)).toBe(0);
  });

  it("refuses a negative or non-integer index", () => {
    expect(saveScrollAnchor(HASH, -1)).toBe(false);
    expect(saveScrollAnchor(HASH, 3.5)).toBe(false);
  });

  it("reads a corrupted value as absent", () => {
    localStorage.setItem(scrollAnchorKey(HASH), "not-a-number");
    expect(loadScrollAnchor(HASH)).toBeNull();
    localStorage.setItem(scrollAnchorKey(HASH), "-5");
    expect(loadScrollAnchor(HASH)).toBeNull();
  });

  it("returns null for a record never scrolled", () => {
    expect(loadScrollAnchor("unseen")).toBeNull();
  });
});

describe("resolveAnchorTarget: the saved word may not be rendered here", () => {
  it("uses the exact word when this tab renders it", () => {
    expect(resolveAnchorTarget(50, [10, 50, 90])).toBe(50);
  });

  it("falls to the nearest word AFTER when Markup filtered the saved one out", () => {
    // Markup shows only observed+relevant words, so the saved index can be gone.
    // Landing just after it keeps the reviewer in the same passage.
    expect(resolveAnchorTarget(50, [10, 60, 90])).toBe(60);
  });

  it("falls back BEFORE only when nothing after exists", () => {
    expect(resolveAnchorTarget(95, [10, 60, 90])).toBe(90);
  });

  it("returns null when nothing is rendered - a flat empty transcript", () => {
    expect(resolveAnchorTarget(50, [])).toBeNull();
  });
});

describe("shouldPersistScroll", () => {
  it("throttles the scroll-event flood", () => {
    expect(shouldPersistScroll(100, 101)).toBe(false);
    expect(shouldPersistScroll(100, 110)).toBe(true);
  });
  it("fires on a jump back up too", () => {
    expect(shouldPersistScroll(100, 10)).toBe(true);
  });
});
