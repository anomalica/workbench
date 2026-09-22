import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scrollAnchorKey } from "$lib/scroll-anchor";
import { parseWords } from "$lib/transcript-words";
import WordTranscript from "./WordTranscript.svelte";

const WORDS_PER_TURN = 20;
const TURN_COUNT = 255;
const WORD_COUNT = WORDS_PER_TURN * TURN_COUNT;
const DISTANT_WORD = 4_800;

function longBody(): string {
  const lines: string[] = [];
  for (let turn = 0; turn < TURN_COUNT; turn++) {
    lines.push(`<!-- speaker: Speaker ${(turn % 2) + 1} -->`);
    const tokens: string[] = [];
    for (let within = 0; within < WORDS_PER_TURN; within++) {
      const g = turn * WORDS_PER_TURN + within;
      const token = `{{t:${(g / 10).toFixed(1)}}}word-${g}`;
      tokens.push(g === DISTANT_WORD ? `{{highlight-start: distant}}${token}{{highlight-end: distant}}` : token);
    }
    lines.push(tokens.join(" "));
  }
  return lines.join("\n");
}

const BODY = longBody();
const PARSED = parseWords(BODY);
const word = (g: number) => document.querySelector<HTMLElement>(`[data-word-index="${g}"]`);
const mountedWords = () => document.querySelectorAll("[data-word-index]").length;

function props(over: Record<string, unknown> = {}) {
  return {
    body: BODY,
    parsedWords: PARSED,
    storageKey: "workbench:observed:virtualisation-test",
    currentTime: 0,
    serverObserved: [],
    onreassign: () => {},
    ...over,
  };
}

