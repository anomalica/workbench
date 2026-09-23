import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import WordTranscript from "./WordTranscript.svelte";

const body = `<!-- speaker: Lynn Blue Cannon -->
{{t:0}}before {{t:1}}again
<!-- speaker: Jesse Michaels -->
{{t:2}}one {{t:3}}two {{t:4}}three {{t:5}}four {{t:6}}five
<!-- speaker: Dana Green -->
{{t:7}}after {{t:8}}again`;

const word = (index: number) => document.querySelector<HTMLElement>(`[data-word-index="${index}"]`)!;

async function select(index: number) {
  await fireEvent.pointerDown(word(index), { button: 0, clientX: 100, clientY: 100 });
  await fireEvent.pointerUp(window, { button: 0, clientX: 100, clientY: 100 });
}

describe("nearby speaker shortcut", () => {
  it.each([
    [2, "Lynn Blue Cannon"], // start of a turn
    [4, "Lynn Blue Cannon"], // midpoint favours the previous speaker
    [5, "Dana Green"], // end of a turn
    [0, "Jesse Michaels"], // no previous turn
    [8, "Jesse Michaels"], // no next turn
  ])("offers %s as a one-click reassignment to %s", async (index, speaker) => {
    const onreassign = vi.fn();
    render(WordTranscript, { body, onreassign });

    await select(index as number);
    const quick = screen.getByRole("button", { name: `Assign to nearby speaker ${speaker}` });
    expect(quick.querySelector("[data-speaker]")?.getAttribute("data-speaker")).toBe(speaker);
    await fireEvent.click(quick);

    expect(onreassign).toHaveBeenCalledExactlyOnceWith(index, index, speaker);
    expect(screen.queryByRole("button", { name: `Assign to nearby speaker ${speaker}` })).toBeNull();
  });

  it("offers no shortcut when there is no other speaker or selection spans turns", async () => {
    const { unmount } = render(WordTranscript, {
      body: "<!-- speaker: Jesse Michaels -->\n{{t:0}}one {{t:1}}two",
      onreassign: vi.fn(),
    });
    await select(0);
    expect(screen.queryByRole("button", { name: /Assign to nearby speaker/ })).toBeNull();
    unmount();

    render(WordTranscript, { body, onreassign: vi.fn() });
    await fireEvent.pointerDown(word(1), { button: 0, clientX: 100, clientY: 100 });
    await fireEvent.pointerOver(word(2), { clientX: 180, clientY: 100 });
    await fireEvent.pointerUp(window, { button: 0, clientX: 180, clientY: 100 });
    expect(screen.queryByRole("button", { name: /Assign to nearby speaker/ })).toBeNull();
  });
});
