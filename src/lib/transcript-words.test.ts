import { describe, it, expect } from "vitest";
import {
  hasWordTimestamps,
  parseWords,
  serializeWords,
  reassignSpeaker,
  renameSpeakerInRuns,
  namedSpeakersInOrder,
  type SpeakerRun,
} from "./transcript-words";

// A real multi-speaker chunk lifted verbatim from a v2 (per-word-timestamp)
// record: store/079bb44a...v2.md, body lines 47-72. Five speakers, with
// Speaker 1 and Speaker 3 recurring, and a mix of multi-line and single-line
// runs. Stored as a line array joined with "\n" plus a trailing newline so the
// exact byte layout is unambiguous.
const FIXTURE_LINES = [
  "<!-- speaker: Speaker 1 -->",
  "00:00:00.1 {{t:0.13}}We {{t:0.45}}are {{t:0.81}}on {{t:0.87}}our {{t:0.97}}way {{t:1.17}}to {{t:2.05}}Homestead.",
  "00:00:03.1 {{t:3.15}}The {{t:3.27}}main {{t:3.85}}idea {{t:4.31}}is {{t:4.41}}that {{t:4.65}}we {{t:4.79}}get {{t:4.99}}to {{t:5.13}}spend {{t:5.45}}several {{t:5.77}}hours {{t:6.25}}inside {{t:7.36}}Coral {{t:7.59}}Castle {{t:8.34}}and {{t:8.70}}document {{t:9.15}}it {{t:9.29}}and {{t:9.50}}film {{t:10.14}}it {{t:10.28}}for {{t:10.38}}the {{t:10.50}}first {{t:10.72}}time {{t:10.98}}in, {{t:11.56}}you {{t:11.66}}know, {{t:12.40}}who {{t:12.52}}knows {{t:12.70}}how {{t:12.84}}long.",
  "",
  "<!-- speaker: Speaker 2 -->",
  "00:00:13.0 {{t:13.02}}He {{t:13.12}}was {{t:13.28}}brought {{t:13.52}}into {{t:13.74}}a {{t:13.82}}mystery {{t:14.16}}school {{t:14.94}}and {{t:15.08}}in {{t:15.18}}some {{t:15.40}}way {{t:15.54}}he {{t:15.64}}was {{t:15.80}}able {{t:15.96}}to {{t:16.06}}convey {{t:16.62}}the {{t:16.84}}mysteries {{t:17.22}}of {{t:17.32}}the {{t:17.58}}ancients {{t:18.06}}and {{t:18.30}}hide {{t:18.70}}mysteries {{t:19.32}}into {{t:19.62}}this {{t:19.78}}stone {{t:20.12}}construction.",
  "00:00:21.0 {{t:21.02}}They {{t:21.20}}look {{t:21.46}}down, {{t:21.82}}what {{t:22.00}}is {{t:22.20}}it {{t:22.36}}sitting {{t:22.70}}on?",
  "",
  "<!-- speaker: Speaker 3 -->",
  "00:00:22.9 {{t:22.90}}And {{t:23.00}}they {{t:23.18}}find {{t:23.46}}it's {{t:23.56}}a {{t:23.66}}piece {{t:23.90}}of {{t:24.00}}rock.",
  "00:00:24.6 {{t:24.66}}They {{t:24.86}}send {{t:25.06}}it {{t:25.14}}to {{t:25.34}}the {{t:25.46}}geology {{t:26.12}}department {{t:26.84}}and {{t:26.94}}they {{t:27.12}}say, {{t:27.70}}material {{t:28.20}}not {{t:28.45}}of {{t:28.55}}this {{t:28.79}}old.",
  "00:00:29.9 {{t:29.97}}It {{t:30.11}}comes {{t:30.59}}from {{t:31.79}}where?",
  "00:00:33.0 {{t:33.03}}Outer {{t:33.23}}space?",
  "",
  "<!-- speaker: Speaker 1 -->",
  "00:00:34.0 {{t:34.05}}Two {{t:34.25}}teenage {{t:34.67}}witnesses {{t:35.17}}were {{t:35.35}}said {{t:35.55}}to {{t:35.67}}have {{t:35.81}}seen {{t:36.11}}Ed {{t:36.29}}levitating {{t:36.83}}the {{t:36.95}}giant {{t:37.27}}stones {{t:38.19}}like {{t:38.37}}balloons.",
  "00:00:39.3 {{t:39.31}}There {{t:39.93}}is {{t:40.11}}a {{t:41.01}}black {{t:41.35}}bomb.",
  "",
  "<!-- speaker: Speaker 3 -->",
  "00:00:42.3 {{t:42.39}}They {{t:42.59}}find {{t:43.15}}a {{t:43.27}}black {{t:43.63}}bomb.",
  "",
  "<!-- speaker: Speaker 4 -->",
  "00:00:44.2 {{t:44.21}}The {{t:44.43}}gears {{t:45.27}}that {{t:45.49}}he {{t:45.57}}had {{t:45.81}}inside, {{t:46.53}}it {{t:46.65}}was {{t:46.85}}a {{t:47.01}}pump.",
  "",
  "<!-- speaker: Speaker 5 -->",
  "00:00:47.8 {{t:47.88}}and {{t:47.96}}the {{t:48.10}}holes {{t:48.36}}on {{t:48.48}}that {{t:48.80}}one {{t:49.36}}point {{t:49.76}}at {{t:49.88}}the {{t:50.00}}top {{t:50.34}}of {{t:50.48}}the {{t:50.72}}gateway {{t:51.18}}over {{t:51.42}}here {{t:51.74}}where {{t:51.88}}there's {{t:52.04}}a {{t:52.12}}metal.",
];
const FIXTURE = FIXTURE_LINES.join("\n") + "\n";

