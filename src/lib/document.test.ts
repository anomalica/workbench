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
} from "./transcript-words";
import yaml from "js-yaml";

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

describe("reassignWords preserves frontmatter, preamble and line prefixes", () => {
  // Mirrors DocumentStore.reassignWords exactly: split off the YAML block,
  // parse the remaining body (preamble + transcript) into words/runs, reassign,
  // serialise, then concatenate fm + newBody. Reproduces the two verified
  // round-trip failures end-to-end (preamble dropped, prefix recomputed wrong).
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
    "00:07:02.4 {{t:422.50}}I {{t:422.58}}think {{t:422.76}}it's {{t:422.92}}great.\n";

  function reassignWords(current: string, from: number, to: number, newSpeaker: string): string {
    const match = current.match(SPLIT_FM);
    const fm = match ? match[1] : "";
    const body = match ? match[2] : current;
    const { words, runs, lineEndWords, linePrefixes, preamble } = parseWords(body);
    const newRuns = reassignSpeaker(runs, from, to, newSpeaker);
    return fm + serializeWords(words, newRuns, lineEndWords, linePrefixes, preamble);
  }

  it("keeps the title and published line after a reassign", () => {
    const result = reassignWords(doc, 2, 3, "Speaker 2");
    expect(result).toContain("# PWTS Example");
    expect(result).toContain("*Published 2023-07-28*");
    expect(result).toContain('title: "PWTS Example"');
  });

  it("keeps the verbatim line prefix the token would round up", () => {
    // Reassign the whole line to a new speaker: the line stays one block so its
    // first word keeps the verbatim 07:02.4 prefix rather than recomputing it to
    // the (wrong) floored 07:02.5 the 2dp token would yield.
    const result = reassignWords(doc, 0, 3, "Speaker 2");
    expect(result).toContain("00:07:02.4 {{t:422.50}}I");
    expect(result).not.toContain("00:07:02.5");
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
    const newBody = serializeWords(
      parsed.words,
      newRuns,
      parsed.lineEndWords,
      parsed.linePrefixes,
      parsed.preamble,
    );
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
    const newBody = serializeWords(
      parsed.words,
      newRuns,
      parsed.lineEndWords,
      parsed.linePrefixes,
      parsed.preamble,
    );
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
    "00:07:02.4 {{t:422.50}}I {{t:422.58}}think {{t:422.76}}it's {{t:422.92}}great.\n" +
    "\n" +
    "<!-- speaker: Speaker 2 -->\n" +
    "00:00:13.0 {{t:13.02}}He {{t:13.12}}was {{t:13.28}}brave.\n" +
    "\n" +
    "<!-- speaker: Speaker 1 -->\n" +
    "00:00:21.0 {{t:21.02}}They {{t:21.20}}agree.\n";

  function fmSpeakers(current: string): string[] {
    const [rawFm] = split(current);
    const fmContent = rawFm.replace(/^---\n/, "").replace(/---\n$/, "");
    const fmDoc = (yaml.load(fmContent) as Record<string, unknown>) ?? {};
    return (fmDoc.speakers as string[] | undefined) ?? [];
  }

  it("renameWordSpeaker preserves word times, line prefixes and preamble", () => {
    const result = renameWordSpeaker(doc, "Speaker 1", "Ed Leedskalnin");
    // Preamble untouched.
    expect(result).toContain("# PWTS Example");
    expect(result).toContain("*Published 2023-07-28*");
    // Verbatim prefix and every word token survive; only the speaker comment
    // changed. 422.50 must NOT recompute to 07:02.5.
    expect(result).toContain("00:07:02.4 {{t:422.50}}I {{t:422.58}}think {{t:422.76}}it's");
    expect(result).not.toContain("00:07:02.5");
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
