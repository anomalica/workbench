import { describe, it, expect } from "vitest";
import { makeHighlightId } from "./highlight-markers";

// Ids became permanent handles the moment a {{highlight-context: [...]}} edge
// could name one. The old "lowest unused" rule reissued a freed id, so deleting
// highlight 11 and highlighting something else later re-pointed the edge at an
// unrelated span - a confidently wrong reference, not a visibly broken one.
describe("makeHighlightId: never reissues", () => {
  it("mints above the high-water mark, not into the gap", () => {
    // 11 deleted. The old rule handed 11 straight back.
    expect(makeHighlightId(["10", "12"])).not.toBe("11");
  });

  it("leaves deletion gaps alone however many there are", () => {
    const next = makeHighlightId(["10", "15"]);
    expect(["11", "12", "13", "14"]).not.toContain(next);
    expect(Number.parseInt(next, 36)).toBeGreaterThan(Number.parseInt("15", 36));
  });

  it("never reissues an id that is still MENTIONED anywhere", () => {
    // The guarantee that actually protects a chain: as long as an id appears in
    // the body - as a highlight, a span note, or inside a retained context edge -
    // it is never handed to something else. Deleting a MIDDLE highlight (the
    // corruption case the old rule hit) cannot reissue its id.
    let ids = ["10", "11", "12"];
    const seen = new Set(ids);
    for (let i = 0; i < 25; i++) {
      const id = makeHighlightId(ids);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
      ids = [...ids, id];
      // delete a middle one; its id stays claimed by the ids array only if
      // something still references it, which the context edge does.
      if (i % 3 === 0 && ids.length > 3) ids.splice(1, 1);
    }
  });

  // KNOWN GAP - NOT harmless, and asserted so it can't drift unnoticed. Deleting
  // the CURRENT-HIGHEST id lowers the high-water mark, so that id can be minted
  // again.
  //
  // I originally reasoned this was safe because no IN-RECORD reference to it
  // survives. That reasoning is wrong (master's correction): shareable URLs
  // address (record-hash, link-id) from OUTSIDE the record, and a record cannot
  // know what URLs exist in the wild. Share a URL to the highest highlight, delete
  // it, mint again, and that URL resolves CONFIDENTLY WRONG - no writer anywhere
  // can repair it, which is the case non-reuse exists to prevent.
  //
  // The real fix is a persisted high-water-mark field on the record (routed to
  // anomalica). This test pins the CURRENT behaviour so the gap stays visible;
  // when the field lands, tighten it to assert full non-reuse.
  it("GAP: reuse still possible for the highest id (pending persisted counter)", () => {
    expect(makeHighlightId(["10", "11"])).toBe("12");
    expect(makeHighlightId(["10"])).toBe("11"); // 11 deleted and unreferenced
  });

  it("counts ids named ONLY by a dangling context edge as taken", () => {
    // The edge is retained when its target is deleted, so the id stays claimed -
    // reissuing it would make the dangling edge silently resolve again.
    expect(makeHighlightId(["10", "99"])).not.toBe("99");
  });

  it("still avoids collision with non-counter ids", () => {
    const next = makeHighlightId(["10", "legacy-id", "zz"]);
    expect(["10", "legacy-id", "zz"]).not.toContain(next);
  });

  it("mints a usable id from an empty record", () => {
    const id = makeHighlightId([]);
    expect(id.length).toBeGreaterThanOrEqual(2);
  });
});

// A dangling edge keeps its target's id claimed. Regression guard for a bug that
// shipped: the doc comment on makeHighlightId said `existing` must include ids
// named by context edges, but neither mint site passed them - so deleting a
// chained highlight freed its id, and the next highlight minted could take it and
// silently inherit the dangling edge.
describe("context-edge ids are taken", () => {
  it("mints above an id that only a context edge still names", () => {
    // highlight 10 exists; 12 exists ONLY as a dangling dependency of 11.
    const next = makeHighlightId(["10", "11", "12"]);
    expect(["10", "11", "12"]).not.toContain(next);
  });
});
