import { describe, it, expect } from "vitest";
import {
  parseTranscript,
  serializeTranscript,
  SPEAKER_IRRELEVANT,
  isSegmentIrrelevant,
} from "./transcript";
import {
  parseWords,
  serializeWords,
  reassignSpeaker,
  renameSpeakerInRuns,
  namedSpeakersInOrder,
  eventNoteAnchorIndex,
} from "./transcript-words";
import yaml from "js-yaml";
import { rewriteFrontmatterFields } from "./document.svelte";

// We can't test the Svelte $state-based DocumentStore directly in Vitest
// (it needs the Svelte runtime). Instead we test the parse-modify-serialize
// pipeline that underlies all document operations.

function roundTrip(
  body: string,
  modify: (segs: ReturnType<typeof parseTranscript>) => void,
): string {
  const segs = parseTranscript(body);
  modify(segs);
  return serializeTranscript(segs);
}

describe("renameSpeaker works with new inline comment format", () => {
  // This tests the same parse-modify-serialize path that
  // DocumentStore.renameSpeaker now uses.
  const newFormatBody = `<!-- speaker: Speaker 1 -->
00:00:01.8 Hello.
<!-- speaker: Speaker 2 -->
00:00:05.0 World.
<!-- speaker: Speaker 1 -->
00:00:10.0 Goodbye.`;

  it("renames speaker in new inline comment format", () => {
    const result = roundTrip(newFormatBody, (segs) => {
      for (const seg of segs) {
        if (seg.speaker === "Speaker 1") seg.speaker = "Lex Fridman";
      }
    });
    expect(result).toContain("speaker: Lex Fridman");
    expect(result).not.toContain("Speaker 1");
  });

  it("merges speakers in new inline comment format", () => {
    const result = roundTrip(newFormatBody, (segs) => {
      for (const seg of segs) {
        if (seg.speaker === "Speaker 2") seg.speaker = "Speaker 1";
      }
    });
    const reparsed = parseTranscript(result);
    const speakers = [...new Set(reparsed.map((s) => s.speaker))];
    expect(speakers).toEqual(["Speaker 1"]);
  });
});

describe("renamed speaker can be found by new name", () => {
  const body = `
<!-- speaker: Speaker 1 -->
00:00:01.8 Hello.
<!-- speaker: Speaker 2 -->
00:00:05.0 World.
`;

  it("filtering by new name after rename returns segments", () => {
    const segs = parseTranscript(body);
    for (const seg of segs) {
      if (seg.speaker === "Speaker 1") seg.speaker = "Lex Fridman";
    }
    const result = serializeTranscript(segs);
    const reparsed = parseTranscript(result);
    const filtered = reparsed.filter((s) => s.speaker === "Lex Fridman");
    expect(filtered.length).toBe(1);
    expect(filtered[0].lines).toEqual(["Hello."]);
  });

  it("filtering by old name after rename returns nothing", () => {
    const segs = parseTranscript(body);
    for (const seg of segs) {
      if (seg.speaker === "Speaker 1") seg.speaker = "Lex Fridman";
    }
    const result = serializeTranscript(segs);
    const reparsed = parseTranscript(result);
    const filtered = reparsed.filter((s) => s.speaker === "Speaker 1");
    expect(filtered.length).toBe(0);
  });
});

describe("speaker rename via parse-modify-serialize", () => {
  const body = `
<!-- speaker: Speaker 1 -->
00:00:01.8 Hello world.
00:00:05.0 How are you.

<!-- speaker: Speaker 2 -->
00:00:10.0 I'm fine.

<!-- speaker: Speaker 1 -->
00:00:15.0 Good to hear.
`;

  it("renames all occurrences of a speaker", () => {
    const result = roundTrip(body, (segs) => {
      for (const seg of segs) {
        if (seg.speaker === "Speaker 1") seg.speaker = "Lex Fridman";
      }
    });
    expect(result).toContain("<!-- speaker: Lex Fridman -->");
    expect(result).not.toContain("Speaker 1");
    expect(result).toContain("<!-- speaker: Speaker 2 -->");
  });

  it("preserves timestamps after rename", () => {
    const result = roundTrip(body, (segs) => {
      for (const seg of segs) {
        if (seg.speaker === "Speaker 1") seg.speaker = "Lex Fridman";
      }
    });
    expect(result).toContain("00:00:01.8 Hello world.");
    expect(result).toContain("00:00:15.0 Good to hear.");
  });

  it("preserves other speakers after rename", () => {
    const result = roundTrip(body, (segs) => {
      for (const seg of segs) {
        if (seg.speaker === "Speaker 1") seg.speaker = "Lex Fridman";
      }
    });
    const reparsed = parseTranscript(result);
    const speakers = [...new Set(reparsed.map((s) => s.speaker))];
    expect(speakers.sort()).toEqual(["Lex Fridman", "Speaker 2"]);
  });

  it("round-trips correctly after rename", () => {
    const segs = parseTranscript(body);
    for (const seg of segs) {
      if (seg.speaker === "Speaker 1") seg.speaker = "David Fravor";
    }
    const serialised = serializeTranscript(segs);
    const reparsed = parseTranscript(serialised);

    expect(reparsed.length).toBe(segs.length);
    for (let i = 0; i < segs.length; i++) {
      expect(reparsed[i].speaker).toBe(segs[i].speaker);
      expect(reparsed[i].time).toBe(segs[i].time);
      expect(reparsed[i].lines).toEqual(segs[i].lines);
    }
  });
});

