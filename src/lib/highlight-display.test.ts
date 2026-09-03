/**
 * How loudly other people's highlights are drawn: hidden, a hairline, or the
 * palette. Quiet by default, remembered, and never a one-way door.
 */

import { beforeEach, expect, it } from "vitest";

beforeEach(() => {
  localStorage.clear();
  // The store reads storage once, at module load.
  return import("./highlight-display.svelte").then(() => {});
});

it("starts quiet, because most of the time a highlight only has to be present", async () => {
  const { highlightDisplay } = await import("./highlight-display.svelte");
  expect(highlightDisplay.mode).toBe("minimal");
  expect(highlightDisplay.subtle).toBe(true);
  expect(highlightDisplay.shown).toBe(true);
});

it("steps off, hairline, colours and round again", async () => {
  const { highlightDisplay } = await import("./highlight-display.svelte");
  highlightDisplay.set("minimal");

  highlightDisplay.cycle();
  expect(highlightDisplay.mode).toBe("full");
  highlightDisplay.cycle();
  // Hidden is a state somebody has to be able to leave as easily as enter.
  expect(highlightDisplay.mode).toBe("off");
  highlightDisplay.cycle();
  expect(highlightDisplay.mode).toBe("minimal");
});

it("hidden draws nothing while the markup stays in the document", async () => {
  const { highlightDisplay } = await import("./highlight-display.svelte");
  highlightDisplay.set("off");
  expect(highlightDisplay.shown).toBe(false);
  // Not "subtle either": off is its own answer, and a caller that treated a
  // false `subtle` as "so paint the colours" would show the loudest state to
  // the reader who asked for none.
  expect(highlightDisplay.subtle).toBe(false);
});

it("remembers the choice", async () => {
  const { highlightDisplay } = await import("./highlight-display.svelte");
  highlightDisplay.set("off");
  expect(localStorage.getItem("workbench:highlights")).toBe("off");
  highlightDisplay.set("full");
  expect(localStorage.getItem("workbench:highlights")).toBe("full");
});

it("reads what the two-state switch wrote", async () => {
  // Being reset to the default by an upgrade is a small thing done to somebody,
  // and avoidable: "colour" and "subtle" are what the old switch stored.
  const { modeFromStored } = await import("./highlight-display.svelte");
  expect(modeFromStored("colour")).toBe("full");
  expect(modeFromStored("subtle")).toBe("minimal");
  expect(modeFromStored("off")).toBe("off");
  expect(modeFromStored("full")).toBe("full");
  // Nothing stored, or something nobody wrote, is the reading default.
  expect(modeFromStored(null)).toBe("minimal");
  expect(modeFromStored("wombat")).toBe("minimal");
});