// A body that exercises both round-trip hazards together: a preamble (title +
// published line, exactly as v2 files carry it) before the first speaker
// comment, and a word line whose true start sits just below the 2dp token so a
// recomputed prefix would land one tenth too high. 422.50 rounds the prefix to
// 07:02.5, but the original ingester emitted 07:02.4 from the full-precision
// start; the literal prefix must be preserved verbatim.
const PREAMBLE_LINES = [
  "",
  "# PWTS PROJECT: STARGATE - What Happened to the Psychic Spies? (Trailer)",
  "",
  "*Published 2023-07-28*",
  "",
  "<!-- speaker: Speaker 1 -->",
  "00:07:02.4 {{t:422.50}}I {{t:422.58}}think {{t:422.76}}it's {{t:422.92}}great.",
  "00:00:00.1 {{t:0.13}}We {{t:0.45}}are.",
];
const PREAMBLE_FIXTURE = PREAMBLE_LINES.join("\n") + "\n";

describe("hasWordTimestamps", () => {
  it("detects the {{t:}} marker", () => {
    expect(hasWordTimestamps("00:00:00.1 {{t:0.13}}We")).toBe(true);
  });
  it("is false for a v1 (markerless) body", () => {
    expect(hasWordTimestamps("00:00:00.1 We are on our way.")).toBe(false);
  });
});