describe("mark irrelevant via speaker name", () => {
  const body = `
<!-- speaker: Speaker 1 -->
00:00:01.8 First line.
00:00:05.0 Second line.
00:00:10.0 Third line.
`;

  it("marks a segment as irrelevant by changing speaker to [irrelevant]", () => {
    const result = roundTrip(body, (segs) => {
      segs[0].speaker = SPEAKER_IRRELEVANT;
    });
    expect(result).toContain("<!-- speaker: [irrelevant] -->");
    const reparsed = parseTranscript(result);
    expect(isSegmentIrrelevant(reparsed[0])).toBe(true);
    expect(isSegmentIrrelevant(reparsed[1])).toBe(false);
    expect(isSegmentIrrelevant(reparsed[2])).toBe(false);
  });

  it("unmarks a segment by restoring speaker name", () => {
    const bodyWithIrrelevant = `
<!-- speaker: [irrelevant] -->
00:00:01.8 Was irrelevant.

<!-- speaker: Speaker 1 -->
00:00:05.0 Was relevant.
`;
    const result = roundTrip(bodyWithIrrelevant, (segs) => {
      segs[0].speaker = "Speaker 1";
    });
    expect(result).not.toContain("[irrelevant]");
    const reparsed = parseTranscript(result);
    expect(isSegmentIrrelevant(reparsed[0])).toBe(false);
  });

  it("preserves text content when changing speaker to irrelevant", () => {
    const result = roundTrip(body, (segs) => {
      segs[1].speaker = SPEAKER_IRRELEVANT;
    });
    const reparsed = parseTranscript(result);
    expect(reparsed[0].lines).toEqual(["First line."]);
    expect(reparsed[1].lines).toEqual(["Second line."]);
    expect(reparsed[2].lines).toEqual(["Third line."]);
  });
});

describe("merge segments via parse-modify-serialize", () => {
  const body = `
<!-- speaker: Speaker 1 -->
00:00:01.8 Line A.

<!-- speaker: Speaker 2 -->
00:00:05.0 Line B.

<!-- speaker: Speaker 1 -->
00:00:10.0 Line C.
`;

  it("merges segment up (text joins previous speaker)", () => {
    const result = roundTrip(body, (segs) => {
      // Merge index 1 (Speaker 2) into index 0 (Speaker 1)
      segs[0].lines.push(...segs[1].lines);
      segs.splice(1, 1);
    });
    const reparsed = parseTranscript(result);
    // In the new format, each timestamped line is its own segment.
    // Merging moves "Line B" under Speaker 1 but it keeps its own timestamp.
    // So we still get 3 parsed segments, but Speaker 2 is gone.
    const speakers = [...new Set(reparsed.map((s) => s.speaker))];
    expect(speakers).toEqual(["Speaker 1"]);
    const allText = reparsed.flatMap((s) => s.lines);
    expect(allText).toContain("Line A.");
    expect(allText).toContain("Line B.");
    expect(allText).toContain("Line C.");
  });

  it("merges segment down (text joins next speaker)", () => {
    const result = roundTrip(body, (segs) => {
      // Merge index 1 (Speaker 2) into index 2 (Speaker 1)
      segs[2].lines = [...segs[1].lines, ...segs[2].lines];
      segs.splice(1, 1);
    });
    const reparsed = parseTranscript(result);
    // Speaker 2 is gone, all text is under Speaker 1
    const speakers = [...new Set(reparsed.map((s) => s.speaker))];
    expect(speakers).toEqual(["Speaker 1"]);
    const allText = reparsed.flatMap((s) => s.lines);
    expect(allText).toContain("Line B.");
    expect(allText).toContain("Line C.");
  });
});

describe("split segment via parse-modify-serialize", () => {
  const body = `
<!-- speaker: Speaker 1 -->
00:00:01.8 First sentence. Second sentence. Third sentence.
`;

  it("splits a segment at a character position", () => {
    const segs = parseTranscript(body);
    const fullText = segs[0].lines.join("\n");
    const splitPos = fullText.indexOf("Second");

    const before = fullText.slice(0, splitPos).trim();
    const after = fullText.slice(splitPos).trim();

    segs.splice(
      0,
      1,
      { ...segs[0], lines: [before] },
      { ...segs[0], speaker: "Speaker 2", time: "00:00:05.0", lines: [after], index: 1 },
    );

    const result = serializeTranscript(segs);
    const reparsed = parseTranscript(result);

    expect(reparsed.length).toBe(2);
    expect(reparsed[0].speaker).toBe("Speaker 1");
    expect(reparsed[0].lines[0]).toContain("First sentence.");
    expect(reparsed[1].speaker).toBe("Speaker 2");
    expect(reparsed[1].lines[0]).toContain("Second sentence.");
  });
});

