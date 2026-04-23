import { describe, it, expect } from "vitest";
import {
  parseTranscript,
  serializeTranscript,
  parseTimeToSeconds,
  secondsToTime,
  nextSpeakerName,
  speakerColour,
  findActiveSegmentForTime,
  extractFrontmatterSpeakers,
  isDefaultSpeakerName,
  isSegmentIrrelevant,
  groupSegmentsBySpeaker,
  orderedNamedSpeakers,
  SPEAKER_IRRELEVANT,
  type Segment,
} from "./transcript";

describe("parseTimeToSeconds", () => {
  it("parses HH:MM:SS", () => {
    expect(parseTimeToSeconds("01:30:45")).toBe(5445);
  });

  it("parses MM:SS", () => {
    expect(parseTimeToSeconds("05:30")).toBe(330);
  });

  it("parses HH:MM:SS.D (sub-second)", () => {
    expect(parseTimeToSeconds("00:00:01.8")).toBeCloseTo(1.8);
  });

  it("parses 00:00:00", () => {
    expect(parseTimeToSeconds("00:00:00")).toBe(0);
  });
});

describe("secondsToTime", () => {
  it("formats with hours", () => {
    expect(secondsToTime(5445)).toBe("01:30:45");
  });

  it("formats without hours", () => {
    expect(secondsToTime(330)).toBe("05:30");
  });

  it("formats zero", () => {
    expect(secondsToTime(0)).toBe("00:00");
  });
});

