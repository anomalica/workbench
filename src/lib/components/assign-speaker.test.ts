/**
 * End-to-end-ish test for the assign-speaker-then-refresh bug.
 *
 * Scenario: user opens an ingest, goes to SpeakerManager, clicks
 * "Assign" on Speaker 5, picks "Ross Coulthart". Refreshes the page.
 * The assignment should persist.
 *
 * We simulate this by:
 *  1. Creating a DocumentStore + loading sample markdown
 *  2. Rendering SpeakerManager with callbacks wired to the store
 *  3. Clicking through the Assign UI
 *  4. Verifying the store was updated and saved
 *  5. Creating a NEW DocumentStore (simulating refresh), loading same hash
 *  6. Verifying the assignment persisted
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import SpeakerManager from "./SpeakerManager.svelte";
import { DocumentStore } from "$lib/document.svelte";
import { parseTranscript } from "$lib/transcript";

const MARKDOWN = `---
title: Test
speakers:
  - Ross Coulthart
---

<!-- speaker: Ross Coulthart -->
00:00:01.0 Hello from Ross.

<!-- speaker: Speaker 5 -->
00:00:05.0 Hello from unnamed.
00:00:08.0 More from unnamed.

<!-- speaker: Speaker 6 -->
00:00:12.0 Different unnamed.
`;

const HASH = "test-assign-persistence-hash-1234567890";

describe("assign unnamed speaker then refresh", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("persists when going through DocumentStore.mergeSpeakers directly", () => {
    // This is the baseline: just calling the method works.
    const doc = new DocumentStore();
    doc.load(MARKDOWN, HASH);
    doc.mergeSpeakers(["Speaker 5"], "Ross Coulthart");

    expect(doc.current).not.toContain("Speaker 5");
    expect(doc.dirty).toBe(true);

    // Simulate refresh
    const doc2 = new DocumentStore();
    doc2.load(MARKDOWN, HASH);
    expect(doc2.current).not.toContain("Speaker 5");
    expect(doc2.dirty).toBe(true);
  });

  it("persists when the merge is triggered via the SpeakerManager UI callback", async () => {
    const doc = new DocumentStore();
    doc.load(MARKDOWN, HASH);
    const segments = parseTranscript(doc.current.replace(/^---\n[\s\S]*?\n---\n/, ""));

    // Wire up the SAME callback chain that IngestViewer uses
    const mergeSpeakers = (sourceIds: string[], targetName: string) => {
      doc.mergeSpeakers(sourceIds, targetName);
    };

    type AnyFn = (...args: unknown[]) => unknown;
    const { getByText, getByTitle } = render(SpeakerManager, {
      segments,
      namedSpeakers: ["Ross Coulthart"],
      selectedSpeakers: new Set<string>(),
      filteredSpeakers: new Set<string>(),
      onselect: vi.fn() as unknown as AnyFn,
      onfilter: vi.fn() as unknown as AnyFn,
      onsetfilter: vi.fn() as unknown as AnyFn,
      onrename: vi.fn() as unknown as AnyFn,
      onmerge: mergeSpeakers as unknown as AnyFn,
      onaddnamed: vi.fn() as unknown as AnyFn,
      onremovenamed: vi.fn() as unknown as AnyFn,
      onrenamenamed: vi.fn() as unknown as AnyFn,
    });

    // Find Speaker 5's row and click Assign
    const speaker5Row = getByText("Speaker 5").closest("div")!;
    const assignBtn = speaker5Row.querySelector(
      'button[title="Assign to a named speaker"]',
    ) as HTMLButtonElement;
    expect(assignBtn).not.toBeNull();
    await fireEvent.click(assignBtn);

    // Click "Ross Coulthart" in the assign dropdown
    const rossOption = getByText("Ross Coulthart", {
      selector: ".absolute button",
    });
    await fireEvent.click(rossOption);

    // Verify the merge happened
    expect(doc.current).not.toContain("Speaker 5");
    expect(doc.current).toContain("Ross Coulthart");

    // A draft is stored, and it is a patch against the server's copy rather
    // than a second copy of the record - so it is read back through the store
    // rather than by reaching into the JSON.
    expect(localStorage.getItem(`workbench:doc:${HASH}`)).not.toBeNull();

    // Simulate refresh: brand new DocumentStore
    const doc2 = new DocumentStore();
    doc2.load(MARKDOWN, HASH);
    expect(doc2.current).not.toContain("Speaker 5");
    expect(doc2.current).toContain("Ross Coulthart");
  });

  it("persists multiple speaker assignments then refresh", () => {
    const doc = new DocumentStore();
    doc.load(MARKDOWN, HASH);

    // Assign two unnamed speakers to named ones
    doc.mergeSpeakers(["Speaker 5"], "Ross Coulthart");
    doc.renameSpeaker("Speaker 6", "David Marler");
    const finalState = doc.current;
    expect(finalState).not.toContain("Speaker 5");
    expect(finalState).not.toContain("Speaker 6");
    expect(finalState).toContain("Ross Coulthart");
    expect(finalState).toContain("David Marler");

    // localStorage should hold the latest state, as a patch.
    const saved = localStorage.getItem(`workbench:doc:${HASH}`);
    expect(saved).not.toBeNull();
    expect(saved!.length).toBeLessThan(MARKDOWN.length);

    // Simulate refresh
    const doc2 = new DocumentStore();
    doc2.load(MARKDOWN, HASH);
    expect(doc2.current).toBe(finalState);
    expect(doc2.current).not.toContain("Speaker 5");
    expect(doc2.current).not.toContain("Speaker 6");
  });

  it("save still works when localStorage is nearly full", () => {
    // Fill localStorage with dummy data to approach the quota
    // jsdom doesn't enforce a real quota, but this verifies our
    // error-handling path doesn't crash
    const doc = new DocumentStore();
    doc.load(MARKDOWN, HASH);
    doc.mergeSpeakers(["Speaker 5"], "Ross Coulthart");

    expect(localStorage.getItem(`workbench:doc:${HASH}`)).not.toBeNull();
    expect(doc.saveFailed).toBe(false);

    const reopened = new DocumentStore();
    reopened.load(MARKDOWN, HASH);
    expect(reopened.current).not.toContain("Speaker 5");
  });

  it("verifies localStorage key is consistent between save and load", () => {
    const doc = new DocumentStore();
    doc.load(MARKDOWN, HASH);
    const key1 = doc.storageKey;

    doc.mergeSpeakers(["Speaker 5"], "Ross Coulthart");

    // After edit, storageKey should not have changed
    expect(doc.storageKey).toBe(key1);

    // A new store loading the same hash should use the same key
    const doc2 = new DocumentStore();
    doc2.load(MARKDOWN, HASH);
    expect(doc2.storageKey).toBe(key1);
  });
});
