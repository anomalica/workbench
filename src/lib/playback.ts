import type { Segment } from "./transcript";
import { isSegmentIrrelevant } from "./transcript";

/** Find the seconds at which the next relevant segment after segIndex begins.
 *  This is the boundary where single-mode playback should pause.
 *  Returns -1 if there is no next relevant segment. */
export function nextSegmentBoundary(segments: Segment[], segIndex: number): number {
  const nextSeg = segments.find((s) => s.index > segIndex && !isSegmentIrrelevant(s));
  return nextSeg ? nextSeg.seconds : -1;
}

/** Find the relevant segment that is currently playing at a given time.
 *  Returns null if no segment matches (e.g. time is before all segments).
 *  Irrelevant segments are skipped. */
export function segmentAtTime(segments: Segment[], currentTime: number): Segment | null {
  let best: Segment | null = null;
  for (const seg of segments) {
    if (isSegmentIrrelevant(seg)) continue;
    if (seg.seconds <= currentTime) best = seg;
    else break;
  }
  return best;
}

/** Compute the pause boundary for single mode based on the current playing position.
 *  Used when toggling from auto to single mid-playback: find the segment we're in
 *  right now, and return the start time of the next one (where we should pause). */
export function singleEndForCurrentTime(segments: Segment[], currentTime: number): number {
  const current = segmentAtTime(segments, currentTime);
  if (!current) return -1;
  return nextSegmentBoundary(segments, current.index);
}
