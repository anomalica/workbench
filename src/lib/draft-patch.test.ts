import { describe, expect, it } from "vitest";
import { decodePatch, encodePatch, fingerprint, patchSize } from "./draft-patch";

const book = (lines: number) =>
  Array.from({ length: lines }, (_, i) => `Line ${i}: some ordinary sentence of prose.`).join("\n");

describe("encode/decode round-trip", () => {
  const cases: [string, string, string][] = [
    ["one line changed", "a\nb\nc", "a\nB\nc"],
    ["a line inserted", "a\nb\nc", "a\nnew\nb\nc"],
    ["a line deleted", "a\nb\nc", "a\nc"],
    ["everything replaced", "a\nb\nc", "x\ny\nz"],
    ["nothing changed", "a\nb\nc", "a\nb\nc"],
    ["emptied", "a\nb\nc", ""],
    ["from empty", "", "a\nb"],
    ["lines reordered", "a\nb\nc", "c\nb\na"],
    ["duplicate lines", "a\na\na", "a\nb\na"],
    ["trailing newline kept", "a\nb\n", "a\nB\n"],
  ];
  for (const [name, from, to] of cases) {
    it(name, () => {
      expect(decodePatch(from, encodePatch(from, to))).toBe(to);
    });
  }
});

describe("size - the reason this exists", () => {
  it("a one-line edit in a big book costs bytes, not another copy of the book", () => {
    // The actual bug: marking one segment irrelevant in a 780KB book wrote
    // 780KB to localStorage, and the quota is ~5MB for the whole origin.
    const original = book(20_000);
    const current = original.replace("Line 9000:", "Line 9000: [irrelevant]");
    const patch = encodePatch(original, current);
    expect(decodePatch(original, patch)).toBe(current);
    expect(patchSize(patch)).toBeLessThan(200);
    expect(original.length).toBeGreaterThan(700_000);
  });

  it("stays small when the edits are scattered through the whole book", () => {
    // Fifty separate edits must not degrade into "store the rest verbatim" -
    // that was the failure mode a prefix/suffix trim would have had.
    const lines = book(20_000).split("\n");
    for (let i = 0; i < 50; i++) lines[i * 400 + 7] = `Line ${i * 400 + 7}: [irrelevant]`;
    const current = lines.join("\n");
    const original = book(20_000);
    const patch = encodePatch(original, current);
    expect(decodePatch(original, patch)).toBe(current);
    expect(patchSize(patch)).toBeLessThan(6_000);
  });
});

describe("refusing to apply a patch to the wrong text", () => {
  it("returns null when the record changed under the draft", () => {
    // Someone else edited the record, or the ingester re-extracted it. Applying
    // the patch anyway would splice the reviewer's lines into a document they
    // never saw.
    const patch = encodePatch("a\nb\nc", "a\nB\nc");
    expect(decodePatch("a\nDIFFERENT\nc", patch)).toBeNull();
  });

  it("returns null for a copy op pointing past the end", () => {
    expect(decodePatch("a\nb", { base: fingerprint("a\nb"), ops: [{ c: [0, 99] }] })).toBeNull();
  });
});