describe("change speaker on single segment", () => {
  const body = `
<!-- speaker: Speaker 1 -->
00:00:01.8 Hello.

<!-- speaker: Speaker 2 -->
00:00:05.0 World.

<!-- speaker: Speaker 1 -->
00:00:10.0 Goodbye.
`;

  it("changes only the targeted segment's speaker", () => {
    const result = roundTrip(body, (segs) => {
      // Change the second segment (Speaker 2) to Speaker 3
      const idx = segs.findIndex((s) => s.speaker === "Speaker 2" && s.time === "00:00:05.0");
      segs[idx].speaker = "Speaker 3";
    });
    const reparsed = parseTranscript(result);
    expect(reparsed[0].speaker).toBe("Speaker 1");
    expect(reparsed[1].speaker).toBe("Speaker 3");
    expect(reparsed[2].speaker).toBe("Speaker 1");
  });
});

describe("change timestamp on single segment", () => {
  const body = `
<!-- speaker: Speaker 1 -->
00:00:01.8 Hello.
00:00:05.0 World.
`;

  it("updates the segment's timestamp", () => {
    const result = roundTrip(body, (segs) => {
      segs[1].time = "00:00:06.2";
    });
    const reparsed = parseTranscript(result);
    expect(reparsed[1].time).toBe("00:00:06.2");
    expect(reparsed[1].lines).toEqual(["World."]);
  });
});

describe("editing a segment that shares (speaker, time) with another", () => {
  // Two segments with the SAME speaker and SAME timestamp - as happens for
  // the two halves immediately after a split. Identifying by (speaker, time)
  // would hit the first; identifying by index hits the intended one.
  const body = `
<!-- speaker: Speaker 1 -->
00:00:03.0 First half.
00:00:03.0 Second half.
`;

  it("a (speaker, time) lookup is ambiguous - it finds the first", () => {
    const segs = parseTranscript(body);
    const bySpeakerTime = segs.findIndex(
      (s) => s.speaker === "Speaker 1" && s.time === "00:00:03.0",
    );
    expect(bySpeakerTime).toBe(0); // wrong segment when we meant the second
  });

  it("editing by index targets the intended segment, not the first", () => {
    const segs = parseTranscript(body);
    const target = segs.find((s) => s.index === 1)!; // the second half
    target.time = "00:00:04.5";
    target.lines = ["Second half, retimed."];
    const reparsed = parseTranscript(serializeTranscript(segs));
    expect(reparsed[0].time).toBe("00:00:03.0");
    expect(reparsed[0].lines).toEqual(["First half."]);
    expect(reparsed[1].time).toBe("00:00:04.5");
    expect(reparsed[1].lines).toEqual(["Second half, retimed."]);
  });
});

describe("splitSegmentMulti replaces one segment with N ordered pieces", () => {
  // Mirrors DocumentStore.splitSegmentMulti: splice the target segment out and
  // splice N pieces (placeholder seconds/index) in its place, then serialize +
  // reparse, which recomputes seconds from each time and indices from order.
  const body = `
<!-- speaker: Speaker 1 -->
00:00:10.0 One two three four five six.
<!-- speaker: Speaker 2 -->
00:00:30.0 Later line.
`;

  function applyMulti(
    segs: ReturnType<typeof parseTranscript>,
    targetIndex: number,
    pieces: { speaker: string; time: string; text: string }[],
  ) {
    const newSegs = pieces
      .map((p) => ({
        speaker: p.speaker,
        time: p.time,
        seconds: 0,
        lines: p.text.split("\n").filter((l) => l.trim()),
        index: 0,
      }))
      .filter((s) => s.lines.length > 0);
    segs.splice(targetIndex, 1, ...newSegs);
  }

  it("produces three consecutive pieces with their own speakers and times", () => {
    const segs = parseTranscript(body);
    applyMulti(segs, 0, [
      { speaker: "Speaker 1", time: "00:00:10.0", text: "One two" },
      { speaker: "Luigi", time: "00:00:16.7", text: "three four" },
      { speaker: "Speaker 1", time: "00:00:23.3", text: "five six." },
    ]);
    const reparsed = parseTranscript(serializeTranscript(segs));

    expect(reparsed.map((s) => s.speaker)).toEqual([
      "Speaker 1",
      "Luigi",
      "Speaker 1",
      "Speaker 2",
    ]);
    expect(reparsed.map((s) => s.lines.join(" "))).toEqual([
      "One two",
      "three four",
      "five six.",
      "Later line.",
    ]);
    expect(reparsed.map((s) => s.time)).toEqual([
      "00:00:10.0",
      "00:00:16.7",
      "00:00:23.3",
      "00:00:30.0",
    ]);
    // seconds recomputed from the written time, indices made sequential
    expect(reparsed[1].seconds).toBeCloseTo(16.7, 5);
    expect(reparsed.map((s) => s.index)).toEqual([0, 1, 2, 3]);
  });

  it("keeps timestamps monotonic across the new pieces", () => {
    const segs = parseTranscript(body);
    applyMulti(segs, 0, [
      { speaker: "Speaker 1", time: "00:00:10.0", text: "One two" },
      { speaker: "Luigi", time: "00:00:16.7", text: "three four" },
      { speaker: "Speaker 1", time: "00:00:23.3", text: "five six." },
    ]);
    const reparsed = parseTranscript(serializeTranscript(segs));
    const seconds = reparsed.map((s) => s.seconds);
    for (let i = 1; i < seconds.length; i++) {
      expect(seconds[i]).toBeGreaterThan(seconds[i - 1]);
    }
  });
});