describe("long word transcript virtualisation", () => {
  beforeEach(() => {
    localStorage.clear();
    Element.prototype.scrollTo = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("keeps a bounded block window and mounts a distant observed-only focus with every style", async () => {
    const observed = Array.from({ length: TURN_COUNT }, (_, turn) => turn * WORDS_PER_TURN);
    const base = props({ showObservedOnly: true, serverObserved: observed });
    const { rerender } = render(WordTranscript, { props: base });

    await waitFor(() => expect(mountedWords()).toBeGreaterThan(0));
    expect(mountedWords()).toBeLessThan(100);
    expect(word(DISTANT_WORD)).toBeNull();

    await rerender({
      ...base,
      focusWords: { from: DISTANT_WORD, to: DISTANT_WORD, seq: 1 },
      claimHighlight: {
        start: PARSED.words[DISTANT_WORD].start,
        end: PARSED.words[DISTANT_WORD].start,
        seq: 1,
      },
    });

    await waitFor(() => expect(word(DISTANT_WORD)).not.toBeNull());
    expect(mountedWords()).toBeLessThan(100);
    expect(word(DISTANT_WORD)).toHaveClass(
      "wt-observed",
      "wt-markup-focus",
      "wt-claim",
      "wt-highlight",
    );
    expect(word(DISTANT_WORD)?.style.backgroundImage).not.toBe("");
    expect(word(0)).toBeNull();
  });

  it("mounts at least a viewport of content on initial load", async () => {
    const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    try {
      render(WordTranscript, { props: props() });

      await waitFor(() => expect(mountedWords()).toBeGreaterThanOrEqual(WORDS_PER_TURN * 7));
      expect(mountedWords()).toBeLessThan(400);
    } finally {
      clientHeight.mockRestore();
    }
  });

  it("retains an unaffected mounted block across an earlier structural edit", async () => {
    const focusWords = { from: DISTANT_WORD, to: DISTANT_WORD, seq: 1 };
    const { rerender } = render(WordTranscript, { props: props({ focusWords }) });
    await waitFor(() => expect(word(DISTANT_WORD)).not.toBeNull());
    const before = word(DISTANT_WORD)!.closest<HTMLElement>("[data-virtual-block]");

    const editedBody = BODY.replace(
      "{{t:0.0}}word-0",
      "{{t:0.0}}inserted {{t:0.05}}word-0",
    );
    await rerender({
      ...props({
        body: editedBody,
        parsedWords: parseWords(editedBody),
        focusWords: { from: DISTANT_WORD + 1, to: DISTANT_WORD + 1, seq: 2 },
      }),
    });

    await waitFor(() => expect(word(DISTANT_WORD + 1)?.textContent).toBe(`word-${DISTANT_WORD}`));
    const after = word(DISTANT_WORD + 1)!.closest<HTMLElement>("[data-virtual-block]");
    expect(after).toBe(before);
  });

  it("mounts a saved distant scroll anchor before restoring it", async () => {
    localStorage.setItem(scrollAnchorKey("virtual-record"), String(DISTANT_WORD));
    render(WordTranscript, { props: props({ recordHash: "virtual-record" }) });

    await waitFor(() => expect(word(DISTANT_WORD)).not.toBeNull());
    expect(mountedWords()).toBeLessThan(400);
  });

  it("moves the mounted window with the viewport", async () => {
    render(WordTranscript, { props: props() });
    const scroller = document.querySelector<HTMLElement>("[data-scroll-sync]")!;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 600 });
    scroller.scrollTop = (DISTANT_WORD / WORDS_PER_TURN) * 104;
    await fireEvent.scroll(scroller);

    await waitFor(() => expect(word(DISTANT_WORD)).not.toBeNull());
    expect(word(0)).toBeNull();
    expect(mountedWords()).toBeGreaterThanOrEqual(WORDS_PER_TURN * 12);
    expect(mountedWords()).toBeLessThan(400);
  });

  it("leaves enough trailing space to lift the final blocks above the viewport edge", () => {
    render(WordTranscript, { props: props() });

    expect(document.querySelector("[data-scroll-sync] > div")).toHaveClass("pb-[50vh]");
  });

  it("mounts the resume boundary for Jump to unobserved", async () => {
    const onmarkresume = vi.fn();
    render(WordTranscript, {
      props: props({
        serverObserved: Array.from({ length: DISTANT_WORD }, (_, g) => g),
        onmarkresume,
      }),
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Jump to unobserved" })).toBeTruthy());
    expect(word(DISTANT_WORD - 1)).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Jump to unobserved" }));

    await waitFor(() => expect(word(DISTANT_WORD - 1)).toHaveClass("wt-resume", "wt-observed"));
    expect(onmarkresume).toHaveBeenCalledWith(PARSED.words[DISTANT_WORD - 1].start);
    expect(mountedWords()).toBeLessThan(400);
  });

  it("mounts the active playback word before following it", async () => {
    const before = PARSED.words[DISTANT_WORD - 1].start;
    const at = PARSED.words[DISTANT_WORD].start;
    const { rerender } = render(WordTranscript, { props: props() });
    await waitFor(() => expect(mountedWords()).toBeGreaterThan(0));

    await rerender(props({ currentTime: before }));
    await rerender(props({ currentTime: at }));

    await waitFor(() => expect(word(DISTANT_WORD)).toHaveClass("wt-active"));
    expect(mountedWords()).toBeLessThan(400);
  });

  it("leaves short records fully mounted", async () => {
    const body = "<!-- speaker: Speaker 1 -->\n{{t:0}}one {{t:1}}two {{t:2}}three";
    render(WordTranscript, { props: { ...props(), body, parsedWords: parseWords(body) } });
    await waitFor(() => expect(mountedWords()).toBe(3));
    expect(document.querySelector("[data-virtual-spacer]")).toBeNull();
  });

  it("uses the complete 5,100-word model for coverage while mounting only nearby blocks", async () => {
    let total = 0;
    render(WordTranscript, {
      props: props({
        onverdict: (verdict: { total_units: number }) => {
          total = verdict.total_units;
        },
      }),
    });
    await waitFor(() => expect(total).toBe(WORD_COUNT));
    expect(mountedWords()).toBeLessThan(400);
  });
});
