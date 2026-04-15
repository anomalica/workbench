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

  it("sets irrelevant to false by default", () => {
    const segs = parseTranscript(body);
    expect(segs.every((s) => s.irrelevant === false)).toBe(true);
  });

  it("assigns sequential indices", () => {
    const segs = parseTranscript(body);
    expect(segs.map((s) => s.index)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("parseTranscript - irrelevant markers", () => {
  const body = `
<!-- speaker: Speaker 1 -->
<!-- irrelevant -->
00:00:01.8 This is irrelevant content.
00:00:07.6 This is relevant content.
`;

  it("marks the segment after <!-- irrelevant --> as irrelevant", () => {
    const segs = parseTranscript(body);
    expect(segs.length).toBe(2);
    expect(segs[0].irrelevant).toBe(true);
    expect(segs[0].lines).toEqual(["This is irrelevant content."]);
  });

  it("does not mark the next segment as irrelevant", () => {
    const segs = parseTranscript(body);
    expect(segs[1].irrelevant).toBe(false);
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

  it("reads irrelevant flag", () => {
    const segs = parseTranscript(body);
    expect(segs[0].irrelevant).toBe(false);
    expect(segs[1].irrelevant).toBe(true);
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
        irrelevant: false,
        index: 0,
      },
      {
        speaker: "Speaker 1",
        time: "00:00:05.0",
        seconds: 5,
        lines: ["World."],
        irrelevant: false,
        index: 1,
      },
      {
        speaker: "Speaker 2",
        time: "00:00:10.0",
        seconds: 10,
        lines: ["Hi."],
        irrelevant: false,
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
        irrelevant: false,
        index: 0,
      },
      {
        speaker: "Speaker 1",
        time: "00:00:05.0",
        seconds: 5,
        lines: ["B."],
        irrelevant: false,
        index: 1,
      },
    ];
    const result = serializeTranscript(segs);
    const matches = result.match(/<!-- speaker: Speaker 1 -->/g);
    expect(matches?.length).toBe(1);
  });

  it("outputs <!-- irrelevant --> for irrelevant segments", () => {
    const segs = [
      {
        speaker: "Speaker 1",
        time: "00:00:01.8",
        seconds: 1.8,
        lines: ["Skip this."],
        irrelevant: true,
        index: 0,
      },
      {
        speaker: "Speaker 1",
        time: "00:00:05.0",
        seconds: 5,
        lines: ["Keep this."],
        irrelevant: false,
        index: 1,
      },
    ];
    const result = serializeTranscript(segs);
    expect(result).toContain("<!-- irrelevant -->");
    // The irrelevant marker should come before the timestamped line
    const irIdx = result.indexOf("<!-- irrelevant -->");
    const lineIdx = result.indexOf("00:00:01.8 Skip this.");
    expect(irIdx).toBeLessThan(lineIdx);
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
      expect(reparsed[i].irrelevant).toBe(segs[i].irrelevant);
    }
  });

  it("preserves irrelevant flag through round-trip", () => {
    const body = `
<!-- speaker: Speaker 1 -->
<!-- irrelevant -->
00:00:01.8 Skip this.
00:00:05.0 Keep this.
`;
    const segs = parseTranscript(body);
    expect(segs[0].irrelevant).toBe(true);
    expect(segs[1].irrelevant).toBe(false);

    const serialised = serializeTranscript(segs);
    const reparsed = parseTranscript(serialised);

    expect(reparsed[0].irrelevant).toBe(true);
    expect(reparsed[1].irrelevant).toBe(false);
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
      { speaker: "Speaker 3", time: "", seconds: 0, lines: [], irrelevant: false, index: 0 },
      { speaker: "Speaker 1", time: "", seconds: 0, lines: [], irrelevant: false, index: 1 },
    ];
    expect(nextSpeakerName(segs)).toBe("Speaker 4");
  });

  it("ignores named speakers", () => {
    const segs = [
      { speaker: "Lex Fridman", time: "", seconds: 0, lines: [], irrelevant: false, index: 0 },
      { speaker: "Speaker 2", time: "", seconds: 0, lines: [], irrelevant: false, index: 1 },
    ];
    expect(nextSpeakerName(segs)).toBe("Speaker 3");
  });
});
