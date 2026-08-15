/**
 * Speaker colour by order of appearance in the record being viewed.
 *
 * It used to be a hash of the name into a fourteen-colour palette, so the two
 * speakers of a two-hander drew at random and landed on neighbouring hues about
 * a third of the time - "both speakers are purple". Order of appearance instead
 * means the first two speakers are always the two most different colours in the
 * palette, which is the case that matters because most records are interviews.
 *
 * Reactive state rather than a plain module variable: the dots are rendered
 * before the order is known, and a non-reactive value leaves them painted with
 * whatever they were first given.
 */

import { speakerColour as hashedColour } from "./transcript";

let order = $state<string[]>([]);

export function setSpeakerOrder(names: string[]): void {
  order = names;
}

/** The colour for a speaker, by their position in this record. Falls back to
 *  the hash for a name the record does not contain - a speaker list from
 *  frontmatter with no turns yet, say - so nothing renders colourless. */
export function colourFor(speaker: string): string {
  const at = order.indexOf(speaker);
  return at === -1 ? hashedColour(speaker) : PALETTE[at % PALETTE.length];
}

/** Ordered so consecutive entries contrast: each step jumps roughly across the
 *  hue wheel, so first and second are never near-neighbours. */
const PALETTE = [
  "#0B6E6E",
  "#B35A28",
  "#3B7FC4",
  "#C44B8B",
  "#2D7D46",
  "#7B4DAA",
  "#8B6914",
  "#C4543B",
  "#4A8B6E",
  "#6E4A8B",
  "#8B4A6E",
  "#4A6E8B",
  "#6E8B4A",
  "#8B6E4A",
];
