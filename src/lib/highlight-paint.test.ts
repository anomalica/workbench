/**
 * One painting rule for every record type.
 *
 * The word editor and the prose renderer each had their own: the word side
 * assigned a palette colour per highlight and stacked bands, the prose side had
 * one flat tint and no palette, so a document's highlights were
 * indistinguishable and the colour toggle looked like it only switched an
 * underline. These are the rules both now call.
 */

import { describe, expect, it } from "vitest";
import {
  BAND_H,
  BAND_PITCH,
  HL_PALETTE,
  SUBTLE_BAND_H,
  bandStyle,
  bandStyleAttribute,
  highlightColour,
} from "./highlight-paint";

describe("which colour a highlight gets", () => {
  it("gives each highlight its own, in order", () => {
    expect(highlightColour(0)).toBe(HL_PALETTE[0]);
    expect(highlightColour(1)).toBe(HL_PALETTE[1]);
    expect(highlightColour(0)).not.toBe(highlightColour(1));
  });

  it("cycles rather than running out", () => {
    expect(highlightColour(HL_PALETTE.length)).toBe(HL_PALETTE[0]);
  });
});

describe("the band", () => {
  it("is nothing at all when nothing covers the span", () => {
    expect(bandStyle([], false)).toBeNull();
    expect(bandStyleAttribute([], false)).toBe("");
  });

  it("is thinner while reading than while working on the markup", () => {
    expect(bandStyle(["#f00"], true)!.backgroundSize).toContain(`${SUBTLE_BAND_H}px`);
    expect(bandStyle(["#f00"], false)!.backgroundSize).toContain(`${BAND_H}px`);
  });

  it("stacks overlapping highlights as separate lines", () => {
    // Two highlights over one span have to read as two. A shared background
    // would blend them into one colour nobody can name.
    const two = bandStyle(["#f00", "#0f0"], false)!;
    // Counted by gradient, not by comma: a gradient carries its own commas.
    expect(two.backgroundImage.match(/linear-gradient/g)).toHaveLength(2);
    expect(two.backgroundPosition).toBe(`left 0 bottom ${BAND_PITCH}px,left 0 bottom 0px`);
    expect(two.paddingBottom).toBe(`${BAND_PITCH + BAND_H}px`);
  });

  it("puts the innermost band nearest the text", () => {
    const three = bandStyle(["#a", "#b", "#c"], false)!;
    const offsets = three.backgroundPosition
      .split(",")
      .map((p) => Number(p.match(/bottom (\d+)px/)![1]));
    expect(offsets).toEqual([BAND_PITCH * 2, BAND_PITCH, 0]);
  });

  it("says the same thing as a style attribute, for HTML built as a string", () => {
    // The prose renderer builds markup as text; the word editor assigns to an
    // element. Same rule, two call shapes.
    const attr = bandStyleAttribute(["#f59e0b"], false);
    const obj = bandStyle(["#f59e0b"], false)!;
    expect(attr).toContain(`background-image:${obj.backgroundImage}`);
    expect(attr).toContain(`padding-bottom:${obj.paddingBottom}`);
  });
});
