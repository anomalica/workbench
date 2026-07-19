// Keeping your place in a transcript across an Ingest <-> Markup switch.
//
// The two tabs are separate component instances, so switching remounts the
// transcript at the top - then the karaoke effect smooth-scrolls from 0 all the
// way down to a deep position, which on a 3.5-hour video takes ~10 seconds. Mark
// wants to pop over, edit, pop back; the animation makes that unusable.
//
// The anchor is a WORD INDEX, not a pixel offset. The two tabs render different
// subsets (Markup shows only observed + relevant words), so the same scrollTop
// means different places in each - but `data-word-index="N"` is the same word in
// both. Restoring to a word survives the difference in what's rendered.

import { safeLocalSet } from "$lib/storage";

const KEY = "workbench:scroll:";

export function scrollAnchorKey(contentHash: string): string {
  return `${KEY}${contentHash}`;
}

/** Persist the word index to return to. Negative/empty are ignored so a stray
 *  value can't seek the reviewer to word -1. */
export function saveScrollAnchor(contentHash: string, wordIndex: number): boolean {
  if (!contentHash || !Number.isInteger(wordIndex) || wordIndex < 0) return false;
  return safeLocalSet(scrollAnchorKey(contentHash), String(wordIndex));
}

/** The word index to restore, or null. Unparseable/negative reads as null rather
 *  than scrolling somewhere invented. */
export function loadScrollAnchor(contentHash: string): number | null {
  if (!contentHash || typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(scrollAnchorKey(contentHash));
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Which rendered word to actually scroll to. The saved word may not exist in
 *  this tab (Markup filtered it out), so fall back to the nearest rendered word
 *  at or after it, then the nearest before - never nothing, when words exist.
 *  `rendered` must be sorted ascending. */
export function resolveAnchorTarget(saved: number, rendered: number[]): number | null {
  if (rendered.length === 0) return null;
  if (rendered.includes(saved)) return saved;
  const after = rendered.find((i) => i > saved);
  if (after !== undefined) return after;
  return rendered[rendered.length - 1]; // all rendered words are before it
}

/** Should we persist again yet? A scroll fires a flood of events; writing each
 *  one is synchronous localStorage for a value read only on the next mount. */
export function shouldPersistScroll(last: number, now: number, minWords = 3): boolean {
  return Math.abs(now - last) >= minWords;
}
