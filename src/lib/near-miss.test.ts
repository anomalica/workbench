import { describe, expect, it } from "vitest";
import { nearMiss } from "./near-miss";

const CORPUS = [
  "Jesse Michels",
  "Ross Coulthart",
  "Maaneli Derakshani (Max)",
  "Chris Ramsay",
  "Ben",
];

describe("nearMiss", () => {
  it("catches the misspellings actually in the corpus", () => {
    // Every one of these was typed by a reviewer and split a person into two
    // graph nodes.
    expect(nearMiss("Jessie Michaels", CORPUS)).toBe("Jesse Michels");
    expect(nearMiss("Ross Couthart", CORPUS)).toBe("Ross Coulthart");
    expect(nearMiss("Maaneli Derakhsani (Max)", CORPUS)).toBe("Maaneli Derakshani (Max)");
  });

  it("says nothing about a name already used exactly", () => {
    expect(nearMiss("Jesse Michels", CORPUS)).toBeNull();
  });

  it("says nothing about a plainly different person", () => {
    expect(nearMiss("David Grusch", CORPUS)).toBeNull();
    expect(nearMiss("Luis Elizondo", CORPUS)).toBeNull();
  });

  it("holds short names to a tighter budget, because Ben and Ken are two people", () => {
    expect(nearMiss("Ken", CORPUS)).toBe("Ben");
    expect(nearMiss("Kent", CORPUS)).toBeNull();
  });

  it("ignores case", () => {
    expect(nearMiss("jesse michels", CORPUS)).toBeNull();
    expect(nearMiss("jessie michels", CORPUS)).toBe("Jesse Michels");
  });

  it("stays quiet on a fragment", () => {
    expect(nearMiss("Je", CORPUS)).toBeNull();
  });
});
