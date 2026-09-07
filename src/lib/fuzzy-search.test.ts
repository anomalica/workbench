import { describe, expect, it } from "vitest";
import { editDistance, fuzzyScore, type SearchField } from "./fuzzy-search";

/** The record Mark could not find by typing "john cia". */
const RAMIREZ: SearchField[] = [
  {
    text: "Ex-CIA Officer Confirms Alien Hybrids Exist - John Ramirez - DEBRIEFED ep. 42",
    weight: 1,
  },
  { text: "", weight: 0.8 },
  { text: "Area52", weight: 0.6 },
  { text: "2025-03-14", weight: 0.5 },
];

const FRAVOR: SearchField[] = [
  { text: "David Fravor: UFOs, Aliens, Fighter Jets, and Aerospace Engineering", weight: 1 },
  { text: "", weight: 0.8 },
  { text: "Lex Fridman", weight: 0.6 },
  { text: "2020-09-08", weight: 0.5 },
];

const SEVEN_NEWS: SearchField[] = [
  { text: "The UFO Phenomenon | Full Documentary 2021 | 7NEWS Spotlight", weight: 1 },
  { text: "Ross Coulthart", weight: 0.8 },
  { text: "7 News Spotlight", weight: 0.6 },
  { text: "2021-09-06", weight: 0.5 },
];

describe("editDistance", () => {
  it("is zero for the same string", () => {
    expect(editDistance("ramirez", "ramirez", 2)).toBe(0);
  });

  it("counts an adjacent transposition as one edit", () => {
    expect(editDistance("ramriez", "ramirez", 2)).toBe(1);
  });

  it("counts a substitution, an insertion and a deletion as one each", () => {
    expect(editDistance("ramarez", "ramirez", 2)).toBe(1);
    expect(editDistance("ramirezz", "ramirez", 2)).toBe(1);
    expect(editDistance("ramire", "ramirez", 2)).toBe(1);
  });

  it("gives up rather than counting past the limit", () => {
    expect(editDistance("coulthart", "fridman", 2)).toBeGreaterThan(2);
  });

  it("handles an empty side", () => {
    expect(editDistance("", "abc", 5)).toBe(3);
    expect(editDistance("abc", "", 5)).toBe(3);
  });
});

describe("fuzzyScore", () => {
  it("finds words that are scattered and out of order", () => {
    expect(fuzzyScore("john cia", RAMIREZ)).not.toBeNull();
    expect(fuzzyScore("cia john", RAMIREZ)).not.toBeNull();
    expect(fuzzyScore("ramirez hybrids", RAMIREZ)).not.toBeNull();
  });

  it("forgives a misspelt name", () => {
    expect(fuzzyScore("ramriez", RAMIREZ)).not.toBeNull();
    expect(fuzzyScore("john ramerez", RAMIREZ)).not.toBeNull();
    expect(fuzzyScore("coulthard", SEVEN_NEWS)).not.toBeNull();
  });

  it("still matches punctuation the way it was typed", () => {
    expect(fuzzyScore("ex-cia", RAMIREZ)).not.toBeNull();
    expect(fuzzyScore("ex cia", RAMIREZ)).not.toBeNull();
  });

  it("requires every word, so adding one narrows the list", () => {
    expect(fuzzyScore("john", RAMIREZ)).not.toBeNull();
    expect(fuzzyScore("john fravor", RAMIREZ)).toBeNull();
  });

  it("matches the publisher and the creator, not only the title", () => {
    expect(fuzzyScore("area52", RAMIREZ)).not.toBeNull();
    expect(fuzzyScore("coulthart", SEVEN_NEWS)).not.toBeNull();
    expect(fuzzyScore("2021-09", SEVEN_NEWS)).not.toBeNull();
  });

  it("holds numbers to what was typed", () => {
    expect(fuzzyScore("ep 42", RAMIREZ)).not.toBeNull();
    expect(fuzzyScore("ep 41", RAMIREZ)).toBeNull();
    expect(fuzzyScore("2020-09-08", FRAVOR)).not.toBeNull();
    expect(fuzzyScore("2020-09-09", FRAVOR)).toBeNull();
  });

  it("leaves short words alone rather than reaching", () => {
    expect(fuzzyScore("ufo", SEVEN_NEWS)).not.toBeNull();
    expect(fuzzyScore("ufc", SEVEN_NEWS)).toBeNull();
  });

  it("returns null for an empty query", () => {
    expect(fuzzyScore("", RAMIREZ)).toBeNull();
    expect(fuzzyScore("   ", RAMIREZ)).toBeNull();
  });

  it("ranks the word as typed above the same word misspelt", () => {
    const exact = fuzzyScore("ramirez", RAMIREZ);
    const typo = fuzzyScore("ramriez", RAMIREZ);
    expect(exact).not.toBeNull();
    expect(typo).not.toBeNull();
    expect(exact!).toBeGreaterThan(typo!);
  });

  it("ranks a title match above the same word in the publisher", () => {
    const inTitle = fuzzyScore("spotlight", [
      { text: "Spotlight on the phenomenon", weight: 1 },
      { text: "", weight: 0.8 },
      { text: "Channel 9", weight: 0.6 },
    ]);
    const inPublisher = fuzzyScore("spotlight", [
      { text: "The UFO Phenomenon", weight: 1 },
      { text: "", weight: 0.8 },
      { text: "7 News Spotlight", weight: 0.6 },
    ]);
    expect(inTitle!).toBeGreaterThan(inPublisher!);
  });

  it("ranks the whole phrase found intact above its words gathered separately", () => {
    const phrase = fuzzyScore("john ramirez", RAMIREZ);
    const scattered = fuzzyScore("john hybrids", RAMIREZ);
    expect(phrase!).toBeGreaterThan(scattered!);
  });

  it("puts the record that was meant at the top", () => {
    const scored = [RAMIREZ, FRAVOR, SEVEN_NEWS]
      .map((f, i) => ({ i, score: fuzzyScore("john cia", f) }))
      .filter((r) => r.score !== null)
      .sort((a, b) => b.score! - a.score!);
    expect(scored[0].i).toBe(0);
  });
});
