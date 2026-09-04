/**
 * A speaker introduced with where they are from.
 *
 * `Scott Gordon [KXAS]` is a reporter and his station. The station reads with
 * the line and belongs to this record; the person is Scott Gordon, and that is
 * what the record stores, what another record reuses, and what extraction makes
 * a node from. A name carrying the station would make a second Scott Gordon the
 * next time he files for somebody else.
 *
 * A speaker who is ONLY a bracket means the opposite - a description where a
 * name would go, nobody to identify - so the two must not be confused. Position
 * separates them: a qualifier follows a name, it never stands alone.
 */

import { describe, expect, it } from "vitest";
import { orderedNamedSpeakers, speakerIdentity, speakerQualifier } from "./transcript";
import type { Segment } from "./transcript";

describe("who a speaker is", () => {
  it("takes the person out of a qualified label", () => {
    expect(speakerIdentity("Scott Gordon [KXAS]")).toBe("Scott Gordon");
    expect(speakerQualifier("Scott Gordon [KXAS]")).toBe("KXAS");
  });

  it("leaves a plain name alone", () => {
    expect(speakerIdentity("Scott Gordon")).toBe("Scott Gordon");
    expect(speakerQualifier("Scott Gordon")).toBe(null);
  });

  it("leaves a described speaker alone, brackets and all", () => {
    // The opposite meaning: no name to find, and stripping the brackets would
    // turn a description into a person.
    for (const described of ["[narrator]", "[speaker 3]", "[audience member]", "[irrelevant]"]) {
      expect(speakerIdentity(described)).toBe(described);
      expect(speakerQualifier(described)).toBe(null);
    }
  });

  it("handles the ordinary untidiness of a typed field", () => {
    expect(speakerIdentity("  Ross Coulthart [NewsNation]  ")).toBe("Ross Coulthart");
    expect(speakerIdentity("Dr. Steven Greer[CSETI]")).toBe("Dr. Steven Greer");
  });
});

describe("the record's named speakers", () => {
  const seg = (speaker: string): Segment => ({
    speaker,
    time: "0:00",
    seconds: 0,
    lines: ["..."],
    index: 0,
  });

  it("matches a qualified line to the person the list names", () => {
    // Compared as written, Scott Gordon would appear twice: once in the list
    // with no words, and once in the transcript as somebody nobody had named.
    const segments = [seg("Scott Gordon [KXAS]"), seg("India Naftali")];
    expect(orderedNamedSpeakers(segments, ["Scott Gordon", "India Naftali"])).toEqual([
      "Scott Gordon [KXAS]",
      "India Naftali",
    ]);
  });

  it("still lists a named speaker who says nothing", () => {
    const segments = [seg("India Naftali")];
    expect(orderedNamedSpeakers(segments, ["India Naftali", "Scott Gordon"])).toEqual([
      "India Naftali",
      "Scott Gordon",
    ]);
  });

  it("does not list one person twice because two lines qualify him differently", () => {
    const segments = [seg("Scott Gordon [KXAS]"), seg("Scott Gordon [NBC]")];
    const listed = orderedNamedSpeakers(segments, ["Scott Gordon"]);
    // Both lines are him; the first is the one the list resolves to, and he is
    // not also reported as a named speaker with nothing to say.
    expect(listed).toEqual(["Scott Gordon [KXAS]", "Scott Gordon [NBC]"]);
  });
});
