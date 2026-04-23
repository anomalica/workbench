import { describe, it, expect } from "vitest";
import { parseTranscript } from "./transcript";
import { nextSegmentBoundary, segmentAtTime, singleEndForCurrentTime } from "./playback";

const THREE_SEGMENT_BODY = `
<!-- speaker: Speaker 1 -->
00:00:01.8 First.
00:00:05.0 Second.

<!-- speaker: Speaker 2 -->
00:00:10.0 Third.
`;

describe("nextSegmentBoundary", () => {
  const segs = parseTranscript(THREE_SEGMENT_BODY);

  it("returns the next segment's start time", () => {
    expect(nextSegmentBoundary(segs, 0)).toBe(5);
    expect(nextSegmentBoundary(segs, 1)).toBe(10);
  });

  it("returns -1 for the last segment", () => {
    expect(nextSegmentBoundary(segs, 2)).toBe(-1);
  });

  it("skips irrelevant segments", () => {
    const body = `
<!-- speaker: Speaker 1 -->
00:00:01.8 First.

<!-- speaker: [irrelevant] -->
00:00:05.0 Skip this.

<!-- speaker: Speaker 2 -->
00:00:10.0 Third.
`;
    const s = parseTranscript(body);
    // After segment 0, the next relevant segment is at 10s (skip irrelevant at 5s)
    expect(nextSegmentBoundary(s, 0)).toBe(10);
  });
});

describe("segmentAtTime", () => {
  const segs = parseTranscript(THREE_SEGMENT_BODY);

  it("returns null before any segment starts", () => {
    expect(segmentAtTime(segs, 0)).toBeNull();
  });

  it("returns the first segment at its start time", () => {
    expect(segmentAtTime(segs, 1.8)?.index).toBe(0);
  });

  it("stays on first segment between timestamps", () => {
    expect(segmentAtTime(segs, 3)?.index).toBe(0);
  });

  it("advances to the second segment at its timestamp", () => {
    expect(segmentAtTime(segs, 5)?.index).toBe(1);
    expect(segmentAtTime(segs, 7)?.index).toBe(1);
  });

  it("advances to the third segment at its timestamp", () => {
    expect(segmentAtTime(segs, 10)?.index).toBe(2);
    expect(segmentAtTime(segs, 999)?.index).toBe(2);
  });

  it("skips irrelevant segments", () => {
    const body = `
<!-- speaker: [irrelevant] -->
00:00:01.8 Skip.

<!-- speaker: Speaker 1 -->
00:00:05.0 Keep.
`;
    const s = parseTranscript(body);
    // At time 3s we'd be "in" the irrelevant segment, but it's skipped
    expect(segmentAtTime(s, 3)).toBeNull();
    expect(segmentAtTime(s, 5)?.index).toBe(1);
  });
});

describe("singleEndForCurrentTime (toggle auto to single mid-playback)", () => {
  const segs = parseTranscript(THREE_SEGMENT_BODY);

  it("returns the end of the currently playing segment", () => {
    // Playing through the first segment (1.8 to 5.0) - should pause at 5.0
    expect(singleEndForCurrentTime(segs, 3)).toBe(5);
    // Playing through the second segment (5.0 to 10.0) - should pause at 10.0
    expect(singleEndForCurrentTime(segs, 7)).toBe(10);
  });

  it("returns -1 when playing the last segment", () => {
    // Playing past the final timestamp - no next segment to stop at
    expect(singleEndForCurrentTime(segs, 15)).toBe(-1);
  });

  it("returns -1 before any segment has started", () => {
    expect(singleEndForCurrentTime(segs, 0)).toBe(-1);
  });

  it("user's reported bug: toggling mode mid-play should set a pause boundary", () => {
    // The bug: user is watching video in auto mode, video reaches 3s (in segment 0).
    // User clicks the toggle button to switch to single mode.
    // Expected: video continues playing segment 0, then pauses at 5.0s (segment 1's start).
    // Previously returned -1 (no pause) because we didn't compute the boundary.
    expect(singleEndForCurrentTime(segs, 3)).toBe(5);
  });

  it("skips irrelevant segments when finding the boundary", () => {
    const body = `
<!-- speaker: Speaker 1 -->
00:00:01.8 Playing this.

<!-- speaker: [irrelevant] -->
00:00:05.0 Skip this.

<!-- speaker: Speaker 2 -->
00:00:10.0 Next relevant.
`;
    const s = parseTranscript(body);
    // Playing segment 0 at 3s - next relevant is segment 2 at 10s (skip irrelevant)
    expect(singleEndForCurrentTime(s, 3)).toBe(10);
  });
});