describe("reassignWords preserves frontmatter and preamble", () => {
  // Mirrors DocumentStore.reassignWords exactly: split off the YAML block,
  // parse the remaining body (preamble + transcript) into words/runs, reassign,
  // serialise, then concatenate fm + newBody. Guards the preamble-dropped
  // round-trip failure; record/2 word lines are prefix-free.
  const SPLIT_FM = /^(---\n[\s\S]*?\n---\n)([\s\S]*)$/;

  const doc =
    "---\n" +
    "schema: anomalica/record/2\n" +
    'title: "PWTS Example"\n' +
    "word_timestamps: true\n" +
    "---\n" +
    "\n" +
    "# PWTS Example\n" +
    "\n" +
    "*Published 2023-07-28*\n" +
    "\n" +
    "<!-- speaker: Speaker 1 -->\n" +
    "{{t:422.50}}I {{t:422.58}}think {{t:422.76}}it's {{t:422.92}}great.\n";

  function reassignWords(current: string, from: number, to: number, newSpeaker: string): string {
    const match = current.match(SPLIT_FM);
    const fm = match ? match[1] : "";
    const body = match ? match[2] : current;
    const { words, runs, lineEndWords, preamble } = parseWords(body);
    const newRuns = reassignSpeaker(runs, from, to, newSpeaker);
    return fm + serializeWords(words, newRuns, lineEndWords, preamble);
  }

  it("keeps the title and published line after a reassign", () => {
    const result = reassignWords(doc, 2, 3, "Speaker 2");
    expect(result).toContain("# PWTS Example");
    expect(result).toContain("*Published 2023-07-28*");
    expect(result).toContain('title: "PWTS Example"');
  });

  it("emits the line prefix-free after a whole-line reassign", () => {
    // record/2 word lines carry no HH:MM:SS.D prefix - the first {{t:}} is the
    // line start - so a reassigned line round-trips with its tokens and no prefix.
    const result = reassignWords(doc, 0, 3, "Speaker 2");
    expect(result).toContain("{{t:422.50}}I");
    expect(result).not.toContain("00:07:02");
  });

  it("round-trips identically when the reassign is a no-op", () => {
    // Reassigning the whole run to its own speaker yields the original doc.
    const result = reassignWords(doc, 0, 3, "Speaker 1");
    expect(result).toBe(doc);
  });
});

