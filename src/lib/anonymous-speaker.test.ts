/**
 * Square brackets mean "this is a description, not a name".
 *
 * `[interviewer 2]` in one recording is not the same person as `[interviewer
 * 2]` in another. Nothing downstream may merge them or build a person from
 * them - which is exactly what a bare `Interviewer` invites, and why the
 * corpus already carries `Interviewer`, `Unknown`, `Unknown Speaker` and
 * `Recovery team member` as if they were names.
 */

import { describe, expect, it } from "vitest";
import {
  anonymousLabel,
  asAnonymousSpeaker,
  isAnonymousSpeaker,
  isDefaultSpeakerName,
  isSpecialSpeaker,
  nextSpeakerName,
} from "./transcript";
import type { Segment } from "./transcript";

function seg(speaker: string): Segment {
  return { speaker, time: "0:00", seconds: 0, lines: [""], index: 0 };
}

describe("telling a description from a name", () => {
  it("recognises a bracketed description", () => {
    expect(isAnonymousSpeaker("[interviewer 2]")).toBe(true);
    expect(isAnonymousSpeaker("[audience member]")).toBe(true);
  });

  it("does not mistake a real name for one", () => {
    expect(isAnonymousSpeaker("William F. Hamilton")).toBe(false);
    expect(isAnonymousSpeaker("Speaker 3")).toBe(false);
    // A name that merely contains brackets is still a name.
    expect(isAnonymousSpeaker("Robert (Bob) Lazar")).toBe(false);
  });

  it("keeps a name that carries a disambiguating parenthetical", () => {
    // About twenty real people in the corpus are written this way, and they
    // DO match across records - the parenthetical is what tells two Sallys
    // apart. Reading one as anonymous would remove them from the graph.
    // Only a value that is ENTIRELY a description is bracketed.
    for (const name of [
      "Sally (Budd Hopkins abductee)",
      "Dave (SR-71 pilot)",
      "Dr. X (French physician)",
      "A Friend (anonymous army sergeant)",
      "Ground Control (Wally)",
    ]) {
      expect(isAnonymousSpeaker(name)).toBe(false);
    }
  });

  it("covers the reserved tokens, which were always descriptions", () => {
    // [narrator] has never been a person's name. The reserved four are simply
    // the descriptions common enough to be worth naming in the spec.
    for (const token of ["[narrator]", "[irrelevant]", "[group]"]) {
      expect(isSpecialSpeaker(token)).toBe(true);
      expect(isAnonymousSpeaker(token)).toBe(true);
    }
  });
});

describe("writing one", () => {
  it("wraps a description", () => {
    expect(asAnonymousSpeaker("interviewer 2")).toBe("[interviewer 2]");
  });

  it("does not double-wrap one already written", () => {
    expect(asAnonymousSpeaker("[interviewer 2]")).toBe("[interviewer 2]");
  });

  it("is nothing when there is no description", () => {
    expect(asAnonymousSpeaker("   ")).toBe("");
    expect(asAnonymousSpeaker("[]")).toBe("");
  });

  it("reads back the description for display", () => {
    expect(anonymousLabel("[recovery team member]")).toBe("recovery team member");
  });
});

describe("a diarisation id is itself anonymous", () => {
  it("counts a bracketed default as unnamed", () => {
    // The ingester writes `[speaker 3]`; older records say `Speaker 3`. Both
    // are a cluster number. If the bracketed one failed this test it would be
    // filed as a person and written into the record's speaker list.
    expect(isDefaultSpeakerName("[speaker 3]")).toBe(true);
    expect(isDefaultSpeakerName("Speaker 3")).toBe(true);
  });

  it("does not catch a description that merely mentions a number", () => {
    expect(isDefaultSpeakerName("[interviewer 2]")).toBe(false);
    expect(isDefaultSpeakerName("Speaker of the House")).toBe(false);
  });

  it("numbers the next one in the style the record already uses", () => {
    // Two spellings of the same idea inside one record reads as a bug.
    expect(nextSpeakerName([seg("[speaker 1]"), seg("[speaker 2]")])).toBe("[speaker 3]");
    expect(nextSpeakerName([seg("Speaker 1"), seg("Speaker 2")])).toBe("Speaker 3");
    expect(nextSpeakerName([seg("William F. Hamilton")])).toBe("Speaker 1");
  });
});
