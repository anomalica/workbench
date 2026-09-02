import { describe, it, expect } from "vitest";
import { carryoverState, carryoverTooltip } from "./carryover";

describe("carryoverState", () => {
  it("is none without a carry marker", () => {
    expect(carryoverState(undefined, undefined)).toBe("none");
    expect(carryoverState("", "2026-06-15T00:00:00Z")).toBe("none");
  });
  it("needs verify when carried but never reviewed", () => {
    expect(carryoverState("2026-06-15T10:00:00Z", undefined)).toBe("needs_verify");
  });
  it("needs verify when the review predates the re-ingest (stale)", () => {
    expect(carryoverState("2026-06-15T10:00:00Z", "2026-06-01T09:00:00Z")).toBe("needs_verify");
  });
  it("is verified when reviewed at or after the carry", () => {
    expect(carryoverState("2026-06-15T10:00:00Z", "2026-06-15T10:00:00Z")).toBe("verified");
    expect(carryoverState("2026-06-15T10:00:00Z", "2026-06-16T08:00:00Z")).toBe("verified");
  });
});

describe("carryoverTooltip", () => {
  it("says what survived and what did not", () => {
    const t = carryoverTooltip({ at: "2026-09-02T10:00:00Z", from: "abc", had_text_edits: false });
    expect(t).toMatch(/highlights, notes, links/);
    expect(t).toMatch(/marked as read was not/);
    expect(t).not.toMatch(/changed/);
  });

  it("says when the prose itself moved", () => {
    const t = carryoverTooltip({ at: "2026-09-02T10:00:00Z", from: "abc", had_text_edits: true });
    expect(t).toMatch(/text itself changed/);
  });

  it("still reads sensibly when the marker is absent", () => {
    // The list shows the state from a hash set; the object may not be to hand.
    expect(carryoverTooltip(null)).toMatch(/look again/);
  });
});