describe("renameWordSpeaker / reassignWords reconcile the frontmatter speakers list", () => {
  // Mirrors DocumentStore.serialiseWithReconcile + renameWordSpeaker /
  // reassignWords: split off the YAML block, parse the body, mutate the runs,
  // serialise the body AND rewrite the frontmatter `speakers:` to the named
  // speakers now present - both in one combined string (one undo step). The
  // frontmatter rewrite reuses the exact js-yaml options the store uses.
  const SPLIT_FM = /^(---\n[\s\S]*?\n---\n)([\s\S]*)$/;

  function rewriteFrontmatterSpeakers(rawFm: string, speakers: string[]): string {
    const fmContent = rawFm.replace(/^---\n/, "").replace(/---\n$/, "");
    const fmDoc = (yaml.load(fmContent) as Record<string, unknown>) ?? {};
    fmDoc.speakers = speakers.length > 0 ? speakers : undefined;
    const newFmContent = yaml.dump(fmDoc, {
      lineWidth: -1,
      quotingType: '"',
      forceQuotes: false,
      sortKeys: false,
    });
    return `---\n${newFmContent}---\n`;
  }

  function split(current: string): [string, string] {
    const match = current.match(SPLIT_FM);
    return match ? [match[1], match[2]] : ["", current];
  }

  function renameWordSpeaker(current: string, oldName: string, newName: string): string {
    if (!newName || oldName === newName) return current;
    const [fm, body] = split(current);
    const parsed = parseWords(body);
    const newRuns = renameSpeakerInRuns(parsed.runs, oldName, newName);
    const newBody = serializeWords(parsed.words, newRuns, parsed.lineEndWords, parsed.preamble);
    const currentNamed = fmSpeakers(current);
    const bodyNamed = namedSpeakersInOrder(newRuns);
    const kept = currentNamed.filter((n) => !/^Speaker \d+$/i.test(n));
    const merged = [...kept, ...bodyNamed.filter((n) => !kept.includes(n))];
    return rewriteFrontmatterSpeakers(fm, merged) + newBody;
  }

  function reassignWords(current: string, from: number, to: number, newSpeaker: string): string {
    const [fm, body] = split(current);
    const parsed = parseWords(body);
    const newRuns = reassignSpeaker(parsed.runs, from, to, newSpeaker);
    const newBody = serializeWords(parsed.words, newRuns, parsed.lineEndWords, parsed.preamble);
    const currentNamed = fmSpeakers(current);
    const bodyNamed = namedSpeakersInOrder(newRuns);
    const kept = currentNamed.filter((n) => !/^Speaker \d+$/i.test(n));
    const merged = [...kept, ...bodyNamed.filter((n) => !kept.includes(n))];
    return rewriteFrontmatterSpeakers(fm, merged) + newBody;
  }

  const doc =
    "---\n" +
    "schema: anomalica/record/2\n" +
    'title: "PWTS Example"\n' +
    "word_timestamps: true\n" +
    "speakers:\n" +
    '  - "Speaker 1"\n' +
    "---\n" +
    "\n" +
    "# PWTS Example\n" +
    "\n" +
    "*Published 2023-07-28*\n" +
    "\n" +
    "<!-- speaker: Speaker 1 -->\n" +
    "{{t:422.50}}I {{t:422.58}}think {{t:422.76}}it's {{t:422.92}}great.\n" +
    "\n" +
    "<!-- speaker: Speaker 2 -->\n" +
    "{{t:13.02}}He {{t:13.12}}was {{t:13.28}}brave.\n" +
    "\n" +
    "<!-- speaker: Speaker 1 -->\n" +
    "{{t:21.02}}They {{t:21.20}}agree.\n";

  function fmSpeakers(current: string): string[] {
    const [rawFm] = split(current);
    const fmContent = rawFm.replace(/^---\n/, "").replace(/---\n$/, "");
    const fmDoc = (yaml.load(fmContent) as Record<string, unknown>) ?? {};
    return (fmDoc.speakers as string[] | undefined) ?? [];
  }

  it("renameWordSpeaker preserves word times and preamble", () => {
    const result = renameWordSpeaker(doc, "Speaker 1", "Ed Leedskalnin");
    // Preamble untouched.
    expect(result).toContain("# PWTS Example");
    expect(result).toContain("*Published 2023-07-28*");
    // Every word token survives prefix-free; only the speaker comment changed.
    expect(result).toContain("{{t:422.50}}I {{t:422.58}}think {{t:422.76}}it's");
    expect(result).not.toContain("00:07:02");
    expect(result).toContain("{{t:21.02}}They {{t:21.20}}agree.");
    // Speaker comments renamed everywhere, other speaker untouched.
    expect(result).toContain("<!-- speaker: Ed Leedskalnin -->");
    expect(result).not.toContain("<!-- speaker: Speaker 1 -->");
    expect(result).toContain("<!-- speaker: Speaker 2 -->");
  });

  it("renameWordSpeaker reconciles the frontmatter to the named speakers in body order", () => {
    // Speaker 1 (a default) was wrongly listed; renaming it to a real name puts
    // exactly that name in the list, and Speaker 2 stays out (still a default).
    const result = renameWordSpeaker(doc, "Speaker 1", "Ed Leedskalnin");
    expect(fmSpeakers(result)).toEqual(["Ed Leedskalnin"]);
  });

  it("renaming to an existing name merges the turns and lists the name once", () => {
    // First give Speaker 2 a real name, then rename Speaker 1 to that same name:
    // the two should merge and appear once in the frontmatter.
    const step1 = renameWordSpeaker(doc, "Speaker 2", "Marjorie");
    expect(fmSpeakers(step1)).toEqual(["Marjorie"]);
    const step2 = renameWordSpeaker(step1, "Speaker 1", "Marjorie");
    // One speaker across the whole body now.
    const [, body] = split(step2);
    const comments = [...body.matchAll(/<!-- speaker: (.+?) -->/g)].map((m) => m[1]);
    expect(new Set(comments)).toEqual(new Set(["Marjorie"]));
    expect(fmSpeakers(step2)).toEqual(["Marjorie"]);
  });

  it("reassignWords adds a typed new name to the frontmatter", () => {
    // Word layout: "I think it's great." = 0-3, "He was brave." = 4-6,
    // "They agree." = 7-8. Assign the Speaker 2 turn (4-6) to a typed name.
    const result = reassignWords(doc, 4, 6, "Marjorie");
    expect(result).toContain("<!-- speaker: Marjorie -->");
    expect(fmSpeakers(result)).toEqual(["Marjorie"]);
  });

  it("keeps a named speaker after its last body occurrence is reassigned away (only the user removes named speakers)", () => {
    // Name Speaker 1 "Ed"; reassign Ed's only appearances (turns 0-3 and 7-8)
    // to a default, leaving Ed with no body occurrences.
    const named = renameWordSpeaker(doc, "Speaker 1", "Ed");
    expect(fmSpeakers(named)).toEqual(["Ed"]);
    const step1 = reassignWords(named, 0, 3, "Speaker 9");
    const step2 = reassignWords(step1, 7, 8, "Speaker 9");
    // Ed no longer appears in the body...
    expect(step2).not.toContain("<!-- speaker: Ed -->");
    // ...but is NOT auto-dropped from the frontmatter - the reviewer removes it.
    expect(fmSpeakers(step2)).toEqual(["Ed"]);
  });

  it("keeps the speakers key (with the named speaker) after its occurrences are reassigned away", () => {
    const named = renameWordSpeaker(doc, "Speaker 1", "Ed");
    const step1 = reassignWords(named, 0, 3, "Speaker 9");
    const step2 = reassignWords(step1, 7, 8, "Speaker 9");
    const [rawFm] = split(step2);
    expect(rawFm).toContain("speakers:");
    expect(rawFm).toContain("Ed");
    expect(rawFm).toContain("schema: anomalica/record/2");
    expect(rawFm).toContain("word_timestamps: true");
  });

  it("preserves a named speaker added to the frontmatter but not yet in the body", () => {
    // Mark's scenario: a reviewer adds a real name, then edits before assigning
    // it. The unassigned real name must survive; the stray default drops.
    const withUnassigned = doc.replace(
      '  - "Speaker 1"\n',
      '  - "Speaker 1"\n  - "Pending Guest"\n',
    );
    const result = reassignWords(withUnassigned, 4, 6, "Marjorie");
    expect(fmSpeakers(result)).toContain("Pending Guest");
    expect(fmSpeakers(result)).toContain("Marjorie");
    expect(fmSpeakers(result)).not.toContain("Speaker 1");
  });
});