describe("parseWords / serializeWords round-trip", () => {
  it("returns the real v2 body byte-for-byte", () => {
    const { words, runs, lineEndWords, linePrefixes, preamble } = parseWords(FIXTURE);
    expect(serializeWords(words, runs, lineEndWords, linePrefixes, preamble)).toBe(FIXTURE);
  });

  it("preserves a line prefix the 2dp token cannot reproduce", () => {
    // 422.50 floors to 07:02.5, but the original line is 07:02.4 (true start
    // sat just below the rounded token). The literal prefix must survive.
    const { words, runs, lineEndWords, linePrefixes, preamble } = parseWords(PREAMBLE_FIXTURE);
    const out = serializeWords(words, runs, lineEndWords, linePrefixes, preamble);
    expect(out).toContain("00:07:02.4 {{t:422.50}}I");
    expect(out).not.toContain("00:07:02.5");
    expect(out).toBe(PREAMBLE_FIXTURE);
  });

  it("preserves the body preamble (title + published line) on round-trip", () => {
    const { preamble } = parseWords(PREAMBLE_FIXTURE);
    expect(preamble).toBe(
      "\n# PWTS PROJECT: STARGATE - What Happened to the Psychic Spies? (Trailer)\n\n*Published 2023-07-28*\n\n",
    );
  });

  it("assigns a global word index across the whole body", () => {
    const { words } = parseWords(FIXTURE);
    expect(words[0]).toEqual({ text: "We", start: 0.13, gIndex: 0 });
    for (let i = 0; i < words.length; i++) expect(words[i].gIndex).toBe(i);
  });

  it("produces a fresh run on speaker re-appearance (no cross-merge)", () => {
    const { runs } = parseWords(FIXTURE);
    const speakers = runs.map((r) => r.speaker);
    expect(speakers).toEqual([
      "Speaker 1",
      "Speaker 2",
      "Speaker 3",
      "Speaker 1",
      "Speaker 3",
      "Speaker 4",
      "Speaker 5",
    ]);
    // Runs cover every word with no gaps.
    let next = 0;
    for (const r of runs) {
      expect(r.startWord).toBe(next);
      next = r.endWord + 1;
    }
    expect(next).toBe(parseWords(FIXTURE).words.length);
  });

  it("records the last word index of each original line", () => {
    const { words, lineEndWords } = parseWords(FIXTURE);
    // First line ends at "Homestead." (index 6: We are on our way to Homestead.)
    expect(words[6].text).toBe("Homestead.");
    expect(lineEndWords.has(6)).toBe(true);
    // The word before it is mid-line, so not a line end.
    expect(lineEndWords.has(5)).toBe(false);
  });

  it("falls back to flooring the first word start when no prefix is captured", () => {
    // No linePrefixes entry: a freshly-created line start (e.g. a mid-line
    // speaker split) floors 47.88 to 47.8, not round to 47.9.
    const words = [
      { text: "and", start: 47.88, gIndex: 0 },
      { text: "the", start: 47.96, gIndex: 1 },
    ];
    const runs: SpeakerRun[] = [{ speaker: "Speaker 5", startWord: 0, endWord: 1 }];
    const lineEnds = new Set<number>([1]);
    expect(serializeWords(words, runs, lineEnds)).toBe(
      "<!-- speaker: Speaker 5 -->\n00:00:47.8 {{t:47.88}}and {{t:47.96}}the\n",
    );
  });

  it("prefers a captured prefix over the floored token", () => {
    const words = [
      { text: "I", start: 422.5, gIndex: 0 },
      { text: "think", start: 422.58, gIndex: 1 },
    ];
    const runs: SpeakerRun[] = [{ speaker: "Speaker 1", startWord: 0, endWord: 1 }];
    const lineEnds = new Set<number>([1]);
    const prefixes = new Map<number, string>([[0, "00:07:02.4"]]);
    expect(serializeWords(words, runs, lineEnds, prefixes)).toBe(
      "<!-- speaker: Speaker 1 -->\n00:07:02.4 {{t:422.50}}I {{t:422.58}}think\n",
    );
  });

  it("reproduces line breaks from lineEndWords", () => {
    // Same three words, split after the first vs not split.
    const words = [
      { text: "a", start: 1.0, gIndex: 0 },
      { text: "b", start: 2.0, gIndex: 1 },
      { text: "c", start: 3.0, gIndex: 2 },
    ];
    const runs: SpeakerRun[] = [{ speaker: "X", startWord: 0, endWord: 2 }];
    const oneLine = serializeWords(words, runs, new Set([2]));
    expect(oneLine).toBe("<!-- speaker: X -->\n00:00:01.0 {{t:1.00}}a {{t:2.00}}b {{t:3.00}}c\n");
    const twoLines = serializeWords(words, runs, new Set([0, 2]));
    expect(twoLines).toBe(
      "<!-- speaker: X -->\n00:00:01.0 {{t:1.00}}a\n00:00:02.0 {{t:2.00}}b {{t:3.00}}c\n",
    );
  });
});

