import { describe, expect, it } from "vitest";
import { type KnownSpeaker, suggestSpeakers } from "./speaker-suggest";

const ALL: KnownSpeaker[] = [
  { name: "Buzz Aldrin", ingests: 1 },
  { name: "Buzz Aldrin (External Footage)", ingests: 2 },
  { name: 'Robert "Bob" Bigelow', ingests: 3 },
  { name: "Ross Coulthart", ingests: 3 },
  { name: "Jesse Michels", ingests: 10 },
];
const names = (q: string, used: string[] = []) => suggestSpeakers(ALL, q, used).map((s) => s.name);

describe("suggestSpeakers", () => {
  it("surfaces the other formatting of a name already in the corpus", () => {
    // The actual duplication: the same person, written two ways, in two
    // ingests. Typing the short form should show the long one exists.
    expect(names("Buzz Aldrin")).toEqual(["Buzz Aldrin (External Footage)"]);
  });

  it("finds a person by their nickname", () => {
    // Nicknames are the case where nobody remembers the formatting they chose.
    expect(names("bob")).toEqual(['Robert "Bob" Bigelow']);
  });

  it("finds a person by surname", () => {
    expect(names("coulthart")).toEqual(["Ross Coulthart"]);
  });

  it("does not match mid-word, which would make the list noise", () => {
    expect(names("ob")).toEqual([]);
  });

  it("stays quiet until there is enough to go on", () => {
    expect(names("b")).toEqual([]);
    expect(names(" ")).toEqual([]);
  });

  it("drops the exact name already typed", () => {
    // Offering back what the reviewer just wrote teaches them nothing.
    expect(names("Ross Coulthart")).toEqual([]);
  });

  it("drops names already used in this record", () => {
    expect(names("buzz", ["Buzz Aldrin (External Footage)"])).toEqual(["Buzz Aldrin"]);
  });

  it("prefers a leading match, then the commoner spelling", () => {
    const all: KnownSpeaker[] = [
      { name: "Mark Smith", ingests: 1 },
      { name: "Smith Jones", ingests: 9 },
      { name: "A Smithers", ingests: 4 },
    ];
    expect(suggestSpeakers(all, "smith", []).map((s) => s.name)).toEqual([
      "Smith Jones",
      "A Smithers",
      "Mark Smith",
    ]);
  });

  it("ignores case and accents", () => {
    expect(names("ROSS")).toEqual(["Ross Coulthart"]);
  });
});