describe("setWordTime clamps a word's start between its neighbours", () => {
  // Mirrors DocumentStore.setWordTime: split off the YAML block, parse the body,
  // clamp the requested start to [prevStart, nextStart], no-op within 5 ms, then
  // serialise. A word's timestamp must never cross its neighbours' (kept in order).
  const SPLIT_FM = /^(---\n[\s\S]*?\n---\n)([\s\S]*)$/;

  const doc =
    "---\n" +
    "schema: anomalica/record/2\n" +
    "word_timestamps: true\n" +
    "---\n" +
    "<!-- speaker: Speaker 1 -->\n" +
    "{{t:422.50}}I {{t:422.58}}think {{t:422.76}}it's {{t:422.92}}great.\n";

  function setWordTime(current: string, gIndex: number, start: number): string {
    const match = current.match(SPLIT_FM);
    const fm = match ? match[1] : "";
    const body = match ? match[2] : current;
    const parsed = parseWords(body);
    if (gIndex < 0 || gIndex >= parsed.words.length) return current;
    const prev = gIndex > 0 ? parsed.words[gIndex - 1].start : 0;
    const next = gIndex + 1 < parsed.words.length ? parsed.words[gIndex + 1].start : start + 1;
    const clamped = Math.max(prev, Math.min(next, start));
    if (Math.abs(clamped - parsed.words[gIndex].start) < 0.005) return current;
    parsed.words[gIndex] = { ...parsed.words[gIndex], start: clamped };
    return fm + serializeWords(parsed.words, parsed.runs, parsed.lineEndWords, parsed.preamble);
  }

  it("nudges a word later within its window", () => {
    const result = setWordTime(doc, 1, 422.68); // 'think', between 422.50 and 422.76
    expect(result).toContain("{{t:422.68}}think");
    expect(result).toContain("{{t:422.50}}I");
    expect(result).toContain("{{t:422.76}}it's");
  });

  it("clamps to the previous word's start, never crossing it", () => {
    const result = setWordTime(doc, 1, 400.0); // way before 'I' at 422.50
    expect(result).toContain("{{t:422.50}}think");
  });

  it("clamps to the next word's start, never crossing it", () => {
    const result = setWordTime(doc, 1, 999.0); // way past 'it's' at 422.76
    expect(result).toContain("{{t:422.76}}think");
  });

  it("is a no-op within 5 ms of the current start", () => {
    expect(setWordTime(doc, 1, 422.582)).toBe(doc);
  });

  it("lets the last word move past the end (no next neighbour caps it)", () => {
    const result = setWordTime(doc, 3, 500.0); // 'great.' is last
    expect(result).toContain("{{t:500.00}}great.");
  });
});

