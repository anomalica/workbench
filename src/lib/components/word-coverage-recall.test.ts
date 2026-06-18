/**
 * Regression test for the word/video coverage RECALL bug.
 *
 * Recording worked (the verdict + word-index spans persist to the server
 * sidecar), but WordTranscript restored its observed set from localStorage
 * ONLY - and submit clears that draft. So reopening a submitted record (or any
 * fresh session) showed nothing observed: "my review looks lost".
 *
 * The fix feeds the server-submitted coverage down as `serverObserved` and
 * unions it into the observed set. This test mounts WordTranscript with an
 * EMPTY localStorage (the post-submit state) and serverObserved set, and
 * asserts the coverage verdict reflects the server words - i.e. recall works
 * from the server, not just the local cache.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/svelte";
import WordTranscript from "./WordTranscript.svelte";

// 5 words (gIndex 0..4) under one speaker.
const BODY =
  "<!-- speaker: Speaker 1 -->\n" +
  "00:00:01.0 {{t:1.00}}One {{t:1.50}}two {{t:2.00}}three {{t:2.50}}four {{t:3.00}}five.\n";

type Verdict = {
  spans: { from: number; to: number }[];
  observed_coverage: number;
  digestible: boolean;
  total_units: number;
};

function mount(serverObserved: number[], onverdict: (v: Verdict) => void) {
  return render(WordTranscript, {
    props: {
      body: BODY,
      storageKey: "workbench:observed:recall-test",
      serverObserved,
      onreassign: () => {},
      onedit: () => {},
      onsettime: () => {},
      onverdict,
    },
  });
}

describe("word coverage recall from the server", () => {
  beforeEach(() => localStorage.clear());

  it("restores submitted coverage with an empty localStorage draft", async () => {
    let verdict: Verdict | null = null;
    mount([0, 1, 2], (v) => {
      verdict = v;
    });
    await waitFor(() => {
      expect(verdict).not.toBeNull();
      // 3 of 5 words observed, sourced purely from serverObserved.
      expect((verdict as unknown as Verdict).observed_coverage).toBeCloseTo(3 / 5, 5);
      expect((verdict as unknown as Verdict).spans).toEqual([{ from: 0, to: 2 }]);
    });
  });

  it("reports zero coverage when neither localStorage nor server has anything", async () => {
    let verdict: Verdict | null = null;
    mount([], (v) => {
      verdict = v;
    });
    await waitFor(() => {
      expect(verdict).not.toBeNull();
      expect((verdict as unknown as Verdict).observed_coverage).toBe(0);
    });
  });
});
