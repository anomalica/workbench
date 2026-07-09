import { describe, it, expect } from "vitest";
import { retimeWithPush, MIN_WORD_GAP } from "./word-timing";

const G = MIN_WORD_GAP;

/** Every start is strictly later than the one before it. */
function ascending(starts: number[]): boolean {
  return starts.every((s, i) => i === 0 || s > starts[i - 1]);
}

describe("retimeWithPush", () => {
  const bounds = { prevStart: 1.0, nextStart: 5.0 };

  it("moves the word alone when it lands clear of its neighbours", () => {
    const out = retimeWithPush([2, 3, 4], 1, 3.4, bounds);
    expect(out).toEqual([2, 3.4, 4]);
  });

  it("pushes the neighbour ahead once the word reaches it", () => {
    const out = retimeWithPush([2, 3, 4], 1, 4.2, bounds);
    expect(out[1]).toBeCloseTo(4.2, 6);
    expect(out[2]).toBeCloseTo(4.2 + G, 6);
    expect(ascending(out)).toBe(true);
  });

  it("cascades the push forwards through every word it runs into", () => {
    const out = retimeWithPush([2, 3, 4], 0, 4.9, bounds);
    expect(out[0]).toBeCloseTo(4.9, 6);
    expect(out[1]).toBeCloseTo(4.9 + G, 6);
    expect(out[2]).toBeCloseTo(4.9 + 2 * G, 6);
  });

  it("cascades the push backwards through every word it runs into", () => {
    const out = retimeWithPush([2.98, 2.99, 3.0], 2, 2.5, bounds);
    expect(out[2]).toBeCloseTo(2.5, 6);
    expect(out[1]).toBeCloseTo(2.5 - G, 6);
    expect(out[0]).toBeCloseTo(2.5 - 2 * G, 6);
  });

  it("stops the cascade at the first word that is already out of the way", () => {
    // Word 0 sits at 2, well before word 1's pushed-back 2.49 - it must not move.
    const out = retimeWithPush([2, 3, 4], 2, 2.5, bounds);
    expect(out[2]).toBeCloseTo(2.5, 6);
    expect(out[1]).toBeCloseTo(2.5 - G, 6);
    expect(out[0]).toBe(2);
  });

  it("never pushes the last word onto or past the word after the range", () => {
    const out = retimeWithPush([2, 3, 4], 2, 99, bounds);
    expect(out[2]).toBeCloseTo(5.0 - G, 6);
    expect(out[2]).toBeLessThan(5.0);
  });

  it("stacks the whole range against the upper bound when shoved past it", () => {
    const out = retimeWithPush([2, 3, 4], 0, 99, bounds);
    expect(out[2]).toBeCloseTo(5.0 - G, 6);
    expect(out[1]).toBeCloseTo(5.0 - 2 * G, 6);
    expect(out[0]).toBeCloseTo(5.0 - 3 * G, 6);
    expect(ascending(out)).toBe(true);
  });

  it("never pushes the first word onto or past the word before the range", () => {
    const out = retimeWithPush([2, 3, 4], 0, -99, bounds);
    expect(out[0]).toBeCloseTo(1.0 + G, 6);
    expect(out[0]).toBeGreaterThan(1.0);
  });

  it("stacks the whole range against the lower bound when shoved below it", () => {
    const out = retimeWithPush([2, 3, 4], 2, -99, bounds);
    expect(out[0]).toBeCloseTo(1.0 + G, 6);
    expect(out[1]).toBeCloseTo(1.0 + 2 * G, 6);
    expect(out[2]).toBeCloseTo(1.0 + 3 * G, 6);
  });

  it("floors at zero when nothing precedes the range", () => {
    const out = retimeWithPush([0.5, 1], 0, -4, { prevStart: null, nextStart: 5 });
    expect(out[0]).toBe(0);
    expect(out[1]).toBeCloseTo(1, 6);
  });

  it("ceilings at the media duration when nothing follows the range", () => {
    const out = retimeWithPush([8, 9], 1, 99, { prevStart: 7, mediaDuration: 10 });
    expect(out[1]).toBeCloseTo(10, 6);
    expect(out[0]).toBe(8); // clear of the pushed word - no reason to move it
  });

  it("stacks against the media duration when the first word is shoved past it", () => {
    const out = retimeWithPush([8, 9], 0, 99, { prevStart: 7, mediaDuration: 10 });
    expect(out[0]).toBeCloseTo(10 - G, 6);
    expect(out[1]).toBeCloseTo(10, 6);
  });

  it("leaves words clear of the moved one exactly where they were", () => {
    const out = retimeWithPush([2, 3, 4], 1, 3.4, bounds);
    expect(out[0]).toBe(2);
    expect(out[2]).toBe(4);
  });

  it("leaves the range unbounded above with no next word and no duration", () => {
    const out = retimeWithPush([8, 9], 1, 500, { prevStart: 7 });
    expect(out[1]).toBe(500);
    expect(out[0]).toBe(8);
  });

  it("compresses evenly when the window is too narrow for the range", () => {
    // Four words into a 0.02s window: MIN_WORD_GAP would need 0.03s.
    const out = retimeWithPush([1, 2, 3, 4], 0, 3, { prevStart: 1, nextStart: 1.04 });
    expect(ascending(out)).toBe(true);
    expect(out[0]).toBeGreaterThan(1);
    expect(out[3]).toBeLessThan(1.04);
  });

  it("keeps the result ascending wherever the word is dropped", () => {
    for (const t of [-5, 0, 1.005, 2.5, 3.999, 4.995, 5, 20]) {
      for (let i = 0; i < 3; i++) {
        expect(ascending(retimeWithPush([2, 3, 4], i, t, bounds))).toBe(true);
      }
    }
  });

  it("returns a copy and leaves the input untouched", () => {
    const starts = [2, 3, 4];
    const out = retimeWithPush(starts, 1, 4.5, bounds);
    expect(starts).toEqual([2, 3, 4]);
    expect(out).not.toBe(starts);
  });

  it("ignores an out-of-range index", () => {
    expect(retimeWithPush([2, 3], 5, 1, bounds)).toEqual([2, 3]);
    expect(retimeWithPush([], 0, 1, bounds)).toEqual([]);
  });

  it("moves a lone word freely between its bounds", () => {
    expect(retimeWithPush([3], 0, 4.9, bounds)[0]).toBeCloseTo(4.9, 6);
    expect(retimeWithPush([3], 0, 99, bounds)[0]).toBeCloseTo(5 - G, 6);
    expect(retimeWithPush([3], 0, -99, bounds)[0]).toBeCloseTo(1 + G, 6);
  });
});
