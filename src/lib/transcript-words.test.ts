import { describe, it, expect } from "vitest";
import {
  hasWordTimestamps,
  parseWords,
  serializeWords,
  reassignSpeaker,
  renameSpeakerInRuns,
  namedSpeakersInOrder,
  wordsInTimeRange,
  wordActiveAt,
  nextRelevantWordStartAfter,
  speakerWordCounts,
  splitWord,
  replaceWordRange,
  eventNoteAnchorIndex,
  type SpeakerRun,
  type Word,
} from "./transcript-words";

describe("splitWord", () => {
  const body = "<!-- speaker: A -->\n{{t:10.00}}right? {{t:10.80}}that {{t:11.00}}seems";
  it("splits a word into separately-timestamped words in the gap", () => {
    const p = parseWords(body);
    const sp = splitWord(p, 0, ["right?", "yes"]);
    expect(sp.words.map((w) => w.text)).toEqual(["right?", "yes", "that", "seems"]);
    expect(sp.words[0].start).toBe(10.0); // first piece keeps its time
    expect(sp.words[1].start).toBeCloseTo(10.4, 5); // midpoint to next (10.8)
    expect(sp.runs).toEqual([{ speaker: "A", startWord: 0, endWord: 3 }]);
  });
  it("a single piece just replaces the text, no insert", () => {
    const sp = splitWord(parseWords(body), 0, ["Right?"]);
    expect(sp.words.map((w) => w.text)).toEqual(["Right?", "that", "seems"]);
  });
  it("round-trips a split through serialise then parse", () => {
    const p = parseWords(body);
    const sp = splitWord(p, 0, ["right?", "yes"]);
    const out = serializeWords(sp.words, sp.runs, sp.lineEndWords, sp.preamble);
    const re = parseWords(out);
    expect(re.words.map((w) => w.text)).toEqual(["right?", "yes", "that", "seems"]);
    expect(re.words[1].start).toBeCloseTo(10.4, 1);
  });
});

const W: Word[] = [
  { text: "a", start: 1.0, gIndex: 0 },
  { text: "b", start: 1.5, gIndex: 1 },
  { text: "c", start: 2.0, gIndex: 2 },
  { text: "d", start: 3.0, gIndex: 3 },
];

