import { describe, it, expect, beforeEach } from "vitest";
import { savePlayhead, loadPlayhead, clearPlayhead, playheadKey, shouldPersist } from "./playhead";

const HASH = "5a05136da7b7";

beforeEach(() => localStorage.clear());

describe("savePlayhead / loadPlayhead", () => {
  it("remembers where you were", () => {
    expect(savePlayhead(HASH, 1234.56)).toBe(true);
    expect(loadPlayhead(HASH)).toBe(1234.56);
  });

  it("is per record, so two records don't share a position", () => {
    savePlayhead(HASH, 100);
    savePlayhead("other", 900);
    expect(loadPlayhead(HASH)).toBe(100);
    expect(loadPlayhead("other")).toBe(900);
  });

  it("returns null for a record never played", () => {
    expect(loadPlayhead("never-opened")).toBeNull();
  });

  it("ignores a position at the very start - nothing worth restoring", () => {
    expect(savePlayhead(HASH, 0)).toBe(false);
    expect(savePlayhead(HASH, 0.4)).toBe(false);
    expect(loadPlayhead(HASH)).toBeNull();
  });

  it("does not resume someone at the END of a record", () => {
    // Restoring to the last second is worse than starting over: there is nothing
    // left to hear, and the control they want is play, not resume.
    savePlayhead(HASH, 465);
    expect(loadPlayhead(HASH, 470)).toBeNull();
    expect(loadPlayhead(HASH, 900)).toBe(465); // a longer record: still mid-way
  });

  it("ignores a position beyond the media - a stale value from a different cut", () => {
    savePlayhead(HASH, 5000);
    expect(loadPlayhead(HASH, 470)).toBeNull();
  });

  it("reads a corrupted value as absent rather than seeking somewhere invented", () => {
    localStorage.setItem(playheadKey(HASH), "not-a-number");
    expect(loadPlayhead(HASH)).toBeNull();
    localStorage.setItem(playheadKey(HASH), "");
    expect(loadPlayhead(HASH)).toBeNull();
  });

  it("survives an empty hash without writing a junk key", () => {
    expect(savePlayhead("", 100)).toBe(false);
    expect(loadPlayhead("")).toBeNull();
  });

  it("clears", () => {
    savePlayhead(HASH, 100);
    clearPlayhead(HASH);
    expect(loadPlayhead(HASH)).toBeNull();
  });
});

describe("shouldPersist", () => {
  it("throttles: a timeupdate fires ~4x a second, localStorage is synchronous", () => {
    expect(shouldPersist(100, 101)).toBe(false);
    expect(shouldPersist(100, 105)).toBe(true);
  });

  it("fires on a backward jump too - a seek back is a position change", () => {
    expect(shouldPersist(100, 20)).toBe(true);
  });
});