describe("updateFrontmatter writes creators/publisher, preserving other keys", () => {
  // Mirrors DocumentStore.updateFrontmatter -> rewriteFrontmatterFields: split
  // off the YAML block, set the given top-level keys via js-yaml ("" / [] drop
  // the key), trimming items, and leave every other key (incl. nested blocks)
  // intact. Reuses the exact js-yaml options the store uses.
  const SPLIT_FM = /^(---\n[\s\S]*?\n---\n)([\s\S]*)$/;

  function rewriteFrontmatterFields(
    rawFm: string,
    fields: Record<string, string | string[]>,
  ): string {
    const fmContent = rawFm.replace(/^---\n/, "").replace(/---\n$/, "");
    const fmDoc = (yaml.load(fmContent) as Record<string, unknown>) ?? {};
    for (const [key, value] of Object.entries(fields)) {
      if (Array.isArray(value)) {
        const items = value.map((v) => v.trim()).filter((v) => v !== "");
        fmDoc[key] = items.length > 0 ? items : undefined;
      } else {
        const trimmed = value.trim();
        fmDoc[key] = trimmed !== "" ? trimmed : undefined;
      }
    }
    const newFmContent = yaml.dump(fmDoc, {
      lineWidth: -1,
      quotingType: '"',
      forceQuotes: false,
      sortKeys: false,
    });
    return `---\n${newFmContent}---\n`;
  }

  function updateFrontmatter(current: string, fields: Record<string, string | string[]>): string {
    const match = current.match(SPLIT_FM);
    const fm = match ? match[1] : "";
    const body = match ? match[2] : current;
    return rewriteFrontmatterFields(fm, fields) + body;
  }

  const doc =
    "---\n" +
    "schema: anomalica/record/1\n" +
    "content_hash: abc123\n" +
    'title: "Rep. Burlison Welcomes Witness"\n' +
    "publisher: Representative Burlison\n" +
    "source_type: video\n" +
    "copyright:\n" +
    "  status: publicly_accessible\n" +
    "  holder: US House\n" +
    "---\n" +
    "Body line one.\n";

  function reparse(result: string): Record<string, unknown> {
    const fm = result
      .match(SPLIT_FM)![1]
      .replace(/^---\n/, "")
      .replace(/---\n$/, "");
    return yaml.load(fm) as Record<string, unknown>;
  }

  it("reclassifies a person from publisher into creators in one edit", () => {
    const result = updateFrontmatter(doc, {
      publisher: "",
      creators: ["Burlison, Eric"],
    });
    const fm = reparse(result);
    expect(fm.creators).toEqual(["Burlison, Eric"]);
    // Empty publisher drops the key.
    expect("publisher" in fm).toBe(false);
  });

  it("preserves content_hash, title and the nested copyright block", () => {
    const result = updateFrontmatter(doc, { creators: ["Doe, Jane"] });
    const fm = reparse(result);
    expect(fm.content_hash).toBe("abc123");
    expect(fm.title).toBe("Rep. Burlison Welcomes Witness");
    expect(fm.copyright).toEqual({ status: "publicly_accessible", holder: "US House" });
  });

  it("leaves the body untouched", () => {
    const result = updateFrontmatter(doc, { creators: ["Doe, Jane"] });
    expect(result.endsWith("Body line one.\n")).toBe(true);
  });

  it("trims items and drops empties", () => {
    const result = updateFrontmatter(doc, { creators: ["  Smith, Al  ", "", "   "] });
    expect(reparse(result).creators).toEqual(["Smith, Al"]);
  });

  it("dropping all creators removes the key", () => {
    const result = updateFrontmatter(doc, { creators: [] });
    expect("creators" in reparse(result)).toBe(false);
  });
});

