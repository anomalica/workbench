// Remembering where you were in a record's audio.
//
// Two moments, one cause. Coming BACK to a record dropped you at 0:00, so a
// reviewer part-way through a 3.5-hour video had to hunt for their place. And
// flicking Ingest <-> Markup keeps the audio playing (the element never
// remounts) but re-renders the transcript at the top, so the words and the sound
// disagree about where you are - you can hear 1:12:04 and be looking at 0:00.
//
// The playhead is the anchor for both: persist it per record, restore it on
// load, and scroll the transcript to it rather than to the top.

import { safeLocalSet } from "$lib/storage";

const KEY = "workbench:playhead:";

/** How close to the end counts as "finished". Restoring someone to the last
 *  second of a record is worse than starting over - there is nothing left to
 *  hear, and the control they want is play, not resume. */
const END_MARGIN_SECONDS = 10;

/** Below this, there is nothing worth restoring - and writing it would overwrite
 *  a real position with a stray click near the start. */
const MIN_SECONDS = 1;

export function playheadKey(contentHash: string): string {
  return `${KEY}${contentHash}`;
}

/** Save the playhead. Returns false when the position isn't worth keeping, so a
 *  caller can't accidentally read "saved" as "the value is there". */
export function savePlayhead(contentHash: string, seconds: number): boolean {
  if (!contentHash || !Number.isFinite(seconds) || seconds < MIN_SECONDS) return false;
  return safeLocalSet(playheadKey(contentHash), String(Math.round(seconds * 100) / 100));
}

/** The saved playhead, or null. `duration` (when known) suppresses a position at
 *  the very end. Anything unparseable or out of range reads as null rather than
 *  seeking the reviewer somewhere invented. */
export function loadPlayhead(contentHash: string, duration?: number): number | null {
  if (!contentHash || typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(playheadKey(contentHash));
  if (raw === null) return null;
  const t = Number(raw);
  if (!Number.isFinite(t) || t < MIN_SECONDS) return null;
  if (duration && Number.isFinite(duration)) {
    if (t > duration) return null; // a stale position from a different cut of the media
    if (t > duration - END_MARGIN_SECONDS) return null; // finished
  }
  return t;
}

export function clearPlayhead(contentHash: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(playheadKey(contentHash));
  } catch {
    /* storage disabled - nothing to clear */
  }
}

/** Should we write again yet? Writing on every timeupdate is ~4 writes/second of
 *  synchronous localStorage for a value nobody reads until the next visit. */
export function shouldPersist(last: number, now: number, intervalSeconds = 5): boolean {
  return Math.abs(now - last) >= intervalSeconds;
}