describe("parseTranscript - new format (sentence-level timestamps)", () => {
  const body = `
<!-- speaker: Speaker 1 -->
00:00:01.8 We have tackled many strange stories.
00:00:07.6 It's the story of the U.S. government.

<!-- speaker: Speaker 2 -->
00:00:44.4 So what you're telling me is that UFOs are real.

<!-- speaker: Speaker 3 -->
00:00:54.6 Bill, I think we're beyond that already.
00:00:56.3 The government has already stated for the record.
`;

  it("parses segments from timestamped lines", () => {
    const segs = parseTranscript(body);
    expect(segs.length).toBe(5);
  });

  it("assigns correct speakers", () => {
    const segs = parseTranscript(body);
    expect(segs[0].speaker).toBe("Speaker 1");
    expect(segs[1].speaker).toBe("Speaker 1");
    expect(segs[2].speaker).toBe("Speaker 2");
    expect(segs[3].speaker).toBe("Speaker 3");
    expect(segs[4].speaker).toBe("Speaker 3");
  });

  it("parses sub-second timestamps", () => {
    const segs = parseTranscript(body);
    expect(segs[0].time).toBe("00:00:01.8");
    expect(segs[0].seconds).toBeCloseTo(1.8);
  });

  it("extracts text without timestamps", () => {
    const segs = parseTranscript(body);
    expect(segs[0].lines).toEqual(["We have tackled many strange stories."]);
    expect(segs[2].lines).toEqual(["So what you're telling me is that UFOs are real."]);
  });

  it("no segments have [irrelevant] speaker by default", () => {
    const segs = parseTranscript(body);
    expect(segs.every((s) => !isSegmentIrrelevant(s))).toBe(true);
  });

  it("assigns sequential indices", () => {
    const segs = parseTranscript(body);
    expect(segs.map((s) => s.index)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("parseTranscript - legacy irrelevant markers", () => {
  const body = `
<!-- speaker: Speaker 1 -->
<!-- irrelevant -->
00:00:01.8 This is irrelevant content.
00:00:07.6 This is relevant content.
`;

  it("converts legacy <!-- irrelevant --> to [irrelevant] speaker", () => {
    const segs = parseTranscript(body);
    expect(segs.length).toBe(2);
    expect(segs[0].speaker).toBe("[irrelevant]");
    expect(segs[0].lines).toEqual(["This is irrelevant content."]);
  });

  it("does not affect the next segment", () => {
    const segs = parseTranscript(body);
    expect(segs[1].speaker).toBe("Speaker 1");
    expect(segs[1].lines).toEqual(["This is relevant content."]);
  });
});

describe("parseTranscript - old format (multi-line blocks)", () => {
  const body = `
<!--
speaker: David Fravor
time: 00:07:17
-->
Yeah, I am.

<!--
speaker: Lex Fridman
time: 00:07:18
irrelevant: true
-->
Better known as Top Gun.
`;

  it("parses segments from multi-line blocks", () => {
    const segs = parseTranscript(body);
    expect(segs.length).toBe(2);
  });

  it("extracts speaker and time", () => {
    const segs = parseTranscript(body);
    expect(segs[0].speaker).toBe("David Fravor");
    expect(segs[0].time).toBe("00:07:17");
    expect(segs[0].seconds).toBe(437);
  });

  it("old irrelevant: true field is ignored (use speaker name instead)", () => {
    const segs = parseTranscript(body);
    // The old irrelevant field is no longer parsed - irrelevance is
    // determined by the speaker name being [irrelevant]
    expect(segs[0].speaker).toBe("David Fravor");
    expect(segs[1].speaker).toBe("Lex Fridman");
  });

  it("extracts text content", () => {
    const segs = parseTranscript(body);
    expect(segs[0].lines).toEqual(["Yeah, I am."]);
    expect(segs[1].lines).toEqual(["Better known as Top Gun."]);
  });
});

describe("parseTranscript - other annotations are skipped", () => {
  const body = `
<!-- file_page: 1 -->
<!-- image: A photo of something. -->

<!-- speaker: Speaker 1 -->
00:00:01.8 First sentence.

<!-- file_page: 2 -->

<!-- speaker: Speaker 1 -->
00:00:10.0 Second sentence.
`;

  it("ignores file_page and image annotations", () => {
    const segs = parseTranscript(body);
    expect(segs.length).toBe(2);
    expect(segs[0].lines).toEqual(["First sentence."]);
    expect(segs[1].lines).toEqual(["Second sentence."]);
  });
});

describe("serializeTranscript - new format", () => {
  it("outputs speaker comments and timestamped lines", () => {
    const segs = [
      {
        speaker: "Speaker 1",
        time: "00:00:01.8",
        seconds: 1.8,
        lines: ["Hello."],

        index: 0,
      },
      {
        speaker: "Speaker 1",
        time: "00:00:05.0",
        seconds: 5,
        lines: ["World."],

        index: 1,
      },
      {
        speaker: "Speaker 2",
        time: "00:00:10.0",
        seconds: 10,
        lines: ["Hi."],

        index: 2,
      },
    ];
    const result = serializeTranscript(segs);
    expect(result).toContain("<!-- speaker: Speaker 1 -->");
    expect(result).toContain("00:00:01.8 Hello.");
    expect(result).toContain("00:00:05.0 World.");
    expect(result).toContain("<!-- speaker: Speaker 2 -->");
    expect(result).toContain("00:00:10.0 Hi.");
  });

  it("does not repeat speaker comment for consecutive same-speaker segments", () => {
    const segs = [
      {
        speaker: "Speaker 1",
        time: "00:00:01.8",
        seconds: 1.8,
        lines: ["A."],

        index: 0,
      },
      {
        speaker: "Speaker 1",
        time: "00:00:05.0",
        seconds: 5,
        lines: ["B."],

        index: 1,
      },
    ];
    const result = serializeTranscript(segs);
    const matches = result.match(/<!-- speaker: Speaker 1 -->/g);
    expect(matches?.length).toBe(1);
  });

  it("uses [irrelevant] speaker name for irrelevant segments", () => {
    const segs = [
      {
        speaker: SPEAKER_IRRELEVANT,
        time: "00:00:01.8",
        seconds: 1.8,
        lines: ["Skip this."],
        index: 0,
      },
      {
        speaker: "Speaker 1",
        time: "00:00:05.0",
        seconds: 5,
        lines: ["Keep this."],
        index: 1,
      },
    ];
    const result = serializeTranscript(segs);
    expect(result).toContain("<!-- speaker: [irrelevant] -->");
    expect(result).toContain("<!-- speaker: Speaker 1 -->");
  });
});

describe("round-trip: parse then serialize", () => {
  it("preserves new-format content through round-trip", () => {
    const body = `
<!-- speaker: Speaker 1 -->
00:00:01.8 Hello world.
00:00:05.0 How are you.

<!-- speaker: Speaker 2 -->
00:00:10.0 I'm fine.
`;
    const segs = parseTranscript(body);
    const serialised = serializeTranscript(segs);
    const reparsed = parseTranscript(serialised);

    expect(reparsed.length).toBe(segs.length);
    for (let i = 0; i < segs.length; i++) {
      expect(reparsed[i].speaker).toBe(segs[i].speaker);
      expect(reparsed[i].time).toBe(segs[i].time);
      expect(reparsed[i].lines).toEqual(segs[i].lines);
      expect(isSegmentIrrelevant(reparsed[i])).toBe(isSegmentIrrelevant(segs[i]));
    }
  });

  it("preserves irrelevant speaker through round-trip", () => {
    const body = `
<!-- speaker: Speaker 1 -->
<!-- irrelevant -->
00:00:01.8 Skip this.
00:00:05.0 Keep this.
`;
    const segs = parseTranscript(body);
    expect(isSegmentIrrelevant(segs[0])).toBe(true);
    expect(isSegmentIrrelevant(segs[1])).toBe(false);

    const serialised = serializeTranscript(segs);
    const reparsed = parseTranscript(serialised);

    expect(isSegmentIrrelevant(reparsed[0])).toBe(true);
    expect(isSegmentIrrelevant(reparsed[1])).toBe(false);
    expect(reparsed[0].lines).toEqual(["Skip this."]);
    expect(reparsed[1].lines).toEqual(["Keep this."]);
  });
});

describe("findActiveSegmentForTime", () => {
  const body = `
<!-- speaker: Speaker 1 -->
00:00:01.8 First sentence.
00:00:07.6 Second sentence.

<!-- speaker: Speaker 2 -->
00:00:44.4 Third sentence.

<!-- speaker: Speaker 3 -->
00:00:54.6 Fourth sentence.
00:00:56.3 Fifth sentence.
`;
  const segments = parseTranscript(body);

  it("returns -1 before any segment starts", () => {
    expect(findActiveSegmentForTime(segments, 0)).toBe(-1);
  });

  it("returns first segment at its start time", () => {
    expect(findActiveSegmentForTime(segments, 1.8)).toBe(0);
  });

  it("stays on first segment between first and second timestamps", () => {
    expect(findActiveSegmentForTime(segments, 5.0)).toBe(0);
  });

  it("advances to second segment at its timestamp", () => {
    expect(findActiveSegmentForTime(segments, 7.6)).toBe(1);
  });

  it("advances to Speaker 2 segment", () => {
    expect(findActiveSegmentForTime(segments, 44.4)).toBe(2);
  });

  it("advances through all segments", () => {
    expect(findActiveSegmentForTime(segments, 54.6)).toBe(3);
    expect(findActiveSegmentForTime(segments, 56.3)).toBe(4);
  });

  it("stays on last segment after its timestamp", () => {
    expect(findActiveSegmentForTime(segments, 999)).toBe(4);
  });

  it("skips irrelevant segments", () => {
    const bodyWithIrrelevant = `
<!-- speaker: Speaker 1 -->
<!-- irrelevant -->
00:00:01.8 Skip this.
00:00:07.6 Keep this.

<!-- speaker: Speaker 2 -->
00:00:44.4 Also keep this.
`;
    const segs = parseTranscript(bodyWithIrrelevant);
    // At time 1.8, the first segment is irrelevant - should return -1
    expect(findActiveSegmentForTime(segs, 1.8)).toBe(-1);
    // At time 7.6, should land on the second segment (index 1)
    expect(findActiveSegmentForTime(segs, 7.6)).toBe(1);
    // At time 44.4, should land on Speaker 2 (index 2)
    expect(findActiveSegmentForTime(segs, 44.4)).toBe(2);
  });

  it("each segment has a unique index that advances", () => {
    // This is the core auto-follow requirement: as time increases,
    // the returned index must change when crossing segment boundaries
    const times = [1.8, 7.6, 44.4, 54.6, 56.3];
    const indices = times.map((t) => findActiveSegmentForTime(segments, t));
    expect(indices).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("isDefaultSpeakerName", () => {
  it("recognises Speaker N pattern", () => {
    expect(isDefaultSpeakerName("Speaker 1")).toBe(true);
    expect(isDefaultSpeakerName("Speaker 42")).toBe(true);
  });

  it("rejects named speakers", () => {
    expect(isDefaultSpeakerName("Lex Fridman")).toBe(false);
    expect(isDefaultSpeakerName("David Fravor")).toBe(false);
    expect(isDefaultSpeakerName("")).toBe(false);
  });
});

describe("extractFrontmatterSpeakers", () => {
  it("extracts a simple speakers list", () => {
    const fm = `---
title: Test
speakers:
  - David Fravor
  - Lex Fridman
---
`;
    expect(extractFrontmatterSpeakers(fm)).toEqual(["David Fravor", "Lex Fridman"]);
  });

  it("returns empty array when no speakers field", () => {
    const fm = `---
title: Test
---
`;
    expect(extractFrontmatterSpeakers(fm)).toEqual([]);
  });

  it("handles quoted names", () => {
    const fm = `---
speakers:
  - "Bill O'Reilly"
---
`;
    expect(extractFrontmatterSpeakers(fm)).toEqual(["Bill O'Reilly"]);
  });
});

describe("speakerColour", () => {
  it("returns consistent colour for the same name", () => {
    expect(speakerColour("Lex Fridman")).toBe(speakerColour("Lex Fridman"));
  });

  it("returns different colours for different names", () => {
    expect(speakerColour("Lex Fridman")).not.toBe(speakerColour("David Fravor"));
  });
});

describe("nextSpeakerName", () => {
  it("returns Speaker 1 for empty list", () => {
    expect(nextSpeakerName([])).toBe("Speaker 1");
  });

  it("returns next number after highest", () => {
    const segs = [
      { speaker: "Speaker 3", time: "", seconds: 0, lines: [], index: 0 },
      { speaker: "Speaker 1", time: "", seconds: 0, lines: [], index: 1 },
    ];
    expect(nextSpeakerName(segs)).toBe("Speaker 4");
  });

  it("ignores named speakers", () => {
    const segs = [
      { speaker: "Lex Fridman", time: "", seconds: 0, lines: [], index: 0 },
      { speaker: "Speaker 2", time: "", seconds: 0, lines: [], index: 1 },
    ];
    expect(nextSpeakerName(segs)).toBe("Speaker 3");
  });
});

describe("groupSegmentsBySpeaker", () => {
  it("groups consecutive segments with the same speaker", () => {
    const body = `
<!-- speaker: Speaker 1 -->
00:00:01.8 First.
00:00:05.0 Second.
00:00:07.0 Third.

<!-- speaker: Speaker 2 -->
00:00:10.0 Fourth.

<!-- speaker: Speaker 1 -->
00:00:15.0 Fifth.
00:00:18.0 Sixth.
`;
    const groups = groupSegmentsBySpeaker(parseTranscript(body));
    expect(groups.length).toBe(3);
    expect(groups[0].speaker).toBe("Speaker 1");
    expect(groups[0].segments.length).toBe(3);
    expect(groups[1].speaker).toBe("Speaker 2");
    expect(groups[1].segments.length).toBe(1);
    expect(groups[2].speaker).toBe("Speaker 1");
    expect(groups[2].segments.length).toBe(2);
  });

  it("preserves segment order within groups", () => {
    const body = `
<!-- speaker: Speaker 1 -->
00:00:01.8 A.
00:00:05.0 B.
00:00:07.0 C.
`;
    const groups = groupSegmentsBySpeaker(parseTranscript(body));
    expect(groups[0].segments.map((s) => s.lines[0])).toEqual(["A.", "B.", "C."]);
  });

  it("returns empty array for empty input", () => {
    expect(groupSegmentsBySpeaker([])).toEqual([]);
  });

  it("treats [irrelevant] as its own group", () => {
    const body = `
<!-- speaker: Speaker 1 -->
00:00:01.8 A.

<!-- speaker: [irrelevant] -->
00:00:05.0 Skip.

<!-- speaker: Speaker 1 -->
00:00:10.0 B.
`;
    const groups = groupSegmentsBySpeaker(parseTranscript(body));
    expect(groups.length).toBe(3);
    expect(groups.map((g) => g.speaker)).toEqual(["Speaker 1", "[irrelevant]", "Speaker 1"]);
  });
});

describe("orderedNamedSpeakers", () => {
  const seg = (speaker: string, index: number): Segment => ({
    speaker,
    time: `00:00:${String(index).padStart(2, "0")}`,
    seconds: index,
    lines: [""],
    index,
  });

  it("orders named speakers by first appearance in segments", () => {
    const segments = [seg("Lex", 0), seg("Speaker 3", 1), seg("Guest", 2)];
    const named = ["Guest", "Lex"]; // frontmatter order is different

    expect(orderedNamedSpeakers(segments, named)).toEqual(["Lex", "Guest"]);
  });

  it("appends named speakers without segments in frontmatter order", () => {
    const segments = [seg("Lex", 0)];
    const named = ["Alice", "Lex", "Bob"]; // Alice and Bob have no segments yet

    expect(orderedNamedSpeakers(segments, named)).toEqual(["Lex", "Alice", "Bob"]);
  });

  it("picker and sidebar produce identical named ordering", () => {
    // Realistic scenario: diarisation clusters came back 13, 3, 10, 14
    // User named two of them. Frontmatter lists them in the order they were renamed.
    const segments = [
      seg("Speaker 13", 0),
      seg("Lex", 1), // renamed from Speaker 3
      seg("Speaker 10", 2),
      seg("Guest", 3), // renamed from Speaker 14
      seg("Lex", 4),
    ];
    const named = ["Guest", "Lex"]; // named in rename order, different from transcript order

    const sidebarOrder = orderedNamedSpeakers(segments, named);
    const pickerOrder = orderedNamedSpeakers(segments, named);

    expect(pickerOrder).toEqual(sidebarOrder);
    expect(sidebarOrder).toEqual(["Lex", "Guest"]); // first appearance order
  });
});
