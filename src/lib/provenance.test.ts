import { describe, it, expect } from "vitest";
import { provenanceOf, isPubliclyViewable } from "./api";

describe("isPubliclyViewable", () => {
  it("is true for freely-viewable statuses", () => {
    expect(isPubliclyViewable("public_domain")).toBe(true);
    expect(isPubliclyViewable("open_licence")).toBe(true);
    expect(isPubliclyViewable("publicly_accessible")).toBe(true);
  });
  it("is false for gated statuses", () => {
    expect(isPubliclyViewable("licensed")).toBe(false);
    expect(isPubliclyViewable("restricted")).toBe(false);
  });
});

describe("provenanceOf", () => {
  it("treats an http source_url as the traceable origin", () => {
    const p = provenanceOf({ source_url: "https://example.com/x" });
    expect(p).toEqual({ kind: "url", label: "https://example.com/x", traceable: true });
  });

  it("treats a local source_file as the traceable origin", () => {
    const p = provenanceOf({ source_file: "DOW-UAP-D8-Mission-Report.pdf" });
    expect(p).toEqual({
      kind: "file",
      label: "DOW-UAP-D8-Mission-Report.pdf",
      traceable: true,
    });
  });

  it("prefers source_url over source_file when both are present", () => {
    const p = provenanceOf({ source_url: "https://example.com", source_file: "x.pdf" });
    expect(p.kind).toBe("url");
  });

  it("marks provenance: unknown as untraceable", () => {
    const p = provenanceOf({ provenance: "unknown" });
    expect(p).toEqual({ kind: "unknown", label: "Origin unknown", traceable: false });
  });

  it("marks a record with no acquisition fields as untraceable", () => {
    const p = provenanceOf({});
    expect(p.kind).toBe("none");
    expect(p.traceable).toBe(false);
  });

  it("ignores empty-string fields", () => {
    const p = provenanceOf({ source_url: "", source_file: "", provenance: "" });
    expect(p.traceable).toBe(false);
    expect(p.kind).toBe("none");
  });
});
