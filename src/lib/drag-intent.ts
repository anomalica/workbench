/**
 * Did the reviewer drag, or did the page move under a still cursor?
 *
 * The transcript extends a selection when the pointer enters a new word. But a
 * `pointerover` is not evidence of movement: clicking a word SEEKS the audio,
 * seeking scrolls the transcript to the active word, and that slides a different
 * word under a perfectly stationary cursor. The browser reports it exactly as it
 * reports a drag.
 *
 * The observed symptom was a single click producing a selection spanning back to
 * wherever the scroll landed - "the selection gets stuck on and I can't clear
 * it". Measured on a real click: pressing word 31 yielded a range of 12-31.
 *
 * The pointer's own coordinates separate the two cases cleanly. A drag changes
 * them; content moving underneath does not. The slop absorbs the sub-pixel
 * jitter a trackpad emits while a finger rests on it, without swallowing a
 * deliberate drag - words are far wider than a few pixels, so crossing into a
 * different one always clears the threshold.
 */
export interface Point {
  x: number;
  y: number;
}

export const DRAG_SLOP_PX = 3;

export function pointerMoved(
  origin: Point | null,
  point: Point,
  slop: number = DRAG_SLOP_PX,
): boolean {
  // No recorded press: caller isn't mid-drag, so don't suppress anything.
  if (!origin) return true;
  return Math.abs(point.x - origin.x) > slop || Math.abs(point.y - origin.y) > slop;
}
