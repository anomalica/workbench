import { describe, it, expect } from "vitest";
import {
  parseTranscript,
  serializeTranscript,
  SPEAKER_IRRELEVANT,
  isSegmentIrrelevant,
} from "./transcript";

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