describe("reassignSpeaker", () => {
  const base: SpeakerRun[] = [{ speaker: "A", startWord: 0, endWord: 9 }];

  it("splits the middle of a run into three", () => {
    const out = reassignSpeaker(base, 3, 6, "B");
    expect(out).toEqual([
      { speaker: "A", startWord: 0, endWord: 2 },
      { speaker: "B", startWord: 3, endWord: 6 },
      { speaker: "A", startWord: 7, endWord: 9 },
    ]);
  });

  it("yields two runs when the selection is at the run start", () => {
    const out = reassignSpeaker(base, 0, 4, "B");
    expect(out).toEqual([
      { speaker: "B", startWord: 0, endWord: 4 },
      { speaker: "A", startWord: 5, endWord: 9 },
    ]);
  });

  it("yields two runs when the selection is at the run end", () => {
    const out = reassignSpeaker(base, 5, 9, "B");
    expect(out).toEqual([
      { speaker: "A", startWord: 0, endWord: 4 },
      { speaker: "B", startWord: 5, endWord: 9 },
    ]);
  });

  it("yields one run for a whole-run reassign", () => {
    const out = reassignSpeaker(base, 0, 9, "B");
    expect(out).toEqual([{ speaker: "B", startWord: 0, endWord: 9 }]);
  });

  it("merges into the preceding neighbour when the new speaker matches it", () => {
    const runs: SpeakerRun[] = [
      { speaker: "A", startWord: 0, endWord: 4 },
      { speaker: "B", startWord: 5, endWord: 9 },
    ];
    // Reassign the start of B's run to A -> should merge with the A before it.
    const out = reassignSpeaker(runs, 5, 7, "A");
    expect(out).toEqual([
      { speaker: "A", startWord: 0, endWord: 7 },
      { speaker: "B", startWord: 8, endWord: 9 },
    ]);
  });

  it("merges into the following neighbour when the new speaker matches it", () => {
    const runs: SpeakerRun[] = [
      { speaker: "A", startWord: 0, endWord: 4 },
      { speaker: "B", startWord: 5, endWord: 9 },
    ];
    // Reassign the end of A's run to B -> should merge with the B after it.
    const out = reassignSpeaker(runs, 2, 4, "B");
    expect(out).toEqual([
      { speaker: "A", startWord: 0, endWord: 1 },
      { speaker: "B", startWord: 2, endWord: 9 },
    ]);
  });

  it("collapses three runs into one when both neighbours match", () => {
    const runs: SpeakerRun[] = [
      { speaker: "A", startWord: 0, endWord: 3 },
      { speaker: "B", startWord: 4, endWord: 6 },
      { speaker: "A", startWord: 7, endWord: 9 },
    ];
    // Reassign all of B to A -> merges with both A neighbours.
    const out = reassignSpeaker(runs, 4, 6, "A");
    expect(out).toEqual([{ speaker: "A", startWord: 0, endWord: 9 }]);
  });

  it("round-trips through serialise after a reassign", () => {
    const { words, runs, lineEndWords, linePrefixes, preamble } = parseWords(FIXTURE);
    // Reassign the whole second run (Speaker 2) to Speaker 1. Speaker 1
    // precedes it, so the runs merge across the (now removed) boundary.
    const sp2 = runs[1];
    const updated = reassignSpeaker(runs, sp2.startWord, sp2.endWord, "Speaker 1");
    expect(updated[0]).toEqual({
      speaker: "Speaker 1",
      startWord: 0,
      endWord: sp2.endWord,
    });
    const body = serializeWords(words, updated, lineEndWords, linePrefixes, preamble);
    // The Speaker 2 comment is gone; the merged run keeps both speakers' lines.
    expect(body).not.toContain("<!-- speaker: Speaker 2 -->");
    expect(body).toContain("{{t:13.02}}He");
  });

  it("keeps the preamble and original prefixes after a mid-line reassign", () => {
    const { words, runs, lineEndWords, linePrefixes, preamble } = parseWords(PREAMBLE_FIXTURE);
    // Reassign one word in the middle of the first line to a new speaker. This
    // splits the line: the first sub-line keeps the original 07:02.4 prefix; the
    // second sub-line is a new line start with no captured prefix, so it floors.
    const updated = reassignSpeaker(runs, 1, 1, "Speaker 2");
    const body = serializeWords(words, updated, lineEndWords, linePrefixes, preamble);
    // Preamble survived in full.
    expect(body).toContain("# PWTS PROJECT: STARGATE");
    expect(body).toContain("*Published 2023-07-28*");
    // First sub-line kept the verbatim original prefix (07:02.4), not a
    // recomputed value. The reassigned word starts a fresh sub-line with no
    // captured prefix, so it correctly floors its own token (422.58 -> 07:02.5).
    expect(body).toContain("00:07:02.4 {{t:422.50}}I");
    expect(body).toContain("00:07:02.5 {{t:422.58}}think");
    // The reassigned word became its own run.
    expect(body).toContain("<!-- speaker: Speaker 2 -->");
  });
});

