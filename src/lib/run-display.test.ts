import { describe, expect, it } from "vitest";
import { runDisplays, type SpeakerRun } from "./transcript-words";

const IRR = "[irrelevant]";
const runs = (...speakers: string[]): SpeakerRun[] =>
  speakers.map((speaker, i) => ({ speaker, startWord: i * 10, endWord: i * 10 + 9 }));

describe("runDisplays", () => {
  it("folds a cut into the turn it interrupts", () => {
    // A speaker says something, a sentence is cut, they carry on. One turn,
    // one header, and the cut drawn inside it.
    const d = runDisplays(runs("Lex", IRR, "Lex"), IRR);
    expect(d.map((x) => x.header)).toEqual([true, false, false]);
    expect(d.map((x) => x.divider)).toEqual([true, false, false]);
    expect(d[1].cutInsideTurn).toBe(true);
  });

  it("keeps a cut between two different speakers as its own block", () => {
    // Nothing is being interrupted - the turn ended anyway.
    const d = runDisplays(runs("Lex", IRR, "Eric"), IRR);
    expect(d.map((x) => x.header)).toEqual([true, true, true]);
    expect(d[1].cutInsideTurn).toBe(false);
  });

  it("folds several cuts in one turn", () => {
    const d = runDisplays(runs("Lex", IRR, "Lex", IRR, "Lex"), IRR);
    expect(d.map((x) => x.header)).toEqual([true, false, false, false, false]);
    expect(d.filter((x) => x.cutInsideTurn).length).toBe(2);
  });

  it("handles consecutive cuts inside a turn", () => {
    const d = runDisplays(runs("Lex", IRR, IRR, "Lex"), IRR);
    expect(d[3].header).toBe(false);
    // Neither cut ends the turn, so neither draws a divider.
    expect(d.map((x) => x.divider)).toEqual([true, false, false, false]);
  });

  it("gives a cut at the start or end its own block", () => {
    expect(runDisplays(runs(IRR, "Lex"), IRR)[0].cutInsideTurn).toBe(false);
    expect(runDisplays(runs("Lex", IRR), IRR)[1].cutInsideTurn).toBe(false);
  });

  it("does not merge two turns by the same speaker with no cut between them", () => {
    // Adjacent same-speaker runs are a separate concern (mergeAdjacentSpeakers);
    // this must not silently swallow them.
    const d = runDisplays(runs("Lex", "Lex"), IRR);
    expect(d.map((x) => x.header)).toEqual([true, true]);
  });
});
