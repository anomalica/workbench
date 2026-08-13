import { describe, expect, it } from "vitest";
import { foldTurns, type SpeakerRun } from "./transcript-words";

const IRR = "[irrelevant]";
const runs = (...speakers: string[]): SpeakerRun[] =>
  speakers.map((speaker, i) => ({ speaker, startWord: i * 10, endWord: i * 10 + 9 }));
const shape = (t: ReturnType<typeof foldTurns>) =>
  t.map((x) => `${x.speaker}:${x.parts.map((p) => (p.cut ? "cut" : "words")).join("+")}`);

describe("foldTurns", () => {
  it("folds a correction back into the sentence it interrupted", () => {
    // The reported case: he said the wrong word, corrected himself, and two
    // words were cut. That is one turn, not three.
    expect(shape(foldTurns(runs("Lex", IRR, "Lex"), IRR))).toEqual(["Lex:words+cut+words"]);
  });

  it("keeps a cut between two different speakers as its own turn", () => {
    expect(shape(foldTurns(runs("Lex", IRR, "Eric"), IRR))).toEqual([
      "Lex:words",
      "[irrelevant]:cut",
      "Eric:words",
    ]);
  });

  it("folds several cuts into one turn", () => {
    expect(shape(foldTurns(runs("Lex", IRR, "Lex", IRR, "Lex"), IRR))).toEqual([
      "Lex:words+cut+words+cut+words",
    ]);
  });

  it("folds consecutive cuts", () => {
    expect(shape(foldTurns(runs("Lex", IRR, IRR, "Lex"), IRR))).toEqual([
      "Lex:words+cut+cut+words",
    ]);
  });

  it("gives a cut at the very start its own turn", () => {
    expect(shape(foldTurns(runs(IRR, "Lex"), IRR))).toEqual(["[irrelevant]:cut", "Lex:words"]);
  });

  it("gives a cut at the very end its own turn", () => {
    expect(shape(foldTurns(runs("Lex", IRR), IRR))).toEqual(["Lex:words", "[irrelevant]:cut"]);
  });

  it("leaves two adjacent turns by the same speaker alone", () => {
    // Merging those is mergeAdjacentSpeakers' job and a change to the record;
    // this only changes drawing, and only around a cut.
    expect(shape(foldTurns(runs("Lex", "Lex"), IRR))).toEqual(["Lex:words", "Lex:words"]);
  });

  it("keeps the lead run, so the header and selection act on the turn's start", () => {
    const t = foldTurns(runs("Lex", IRR, "Lex"), IRR);
    expect(t[0].lead.startWord).toBe(0);
  });
});