describe("renameSpeakerInRuns", () => {
  it("renames every run owned by the speaker", () => {
    const runs: SpeakerRun[] = [
      { speaker: "Speaker 1", startWord: 0, endWord: 4 },
      { speaker: "Speaker 2", startWord: 5, endWord: 9 },
      { speaker: "Speaker 1", startWord: 10, endWord: 14 },
    ];
    const out = renameSpeakerInRuns(runs, "Speaker 1", "Ed Leedskalnin");
    expect(out.map((r) => r.speaker)).toEqual(["Ed Leedskalnin", "Speaker 2", "Ed Leedskalnin"]);
    // Word coverage unchanged.
    expect(out.map((r) => [r.startWord, r.endWord])).toEqual([
      [0, 4],
      [5, 9],
      [10, 14],
    ]);
  });

  it("merges adjacent runs when the new name matches a neighbour", () => {
    const runs: SpeakerRun[] = [
      { speaker: "Speaker 1", startWord: 0, endWord: 4 },
      { speaker: "Speaker 2", startWord: 5, endWord: 9 },
    ];
    // Rename Speaker 2 to Speaker 1 - the two runs are now contiguous and share
    // a speaker, so they coalesce into one.
    const out = renameSpeakerInRuns(runs, "Speaker 2", "Speaker 1");
    expect(out).toEqual([{ speaker: "Speaker 1", startWord: 0, endWord: 9 }]);
  });

  it("merges to an existing non-adjacent speaker, collapsing only the contiguous parts", () => {
    const runs: SpeakerRun[] = [
      { speaker: "A", startWord: 0, endWord: 2 },
      { speaker: "B", startWord: 3, endWord: 5 },
      { speaker: "A", startWord: 6, endWord: 8 },
      { speaker: "B", startWord: 9, endWord: 11 },
    ];
    // Rename every B to A. Runs 0-1 become A,A (merge) and runs 2-3 become A,A
    // (merge), so the whole thing collapses to a single A run.
    const out = renameSpeakerInRuns(runs, "B", "A");
    expect(out).toEqual([{ speaker: "A", startWord: 0, endWord: 11 }]);
  });

  it("is a no-op when old and new names match", () => {
    const runs: SpeakerRun[] = [
      { speaker: "A", startWord: 0, endWord: 4 },
      { speaker: "B", startWord: 5, endWord: 9 },
    ];
    const out = renameSpeakerInRuns(runs, "A", "A");
    expect(out).toEqual(runs);
  });

  it("round-trips through serialise, coalescing the renamed turns", () => {
    const { words, runs, lineEndWords, linePrefixes, preamble } = parseWords(FIXTURE);
    // Rename Speaker 3 to Speaker 4. The second Speaker 3 run (index 4) is
    // immediately followed by Speaker 4 (index 5), so they merge.
    const out = renameSpeakerInRuns(runs, "Speaker 3", "Speaker 4");
    const body = serializeWords(words, out, lineEndWords, linePrefixes, preamble);
    expect(body).not.toContain("<!-- speaker: Speaker 3 -->");
    // The previously separate Speaker 3 / Speaker 4 turns are now one run; the
    // word that opened the old Speaker 4 turn keeps its token.
    expect(body).toContain("{{t:44.21}}The");
  });
});

describe("namedSpeakersInOrder", () => {
  it("excludes Speaker N clusters and special tokens, in appearance order", () => {
    const runs: SpeakerRun[] = [
      { speaker: "Speaker 2", startWord: 0, endWord: 1 },
      { speaker: "Ed", startWord: 2, endWord: 3 },
      { speaker: "[irrelevant]", startWord: 4, endWord: 5 },
      { speaker: "Marjorie", startWord: 6, endWord: 7 },
      { speaker: "[narrator]", startWord: 8, endWord: 9 },
      { speaker: "Ed", startWord: 10, endWord: 11 },
      { speaker: "Speaker 10", startWord: 12, endWord: 13 },
    ];
    // Ed before Marjorie (first appearance), each only once; Speaker N and the
    // special tokens dropped.
    expect(namedSpeakersInOrder(runs)).toEqual(["Ed", "Marjorie"]);
  });

  it("returns an empty list when only defaults and specials are present", () => {
    const runs: SpeakerRun[] = [
      { speaker: "Speaker 1", startWord: 0, endWord: 1 },
      { speaker: "[external footage]", startWord: 2, endWord: 3 },
      { speaker: "[group]", startWord: 4, endWord: 5 },
    ];
    expect(namedSpeakersInOrder(runs)).toEqual([]);
  });
});
