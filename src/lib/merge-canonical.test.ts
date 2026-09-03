import { describe, expect, it } from "vitest";
import { suggestedCanonical } from "./merge-canonical";

const MEMBERS = [
  { id: "e57005b4-b10f-49a9-872f-61f00312b820", name: "Gimbal video", claims: 61 },
  { id: "aaaaaaaa-b10f-49a9-872f-61f00312b820", name: "Gimbal (US military UAP video)", claims: 0 },
];

describe("the name a merge survivor is offered", () => {
  it("keeps a real name", () => {
    expect(suggestedCanonical("Gimbal video", MEMBERS)).toBe("Gimbal video");
  });

  it("resolves a node id to the member it names", () => {
    // 253 of the 404 proposals in the queue suggested an id, pre-selected, so
    // confirming one would have named the page after a uuid.
    expect(suggestedCanonical("e57005b4-b10f-49a9-872f-61f00312b820", MEMBERS)).toBe(
      "Gimbal video",
    );
  });

  it("falls back to the heaviest member when the id names nobody", () => {
    expect(suggestedCanonical("ffffffff-b10f-49a9-872f-61f00312b820", MEMBERS)).toBe(
      "Gimbal video",
    );
  });

  it("falls back when there is no suggestion at all", () => {
    expect(suggestedCanonical("", MEMBERS)).toBe("Gimbal video");
    expect(suggestedCanonical(null, MEMBERS)).toBe("Gimbal video");
  });

  it("is empty rather than wrong when there is nothing to offer", () => {
    expect(suggestedCanonical(null, [])).toBe("");
  });

  it("does not mistake a name that merely looks technical for an id", () => {
    const members = [{ id: "x", name: "MJ-12", claims: 3 }];
    expect(suggestedCanonical("MJ-12", members)).toBe("MJ-12");
  });
});
