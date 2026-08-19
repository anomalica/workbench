/**
 * How loudly reviewer highlights are drawn.
 *
 * A highlight means "someone marked this passage". While READING, that is all
 * a reviewer needs to know, and the six-colour palette - one stacked band per
 * overlapping highlight - competes with the words for attention on every line
 * that carries one. While working ON the markup, telling one highlight from
 * another IS the job, and the colours are the whole point.
 *
 * So the colours are a mode rather than the default: a hairline in the text's
 * own colour until asked for. The choice is remembered, because which one a
 * reviewer wants is a property of what they are doing, not of the record they
 * happen to have open.
 */

import { safeLocalSet } from "$lib/storage";

const STORAGE_KEY = "workbench:highlights";

function load(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "colour";
  } catch {
    return true;
  }
}

class HighlightDisplay {
  /** Hairline in the text's own colour, rather than the palette. */
  subtle = $state(load());

  toggle() {
    this.subtle = !this.subtle;
    safeLocalSet(STORAGE_KEY, this.subtle ? "subtle" : "colour");
  }
}

export const highlightDisplay = new HighlightDisplay();
