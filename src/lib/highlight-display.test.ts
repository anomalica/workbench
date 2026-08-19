/**
 * The highlight-loudness switch: quiet by default, and remembered.
 */

import { beforeEach, expect, it } from "vitest";

beforeEach(() => {
  localStorage.clear();
  // The store reads storage once, at module load.
  return import("./highlight-display.svelte").then(() => {});
});

it("starts quiet, because most of the time a highlight only has to be present", async () => {
  const { highlightDisplay } = await import("./highlight-display.svelte");
  expect(highlightDisplay.subtle).toBe(true);
});

it("remembers a reviewer who asked for colours", async () => {
  const { highlightDisplay } = await import("./highlight-display.svelte");
  const before = highlightDisplay.subtle;
  highlightDisplay.toggle();
  expect(highlightDisplay.subtle).toBe(!before);
  expect(localStorage.getItem("workbench:highlights")).toBe(
    highlightDisplay.subtle ? "subtle" : "colour",
  );
  // Back again, so the toggle is a switch rather than a one-way door.
  highlightDisplay.toggle();
  expect(highlightDisplay.subtle).toBe(before);
});
