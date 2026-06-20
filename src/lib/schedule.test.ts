import { describe, it, expect } from "vitest";
import { resolveTarget, stageRank } from "./schedule";

describe("resolveTarget", () => {
  const hash = "a".repeat(64);
  const titles = { [hash]: "In Plain Sight" };

  it("shows a known record's title and deep-links by its 56-char public hash", () => {
    expect(resolveTarget({ kind: "record", label: "record aaaa", hash }, titles)).toEqual({
      label: "In Plain Sight",
      href: `/${"a".repeat(56)}`,
    });
  });

  it("keeps the scheduler label and is NOT linkable for an un-ingested source", () => {
    // record-kind target whose hash isn't a known record yet (e.g. an ingest job)
    expect(
      resolveTarget({ kind: "record", label: "web page 00880db2", hash: "b".repeat(64) }, titles),
    ).toEqual({
      label: "web page 00880db2",
      href: null,
    });
  });

  it("returns the slug with no link for a page target", () => {
    expect(resolveTarget({ kind: "page", label: "some-slug" }, titles)).toEqual({
      label: "some-slug",
      href: null,
    });
  });

  it("respects an explicit href when present", () => {
    expect(resolveTarget({ kind: "page", label: "x", href: "/y" }, titles).href).toBe("/y");
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