describe("replaceWordRange (multi-word selection editor splice)", () => {
  const body = "<!-- speaker: A -->\n{{t:1.00}}one {{t:2.00}}two {{t:3.00}}three {{t:4.00}}four";

  it("replaces a sub-range, growing the run and re-timing", () => {
    const p = parseWords(body);
    const next = replaceWordRange(p, 1, 2, [
      { text: "TWO", start: 2.0 },
      { text: "X", start: 2.5 },
      { text: "THREE", start: 3.0 },
    ]);
    expect(next.words.map((w) => w.text)).toEqual(["one", "TWO", "X", "THREE", "four"]);
    expect(next.words.map((w) => w.gIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(next.runs).toEqual([{ speaker: "A", startWord: 0, endWord: 4 }]);
  });

  it("deletes a range (empty replacement) and shrinks the run", () => {
    const p = parseWords(body);
    const next = replaceWordRange(p, 1, 2, []);
    expect(next.words.map((w) => w.text)).toEqual(["one", "four"]);
    expect(next.runs).toEqual([{ speaker: "A", startWord: 0, endWord: 1 }]);
  });

  it("round-trips through serialise (edited text + new timestamp present)", () => {
    const p = parseWords(body);
    const next = replaceWordRange(p, 1, 1, [
      { text: "TWO", start: 2.0 },
      { text: "and-a-half", start: 2.5 },
    ]);
    const out = serializeWords(next.words, next.runs, next.lineEndWords, next.preamble);
    expect(out).toContain("{{t:2.00}}TWO");
    expect(out).toContain("{{t:2.50}}and-a-half");
    expect(parseWords(out).words.map((w) => w.text)).toEqual([
      "one",
      "TWO",
      "and-a-half",
      "three",
      "four",
    ]);
  });
});

describe("speakerWordCounts", () => {
  it("counts words per speaker in first-appearance order, including specials", () => {
    const p = parseWords(
      "<!-- speaker: Speaker 1 -->\n{{t:0}}a {{t:1}}b {{t:2}}c\n" +
        "<!-- speaker: [irrelevant] -->\n{{t:3}}x {{t:4}}y\n" +
        "<!-- speaker: Speaker 1 -->\n{{t:5}}d",
    );
    expect(speakerWordCounts(p.runs)).toEqual([
      { id: "Speaker 1", total: 4 },
      { id: "[irrelevant]", total: 2 },
    ]);
  });
  it("is empty for no runs", () => {
    expect(speakerWordCounts([])).toEqual([]);
  });
});

describe("nextRelevantWordStartAfter (per-word skip-irrelevant)", () => {
  const body =
    "<!-- speaker: Speaker 1 -->\n{{t:0.00}}relevant {{t:1.00}}one\n" +
    "<!-- speaker: [irrelevant] -->\n{{t:2.00}}skip {{t:3.00}}this\n" +
    "<!-- speaker: Speaker 1 -->\n{{t:4.00}}relevant {{t:5.00}}two";
  const irr = (s: string) => s === "[irrelevant]";

  it("seeks to the next relevant word when the playhead is in an irrelevant run", () => {
    const p = parseWords(body);
    expect(nextRelevantWordStartAfter(p.words, p.runs, 2.5, irr)).toBe(4.0);
    expect(nextRelevantWordStartAfter(p.words, p.runs, 3.5, irr)).toBe(4.0);
  });

  it("returns null when the playhead is on relevant content", () => {
    const p = parseWords(body);
    expect(nextRelevantWordStartAfter(p.words, p.runs, 0.5, irr)).toBeNull();
    expect(nextRelevantWordStartAfter(p.words, p.runs, 4.5, irr)).toBeNull();
  });

  it("returns null before the first word and when nothing relevant follows", () => {
    const p = parseWords(body);
    expect(nextRelevantWordStartAfter(p.words, p.runs, -1, irr)).toBeNull();
    // an all-irrelevant tail: playhead in it, no relevant word after -> null
    const tail = parseWords(
      "<!-- speaker: Speaker 1 -->\n{{t:0.00}}hi\n<!-- speaker: [irrelevant] -->\n{{t:1.00}}bye",
    );
    expect(nextRelevantWordStartAfter(tail.words, tail.runs, 1.5, irr)).toBeNull();
  });
});

describe("wordsInTimeRange", () => {
  it("returns words whose start is in (from, to]", () => {
    expect(wordsInTimeRange(W, 1.0, 2.0)).toEqual([1, 2]);
  });
  it("excludes the lower bound, includes the upper", () => {
    expect(wordsInTimeRange(W, 0, 1.0)).toEqual([0]);
  });
  it("is empty when the clock did not advance", () => {
    expect(wordsInTimeRange(W, 2.0, 2.0)).toEqual([]);
  });
});

describe("wordActiveAt", () => {
  it("is -1 before the first word", () => {
    expect(wordActiveAt(W, 0.5)).toBe(-1);
  });
  it("includes a word at exactly its start (the seek-landing boundary)", () => {
    expect(wordActiveAt(W, 1.0)).toBe(0);
    expect(wordActiveAt(W, 2.0)).toBe(2);
  });
  it("returns the word the playhead sits within", () => {
    expect(wordActiveAt(W, 1.7)).toBe(1);
    expect(wordActiveAt(W, 2.9)).toBe(2);
  });
  it("clamps to the last word past the end, and is -1 for no words", () => {
    expect(wordActiveAt(W, 99)).toBe(3);
    expect(wordActiveAt([], 1.0)).toBe(-1);
  });
});

describe("multi-word units (a space inside one timestamped unit)", () => {
  it("captures text up to the next marker, spaces kept", () => {
    const p = parseWords("<!-- speaker: A -->\n{{t:1.00}}Hey there {{t:1.50}}friend");
    expect(p.words.map((w) => w.text)).toEqual(["Hey there", "friend"]);
    expect(p.words.map((w) => w.start)).toEqual([1.0, 1.5]);
  });
  it("round-trips a multi-word unit byte-for-byte", () => {
    const body = "<!-- speaker: A -->\n{{t:1.00}}Hey there {{t:1.50}}friend\n";
    const p = parseWords(body);
    expect(serializeWords(p.words, p.runs, p.lineEndWords, p.preamble)).toBe(body);
  });
  it("tolerates a legacy HH:MM:SS.D line-start prefix and drops it on serialise", () => {
    // Not-yet-stripped record/2 files may still carry the redundant prefix; the
    // prefix sits before the first {{t:}}, so WORD_TOKEN ignores it on read, and
    // serialise emits the prefix-free form.
    const p = parseWords("<!-- speaker: A -->\n00:00:01.0 {{t:1.00}}Hey {{t:1.50}}there");
    expect(p.words.map((w) => w.text)).toEqual(["Hey", "there"]);
    expect(serializeWords(p.words, p.runs, p.lineEndWords, p.preamble)).toBe(
      "<!-- speaker: A -->\n{{t:1.00}}Hey {{t:1.50}}there\n",
    );
  });
});

// A real multi-speaker chunk lifted verbatim from a v2 (per-word-timestamp)
// record: store/079bb44a...v2.md, body lines 47-72. Five speakers, with
// Speaker 1 and Speaker 3 recurring, and a mix of multi-line and single-line
// runs. Stored as a line array joined with "\n" plus a trailing newline so the
// exact byte layout is unambiguous.
const FIXTURE_LINES = [
  "<!-- speaker: Speaker 1 -->",
  "{{t:0.13}}We {{t:0.45}}are {{t:0.81}}on {{t:0.87}}our {{t:0.97}}way {{t:1.17}}to {{t:2.05}}Homestead.",
  "{{t:3.15}}The {{t:3.27}}main {{t:3.85}}idea {{t:4.31}}is {{t:4.41}}that {{t:4.65}}we {{t:4.79}}get {{t:4.99}}to {{t:5.13}}spend {{t:5.45}}several {{t:5.77}}hours {{t:6.25}}inside {{t:7.36}}Coral {{t:7.59}}Castle {{t:8.34}}and {{t:8.70}}document {{t:9.15}}it {{t:9.29}}and {{t:9.50}}film {{t:10.14}}it {{t:10.28}}for {{t:10.38}}the {{t:10.50}}first {{t:10.72}}time {{t:10.98}}in, {{t:11.56}}you {{t:11.66}}know, {{t:12.40}}who {{t:12.52}}knows {{t:12.70}}how {{t:12.84}}long.",
  "",
  "<!-- speaker: Speaker 2 -->",
  "{{t:13.02}}He {{t:13.12}}was {{t:13.28}}brought {{t:13.52}}into {{t:13.74}}a {{t:13.82}}mystery {{t:14.16}}school {{t:14.94}}and {{t:15.08}}in {{t:15.18}}some {{t:15.40}}way {{t:15.54}}he {{t:15.64}}was {{t:15.80}}able {{t:15.96}}to {{t:16.06}}convey {{t:16.62}}the {{t:16.84}}mysteries {{t:17.22}}of {{t:17.32}}the {{t:17.58}}ancients {{t:18.06}}and {{t:18.30}}hide {{t:18.70}}mysteries {{t:19.32}}into {{t:19.62}}this {{t:19.78}}stone {{t:20.12}}construction.",
  "{{t:21.02}}They {{t:21.20}}look {{t:21.46}}down, {{t:21.82}}what {{t:22.00}}is {{t:22.20}}it {{t:22.36}}sitting {{t:22.70}}on?",
  "",
  "<!-- speaker: Speaker 3 -->",
  "{{t:22.90}}And {{t:23.00}}they {{t:23.18}}find {{t:23.46}}it's {{t:23.56}}a {{t:23.66}}piece {{t:23.90}}of {{t:24.00}}rock.",
  "{{t:24.66}}They {{t:24.86}}send {{t:25.06}}it {{t:25.14}}to {{t:25.34}}the {{t:25.46}}geology {{t:26.12}}department {{t:26.84}}and {{t:26.94}}they {{t:27.12}}say, {{t:27.70}}material {{t:28.20}}not {{t:28.45}}of {{t:28.55}}this {{t:28.79}}old.",
  "{{t:29.97}}It {{t:30.11}}comes {{t:30.59}}from {{t:31.79}}where?",
  "{{t:33.03}}Outer {{t:33.23}}space?",
  "",
  "<!-- speaker: Speaker 1 -->",
  "{{t:34.05}}Two {{t:34.25}}teenage {{t:34.67}}witnesses {{t:35.17}}were {{t:35.35}}said {{t:35.55}}to {{t:35.67}}have {{t:35.81}}seen {{t:36.11}}Ed {{t:36.29}}levitating {{t:36.83}}the {{t:36.95}}giant {{t:37.27}}stones {{t:38.19}}like {{t:38.37}}balloons.",
  "{{t:39.31}}There {{t:39.93}}is {{t:40.11}}a {{t:41.01}}black {{t:41.35}}bomb.",
  "",
  "<!-- speaker: Speaker 3 -->",
  "{{t:42.39}}They {{t:42.59}}find {{t:43.15}}a {{t:43.27}}black {{t:43.63}}bomb.",
  "",
  "<!-- speaker: Speaker 4 -->",
  "{{t:44.21}}The {{t:44.43}}gears {{t:45.27}}that {{t:45.49}}he {{t:45.57}}had {{t:45.81}}inside, {{t:46.53}}it {{t:46.65}}was {{t:46.85}}a {{t:47.01}}pump.",
  "",
  "<!-- speaker: Speaker 5 -->",
  "{{t:47.88}}and {{t:47.96}}the {{t:48.10}}holes {{t:48.36}}on {{t:48.48}}that {{t:48.80}}one {{t:49.36}}point {{t:49.76}}at {{t:49.88}}the {{t:50.00}}top {{t:50.34}}of {{t:50.48}}the {{t:50.72}}gateway {{t:51.18}}over {{t:51.42}}here {{t:51.74}}where {{t:51.88}}there's {{t:52.04}}a {{t:52.12}}metal.",
];
const FIXTURE = FIXTURE_LINES.join("\n") + "\n";

// A body with a preamble (title + published line, exactly as v2 files carry it)
// before the first speaker comment, to exercise preamble preservation on
// round-trip. Word lines are prefix-free (record/2): each line's first {{t:}}
// carries the line start.
const PREAMBLE_LINES = [
  "",
  "# PWTS PROJECT: STARGATE - What Happened to the Psychic Spies? (Trailer)",
  "",
  "*Published 2023-07-28*",
  "",
  "<!-- speaker: Speaker 1 -->",
  "{{t:422.50}}I {{t:422.58}}think {{t:422.76}}it's {{t:422.92}}great.",
  "{{t:0.13}}We {{t:0.45}}are.",
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
    const { words, runs, lineEndWords, preamble } = parseWords(FIXTURE);
    expect(serializeWords(words, runs, lineEndWords, preamble)).toBe(FIXTURE);
  });

  it("round-trips a body with a preamble byte-for-byte", () => {
    const { words, runs, lineEndWords, preamble } = parseWords(PREAMBLE_FIXTURE);
    expect(serializeWords(words, runs, lineEndWords, preamble)).toBe(PREAMBLE_FIXTURE);
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

  it("reproduces line breaks from lineEndWords", () => {
    // Same three words, split after the first vs not split.
    const words = [
      { text: "a", start: 1.0, gIndex: 0 },
      { text: "b", start: 2.0, gIndex: 1 },
      { text: "c", start: 3.0, gIndex: 2 },
    ];
    const runs: SpeakerRun[] = [{ speaker: "X", startWord: 0, endWord: 2 }];
    const oneLine = serializeWords(words, runs, new Set([2]));
    expect(oneLine).toBe("<!-- speaker: X -->\n{{t:1.00}}a {{t:2.00}}b {{t:3.00}}c\n");
    const twoLines = serializeWords(words, runs, new Set([0, 2]));
    expect(twoLines).toBe("<!-- speaker: X -->\n{{t:1.00}}a\n{{t:2.00}}b {{t:3.00}}c\n");
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
    const { words, runs, lineEndWords, preamble } = parseWords(FIXTURE);
    // Reassign the whole second run (Speaker 2) to Speaker 1. Speaker 1
    // precedes it, so the runs merge across the (now removed) boundary.
    const sp2 = runs[1];
    const updated = reassignSpeaker(runs, sp2.startWord, sp2.endWord, "Speaker 1");
    expect(updated[0]).toEqual({
      speaker: "Speaker 1",
      startWord: 0,
      endWord: sp2.endWord,
    });
    const body = serializeWords(words, updated, lineEndWords, preamble);
    // The Speaker 2 comment is gone; the merged run keeps both speakers' lines.
    expect(body).not.toContain("<!-- speaker: Speaker 2 -->");
    expect(body).toContain("{{t:13.02}}He");
  });

  it("keeps the preamble after a mid-line reassign", () => {
    const { words, runs, lineEndWords, preamble } = parseWords(PREAMBLE_FIXTURE);
    // Reassign one word in the middle of the first line to a new speaker. This
    // splits the line into prefix-free sub-lines around the new speaker run.
    const updated = reassignSpeaker(runs, 1, 1, "Speaker 2");
    const body = serializeWords(words, updated, lineEndWords, preamble);
    // Preamble survived in full.
    expect(body).toContain("# PWTS PROJECT: STARGATE");
    expect(body).toContain("*Published 2023-07-28*");
    // The first word and the reassigned word both keep their {{t:}} tokens.
    expect(body).toContain("{{t:422.50}}I");
    expect(body).toContain("{{t:422.58}}think");
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
    const { words, runs, lineEndWords, preamble } = parseWords(FIXTURE);
    // Rename Speaker 3 to Speaker 4. The second Speaker 3 run (index 4) is
    // immediately followed by Speaker 4 (index 5), so they merge.
    const out = renameSpeakerInRuns(runs, "Speaker 3", "Speaker 4");
    const body = serializeWords(words, out, lineEndWords, preamble);
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

describe("eventNoteAnchorIndex", () => {
  const words = [
    { text: "one", start: 1.0, gIndex: 0 },
    { text: "two", start: 2.0, gIndex: 1 },
    { text: "three", start: 3.0, gIndex: 2 },
  ];
  it("anchors after the last word starting at or before the time", () => {
    expect(eventNoteAnchorIndex(words, 2.5)).toBe(1); // after "two"
    expect(eventNoteAnchorIndex(words, 2.0)).toBe(1); // ties anchor to that word
    expect(eventNoteAnchorIndex(words, 9.0)).toBe(2); // after the last word
  });
  it("returns -1 to prepend before the first word", () => {
    expect(eventNoteAnchorIndex(words, 0.5)).toBe(-1);
  });
});
