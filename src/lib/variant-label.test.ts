import { describe, expect, it } from "vitest";
import { hasAmbiguousModels, variantLabels } from "./variant-label";

// The real jon-stewart variant set: two opus digests at different prompts.
const JON_STEWART = [
  { id: "haiku.d161b1ed", model: "haiku", prompt_fingerprint: "515508ce" },
  { id: "opus-v3", model: "opus", prompt_fingerprint: "ba1de88a" },
  { id: "opus.d161b1ed", model: "opus", prompt_fingerprint: "515508ce" },
  { id: "sonnet.d161b1ed", model: "sonnet", prompt_fingerprint: "515508ce" },
];

describe("variantLabels", () => {
  it("leaves an unambiguous model name alone", () => {
    const labels = variantLabels(JON_STEWART);
    expect(labels.get("haiku.d161b1ed")).toBe("haiku");
    expect(labels.get("sonnet.d161b1ed")).toBe("sonnet");
  });

  it("qualifies a repeated model name with the prompt that differs", () => {
    // Two rows both reading "opus", one of them silent, is the display that
    // made the comparison unreadable.
    const labels = variantLabels(JON_STEWART);
    expect(labels.get("opus-v3")).toBe("opus · ba1de88a");
    expect(labels.get("opus.d161b1ed")).toBe("opus · 515508ce");
  });

  it("never gives two variants the same label", () => {
    const labels = [...variantLabels(JON_STEWART).values()];
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("falls back to the id when the fingerprint is unknown", () => {
    const labels = variantLabels([
      { id: "opus-a", model: "opus", prompt_fingerprint: "" },
      { id: "opus-b", model: "opus" },
    ]);
    expect(labels.get("opus-a")).toBe("opus · opus-a");
    expect(labels.get("opus-b")).toBe("opus · opus-b");
    expect(new Set([...labels.values()]).size).toBe(2);
  });

  it("handles a single variant and an empty set", () => {
    expect(variantLabels([{ id: "a", model: "haiku" }]).get("a")).toBe("haiku");
    expect(variantLabels([]).size).toBe(0);
  });
});

describe("hasAmbiguousModels", () => {
  it("is true when a model name repeats", () => {
    expect(hasAmbiguousModels(JON_STEWART)).toBe(true);
  });

  it("is false when every model appears once", () => {
    expect(hasAmbiguousModels(JON_STEWART.filter((v) => v.id !== "opus-v3"))).toBe(false);
  });
});