describe("insertEventNote attaches a first-class note to a word (not a new word)", () => {
  // Mirrors DocumentStore.insertEventNote: anchor by time (min word 0), append
  // the token to that word's notes, serialise. The note is NOT a word.
  const FM = "---\nschema: anomalica/record/2\n---\n";
  const BODY =
    "<!-- speaker: Speaker 1 -->\n" + "{{t:1.00}}He {{t:2.00}}was {{t:3.00}}reputable.\n";
  const bodyOf = (out: string) => out.slice(out.indexOf("---\n", 4) + 4);

  function insertEventNote(current: string, at: number, text: string): string {
    const body = bodyOf(current);
    const parsed = parseWords(body);
    const anchor = Math.max(0, eventNoteAnchorIndex(parsed.words, at));
    const words = parsed.words.map((w, i) =>
      i === anchor ? { ...w, notes: [...(w.notes ?? []), text.replace(/[[\]]/g, "").trim()] } : w,
    );
    return FM + serializeWords(words, parsed.runs, parsed.lineEndWords, parsed.preamble);
  }

  it("attaches the note to the word at that moment and adds no new word", () => {
    const out = insertEventNote(FM + BODY, 2.5, "[laughs]");
    const words = parseWords(bodyOf(out)).words;
    // Still three spoken words - the note is not one of them.
    expect(words.map((w) => w.text)).toEqual(["He", "was", "reputable."]);
    expect(words[1].notes).toEqual(["laughs"]); // on "was"
  });

  it("round-trips the note in the body with no timestamp of its own", () => {
    const out = insertEventNote(FM + BODY, 2.5, "[laughs]");
    expect(bodyOf(out)).toContain("{{t:2.00}}was {{laughs}}");
    // Exactly the three word timestamps - the note added none.
    expect(bodyOf(out).match(/\{\{t:/g)?.length).toBe(3);
  });

  it("anchors to the first word when the time precedes it", () => {
    const out = insertEventNote(FM + BODY, 0.2, "[applause]");
    const words = parseWords(bodyOf(out)).words;
    expect(words[0].notes).toEqual(["applause"]);
  });

  it("keeps the speaker run and frontmatter intact", () => {
    const out = insertEventNote(FM + BODY, 2.5, "[laughs]");
    expect(out.startsWith(FM)).toBe(true);
    expect(out.match(/<!-- speaker:/g)?.length).toBe(1);
  });
});

describe("frontmatter edits leave dates alone", () => {
  const FM =
    [
      "---",
      "title: Original",
      "date_published: 2015-03-05",
      "date_accessed: 2026-07-24 10:00:00+09:00",
      "founded: 1947",
      "---",
    ].join("\n") + "\n";

  it("does not rewrite a date when another field is edited", () => {
    // js-yaml's default schema resolves 2015-03-05 to a Date and dumps it back
    // as 2015-03-05T00:00:00.000Z, so renaming a record silently reformatted
    // every date in its frontmatter.
    const out = rewriteFrontmatterFields(FM, { title: "Renamed" });
    expect(out).toContain("2015-03-05");
    expect(out).not.toContain("T00:00:00");
  });

  it("does not shift a dated offset into another day", () => {
    // Normalising to UTC moves the clock, and for an offset date that can move
    // the DAY - the record says when it was published, and an edit to the title
    // is not an occasion to reinterpret that.
    const out = rewriteFrontmatterFields(FM, { title: "Renamed" });
    expect(out).toContain("2026-07-24 10:00:00+09:00");
  });

  it("keeps a year-only date as a year", () => {
    expect(rewriteFrontmatterFields(FM, { title: "R" })).toMatch(/founded: '?1947'?/);
  });

  it("writes a new publication date, including a partial one", () => {
    expect(rewriteFrontmatterFields(FM, { date_published: "1947" })).toMatch(
      /date_published: ["']?1947["']?/,
    );
    expect(rewriteFrontmatterFields(FM, { date_published: "1947-06" })).toContain("1947-06");
  });

  it("clearing the date removes the key rather than writing an empty one", () => {
    expect(rewriteFrontmatterFields(FM, { date_published: "" })).not.toContain("date_published");
  });
});

describe("writing a nested frontmatter field", () => {
  const doc = [
    "---",
    "title: A Record",
    "copyright:",
    "  status: restricted",
    "  holder: Someone",
    "---",
    "body",
  ].join("\n");

  it("sets the field inside its block, not a key with a dot in its name", () => {
    // The reader flattens nested keys with dots. A writer that took the string
    // literally would add a `copyright.status` key every consumer ignores,
    // while the real status kept its old value - a silent no-op on the one
    // field that decides who can see the record.
    const out = rewriteFrontmatterFields(doc.split("body")[0], {
      "copyright.status": "public_domain",
    });
    const fm = yaml.load(out.replace(/^---\n/, "").replace(/---\n$/, "")) as Record<string, any>;
    expect(fm.copyright).toEqual({ status: "public_domain", holder: "Someone" });
    expect(fm["copyright.status"]).toBeUndefined();
  });

  it("leaves its siblings alone", () => {
    const out = rewriteFrontmatterFields(doc.split("body")[0], {
      "copyright.status": "licensed",
    });
    expect(out).toContain("holder: Someone");
    expect(out).toContain("title: A Record");
  });

  it("creates the block when the record has none", () => {
    const bare = "---\ntitle: A Record\n---\n";
    const out = rewriteFrontmatterFields(bare, { "copyright.status": "restricted" });
    const fm = yaml.load(out.replace(/^---\n/, "").replace(/---\n$/, "")) as Record<string, any>;
    expect(fm.copyright).toEqual({ status: "restricted" });
  });
});
