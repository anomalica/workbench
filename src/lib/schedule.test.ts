import { describe, it, expect } from "vitest";
import { targetHref, stageRank } from "./schedule";

describe("targetHref", () => {
  it("links a record target by its public (56-char) hash", () => {
    const hash = "a".repeat(64);
    expect(targetHref({ kind: "record", label: "x", hash })).toBe(`/${"a".repeat(56)}`);
  });

  it("returns null for a page target (no workbench page view yet)", () => {
    expect(targetHref({ kind: "page", label: "some-slug" })).toBeNull();
  });

  it("returns null for a record with no hash", () => {
    expect(targetHref({ kind: "record", label: "x" })).toBeNull();
  });

  it("respects an explicit href when present", () => {
    expect(targetHref({ kind: "page", label: "x", href: "/y" })).toBe("/y");
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
