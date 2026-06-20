import { describe, it, expect } from "vitest";
import { recordDemand, stageRank } from "./schedule";

describe("recordDemand (placeholder per-record priority)", () => {
  it("is deterministic and in 0..99", () => {
    const a = recordDemand("a".repeat(64));
    expect(recordDemand("a".repeat(64))).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(100);
  });

  it("varies by hash so the demand sort produces an order", () => {
    expect(recordDemand("abc123")).not.toBe(recordDemand("zzz999"));
  });
});

describe("stageRank", () => {
  it("orders the pipeline, unknown stages last", () => {
    expect(stageRank("ingest")).toBeLessThan(stageRank("digest"));
    expect(stageRank("digest")).toBeLessThan(stageRank("assemble"));
    expect(stageRank("assemble")).toBeLessThan(stageRank("verify"));
    expect(stageRank("mystery")).toBeGreaterThanOrEqual(stageRank("verify"));
  });
});
