/**
 * How a reviewer highlight is drawn - once, for every record type.
 *
 * The word editor and the prose renderer each had their own answer. The word
 * side assigned a palette colour per highlight and painted stacked bands; the
 * prose side had one flat tint and no palette at all, so a document's
 * highlights were indistinguishable from each other and the colour toggle
 * appeared to do nothing but switch an underline on and off. Two
 * implementations of one idea, and the weaker one was what a PDF got.
 *
 * The rules live here now and both paths call them.
 */

/** Ordered so consecutive highlights contrast: a reviewer tells two apart by
 *  their colour, and adjacent palette entries that look alike defeat that. */
export const HL_PALETTE = ["#f59e0b", "#14b8a6", "#8b5cf6", "#ec4899", "#3b82f6", "#84cc16"];

/** Band geometry. A band is drawn in the element's bottom padding rather than
 *  as a background, so overlapping highlights stack as separate lines instead
 *  of blending into one colour nobody can name. */
export const BAND_H = 2;
export const BAND_PITCH = 3;
export const SUBTLE_BAND_H = 1;

/** Reading, rather than working on the markup: one hairline in the text's own
 *  colour. Which highlight it is does not matter yet; that it IS one does. */
export const SUBTLE_HL = "color-mix(in srgb, currentColor 30%, transparent)";

/** The colour for the nth highlight in a record, cycling. */
export function highlightColour(index: number): string {
  return HL_PALETTE[index % HL_PALETTE.length];
}

export interface BandStyle {
  backgroundImage: string;
  backgroundRepeat: string;
  backgroundSize: string;
  backgroundPosition: string;
  paddingBottom: string;
}

/**
 * The style for a span covered by `colours`, innermost first.
 *
 * Band i sits `(n-1-i)*PITCH`px up from the padding bottom, so the innermost
 * hugs the text and the rest step downward - which is what makes two
 * overlapping highlights readable as two.
 */
export function bandStyle(colours: string[], subtle: boolean): BandStyle | null {
  if (colours.length === 0) return null;
  const n = colours.length;
  const h = subtle ? SUBTLE_BAND_H : BAND_H;
  return {
    backgroundImage: colours.map((c) => `linear-gradient(${c}, ${c})`).join(","),
    backgroundRepeat: "no-repeat",
    backgroundSize: colours.map(() => `100% ${h}px`).join(","),
    backgroundPosition: colours
      .map((_, i) => `left 0 bottom ${(n - 1 - i) * BAND_PITCH}px`)
      .join(","),
    paddingBottom: `${(n - 1) * BAND_PITCH + h}px`,
  };
}

/** The same thing as an inline `style` attribute, for HTML built as a string
 *  (the prose renderer) rather than assigned to an element (the word editor). */
export function bandStyleAttribute(colours: string[], subtle: boolean): string {
  const s = bandStyle(colours, subtle);
  if (!s) return "";
  return (
    `background-image:${s.backgroundImage};` +
    `background-repeat:${s.backgroundRepeat};` +
    `background-size:${s.backgroundSize};` +
    `background-position:${s.backgroundPosition};` +
    `padding-bottom:${s.paddingBottom}`
  );
}
