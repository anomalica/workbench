/**
 * Regression tests for word/video coverage recall + its interaction with the
 * live playback highlight.
 *
 * 1. RECALL: submitting persists coverage server-side, but WordTranscript used
 *    to restore `observed` from localStorage only - and submit clears that
 *    draft - so a reopened record showed nothing observed. Server coverage is
 *    now fed in as `serverObserved` and merged into the observed set.
 *
 * 2. The merge must NOT clobber: when the async server coverage arrives it is
 *    ADDED to the observed set, never rebuilt/replaced, so session auto-observe
 *    marks and the playback cursor survive.
 *
 * 3. The amber active-word highlight is driven purely by currentTime, never by
 *    coverage - changing the observed set must not move it.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/svelte";
import WordTranscript from "./WordTranscript.svelte";

// 5 words (gIndex 0..4) at t = 1.0, 1.5, 2.0, 2.5, 3.0.
const BODY =
  "<!-- speaker: Speaker 1 -->\n" +
  "00:00:01.0 {{t:1.00}}One {{t:1.50}}two {{t:2.00}}three {{t:2.50}}four {{t:3.00}}five.\n";

type Verdict = {
  spans: { from: number; to: number }[];
  observed_coverage: number;
  digestible: boolean;
  total_units: number;
};

function props(currentTime: number, serverObserved: number[], onverdict?: (v: Verdict) => void) {
  return {
    body: BODY,
    storageKey: "workbench:observed:recall-test",
    serverObserved,
    currentTime,
    onreassign: () => {},
    onedit: () => {},
    onsettime: () => {},
    onverdict,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 30));
const amberIndex = () => {
  const el = [...document.querySelectorAll<HTMLElement>("[data-word-index]")].find((e) =>
    /amber/.test(e.className),
  );
  return el ? Number(el.dataset.wordIndex) : -1;
};
const observedFromVerdict = (v: Verdict | null) =>
  new Set(
    (v?.spans ?? []).flatMap((s) =>
      Array.from({ length: s.to - s.from + 1 }, (_, i) => s.from + i),
    ),
  );

describe("word coverage recall + playback highlight", () => {
  beforeEach(() => {
    localStorage.clear();
    // jsdom implements neither; the follow-scroll/highlight path calls them.
    Element.prototype.scrollTo = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("restores submitted coverage with an empty localStorage draft", async () => {
    let verdict: Verdict | null = null;
    render(WordTranscript, {
      props: props(0, [0, 1, 2], (v) => {
        verdict = v;
      }),
    });
    await waitFor(() => {
      expect((verdict as unknown as Verdict).observed_coverage).toBeCloseTo(3 / 5, 5);
      expect((verdict as unknown as Verdict).spans).toEqual([{ from: 0, to: 2 }]);
    });
  });

  it("reports zero coverage when neither localStorage nor server has anything", async () => {
    let verdict: Verdict | null = null;
    render(WordTranscript, {
      props: props(0, [], (v) => {
        verdict = v;
      }),
    });
    await waitFor(() => expect((verdict as unknown as Verdict).observed_coverage).toBe(0));
  });

  it("the amber active-word highlight follows currentTime, not coverage", async () => {
    const { rerender } = render(WordTranscript, { props: props(1.6, []) });
    await tick();
    expect(amberIndex()).toBe(1); // word at t=1.5 is active at 1.6s
    // Change the coverage set without touching currentTime - amber must not move.
    await rerender(props(1.6, [0, 2, 3, 4]));
    await tick();
    expect(amberIndex()).toBe(1);
  });

  it("server coverage arriving adds to - never replaces - the observed set", async () => {
    // Mount with one server set, then a different one lands; the union must
    // grow (additive merge), proving serverObserved is merged not rebuilt.
    let verdict: Verdict | null = null;
    const cb = (v: Verdict) => {
      verdict = v;
    };
    const { rerender } = render(WordTranscript, { props: props(0, [1, 2], cb) });
    await waitFor(() => expect(observedFromVerdict(verdict).has(2)).toBe(true));
    await rerender(props(0, [4], cb));
    await waitFor(() => {
      const obs = observedFromVerdict(verdict);
      expect(obs.has(1)).toBe(true);
      expect(obs.has(2)).toBe(true);
      expect(obs.has(4)).toBe(true);
    });
  });

  it("survives a full localStorage: rendering and the amber cursor still work when setItem throws", async () => {
    // Regression: the observed-persist $effect called localStorage.setItem with
    // no try/catch. On a large record whose body draft had filled the quota the
    // throw aborted WordTranscript's effect graph and killed ALL per-word
    // highlighting - selection, amber cursor, marker. A full store must never
    // break the view. (jsdom's localStorage has no quota, so we force the throw.)
    const realSet = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      const e = new Error("quota") as Error & { name: string };
      e.name = "QuotaExceededError";
      throw e;
    };
    try {
      let verdict: Verdict | null = null;
      render(WordTranscript, {
        props: props(1.6, [0, 2, 3, 4], (v) => {
          verdict = v;
        }),
      });
      await tick();
      // The component rendered all its words despite the throwing persist.
      expect(document.querySelectorAll("[data-word-index]").length).toBe(5);
      // The amber active-word cursor still tracks currentTime (word at t=1.5).
      expect(amberIndex()).toBe(1);
      // Coverage still computes from the merged observed set.
      await waitFor(() =>
        expect((verdict as unknown as Verdict).observed_coverage).toBeGreaterThan(0),
      );
    } finally {
      Storage.prototype.setItem = realSet;
    }
  });

  it("restores a legacy flat-array observed draft and a new spans draft alike", async () => {
    // Old drafts were a flat [0,1,2] index array; new drafts are run-length
    // spans [[0,2]]. decodeObserved must read both so existing saves survive.
    for (const [label, raw] of [
      ["legacy flat array", "[0,1,2]"],
      ["compact spans", "[[0,2]]"],
    ] as const) {
      localStorage.clear();
      localStorage.setItem("workbench:observed:codec-test", raw);
      let verdict: Verdict | null = null;
      const { unmount } = render(WordTranscript, {
        props: {
          ...props(0, []),
          storageKey: "workbench:observed:codec-test",
          onverdict: (v: Verdict) => {
            verdict = v;
          },
        },
      });
      await waitFor(() => {
        expect((verdict as unknown as Verdict).spans, label).toEqual([{ from: 0, to: 2 }]);
      });
      unmount();
    }
  });

  it("Jump to unobserved marks the last OBSERVED word before the gap, leaving the target untouched", async () => {
    // Words 0,1,2 observed -> first unobserved is 3 -> marker belongs on word 2.
    let resumeSeconds = -1;
    const { getByRole } = render(WordTranscript, {
      props: {
        ...props(0, [0, 1, 2]),
        onmarkresume: (s: number) => {
          resumeSeconds = s;
        },
      },
    });
    await waitFor(() => expect(document.querySelector("[data-word-index]")).not.toBeNull());
    await fireEvent.click(getByRole("button", { name: "Jump to unobserved" }));
    await waitFor(() => {
      const marked = [...document.querySelectorAll<HTMLElement>("[data-word-index]")].find((e) =>
        /ring-sky/.test(e.className),
      );
      expect(marked).toBeTruthy();
      expect(Number(marked!.dataset.wordIndex)).toBe(2); // last observed, not the target (3)
    });
    // The first unobserved word (the review target) carries no marker.
    const target = document.querySelector<HTMLElement>('[data-word-index="3"]');
    expect(/ring-sky/.test(target!.className)).toBe(false);
    // Playback is positioned at the marker's timestamp (word 2 starts at 2.00s).
    expect(resumeSeconds).toBeCloseTo(2.0, 5);
  });
});
