/**
 * How loudly other people's highlights are drawn - or whether they are drawn.
 *
 * A highlight means "someone marked this passage". Three states, because there
 * are three different things a person is doing:
 *
 * - OFF. Reading the record for itself. Somebody else's marks are somebody
 *   else's, and a reader who wants the text as it stands should be able to have
 *   exactly that. Nothing is deleted: the markup is still in the document and
 *   one click brings it back.
 * - MINIMAL. Reading, but wanting to know a passage carries a mark. A hairline
 *   in the text's own colour, and any number of overlapping highlights collapse
 *   to one - the signal is "this is highlighted", not which one.
 * - FULL. Working ON the markup, where telling one highlight from another IS
 *   the job: the six-colour palette, one stacked band per overlap.
 *
 * Minimal is the default, because that was the reading default before there was
 * an off, and it is the state that says the most for the least. The choice is
 * remembered: which one somebody wants is a property of what they are doing,
 * not of the record they happen to have open.
 */

import { safeLocalSet } from "$lib/storage";

const STORAGE_KEY = "workbench:highlights";

export type HighlightMode = "off" | "minimal" | "full";

/** In this order, because the button steps through it. */
export const HIGHLIGHT_MODES: HighlightMode[] = ["off", "minimal", "full"];

export const HIGHLIGHT_LABEL: Record<HighlightMode, string> = {
  off: "Highlights hidden",
  minimal: "Highlights marked",
  full: "Highlights coloured",
};

export const HIGHLIGHT_HINT: Record<HighlightMode, string> = {
  off: "Other people's highlights are hidden. Click to mark them with a hairline.",
  minimal: "Highlights are marked with a hairline. Click to colour them.",
  full: "Highlights are coloured, one band per overlap. Click to hide them.",
};

/** What a stored preference means, including the two the switch wrote when it
 *  had only two states: a reviewer who had chosen colours keeps them rather
 *  than being reset to the default by an upgrade. */
export function modeFromStored(stored: string | null): HighlightMode {
  if (stored === "colour" || stored === "full") return "full";
  if (stored === "off") return "off";
  return "minimal";
}

function load(): HighlightMode {
  try {
    return modeFromStored(localStorage.getItem(STORAGE_KEY));
  } catch {
    return "minimal";
  }
}

class HighlightDisplay {
  mode = $state<HighlightMode>(load());

  /** Drawn at all. */
  get shown(): boolean {
    return this.mode !== "off";
  }

  /** A hairline in the text's own colour rather than the palette. */
  get subtle(): boolean {
    return this.mode === "minimal";
  }

  set(mode: HighlightMode) {
    this.mode = mode;
    safeLocalSet(STORAGE_KEY, mode);
  }

  /** Off -> minimal -> full -> off. One control, because it is one question
   *  asked at three volumes, and a three-way switch in a toolbar of icons would
   *  cost more room than the answer is worth. */
  cycle() {
    const next = HIGHLIGHT_MODES[(HIGHLIGHT_MODES.indexOf(this.mode) + 1) % HIGHLIGHT_MODES.length];
    this.set(next);
  }
}

export const highlightDisplay = new HighlightDisplay();
