import { describe, it, expect, beforeEach } from "vitest";
import { DocumentStore } from "./document.svelte";

const SAMPLE_MARKDOWN = `---
title: Test Ingest
speakers:
  - Ross Coulthart
---

<!-- speaker: Speaker 5 -->
00:00:01.0 Hello from an unnamed speaker.

<!-- speaker: Ross Coulthart -->
00:00:05.0 Hello from Ross.

<!-- speaker: Speaker 5 -->
00:00:10.0 Unnamed again, same person.

<!-- speaker: Speaker 6 -->
00:00:15.0 A different unnamed speaker.
`;

const HASH = "deadbeefcafebabe1234567890abcdef";

describe("DocumentStore - persistence across simulated refresh", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("restores current state after a new DocumentStore loads the same ingest", () => {
    // First 'session': user opens the ingest and reassigns Speaker 5 -> Ross Coulthart
    const doc1 = new DocumentStore();
    doc1.load(SAMPLE_MARKDOWN, HASH);
    expect(doc1.current).toContain("Speaker 5");

    doc1.mergeSpeakers(["Speaker 5"], "Ross Coulthart");

    // The edit should be reflected immediately
    const afterEdit = doc1.current;
    expect(afterEdit).not.toContain("Speaker 5");
    expect(afterEdit).toContain("Ross Coulthart");
    // Speaker 6 remains untouched
    expect(afterEdit).toContain("Speaker 6");

    // Simulated refresh: a fresh DocumentStore loads the same pristine markdown
    const doc2 = new DocumentStore();
    doc2.load(SAMPLE_MARKDOWN, HASH);

    // The reassignment should persist
    expect(doc2.current).toBe(afterEdit);
    expect(doc2.current).not.toContain("Speaker 5");
    expect(doc2.current).toContain("Ross Coulthart");
  });

  it("restores undo history after refresh so changes can be undone", () => {
    const doc1 = new DocumentStore();
    doc1.load(SAMPLE_MARKDOWN, HASH);
    doc1.mergeSpeakers(["Speaker 5"], "Ross Coulthart");

    // After refresh, user should still be able to undo
    const doc2 = new DocumentStore();
    doc2.load(SAMPLE_MARKDOWN, HASH);
    expect(doc2.canUndo).toBe(true);
    doc2.undo();
    expect(doc2.current).toContain("Speaker 5");
  });

  it("does not reset state when load is called a second time with the same hash", () => {
    // This catches regressions where effects re-running in the component
    // would call load() again and wipe the restored edits.
    const doc = new DocumentStore();
    doc.load(SAMPLE_MARKDOWN, HASH);
    doc.mergeSpeakers(["Speaker 5"], "Ross Coulthart");
    const afterEdit = doc.current;

    // Call load again with the same inputs - should be a no-op in terms of state
    doc.load(SAMPLE_MARKDOWN, HASH);
    expect(doc.current).toBe(afterEdit);
  });

  it("persists multiple sequential edits across refresh", () => {
    const doc1 = new DocumentStore();
    doc1.load(SAMPLE_MARKDOWN, HASH);
    doc1.mergeSpeakers(["Speaker 5"], "Ross Coulthart");
    doc1.renameSpeaker("Speaker 6", "David Marler");
    const afterEdits = doc1.current;

    const doc2 = new DocumentStore();
    doc2.load(SAMPLE_MARKDOWN, HASH);
    expect(doc2.current).toBe(afterEdits);
    expect(doc2.current).toContain("David Marler");
    expect(doc2.current).toContain("Ross Coulthart");
    expect(doc2.current).not.toContain("Speaker 5");
    expect(doc2.current).not.toContain("Speaker 6");
  });

  it("does not revert edits if load() is called again mid-session", () => {
    // This simulates the $effect in IngestViewer re-firing for any reason.
    // Previously: without a guard, load() would re-read localStorage and
    // potentially stomp over unsaved in-memory state during a reactive cascade.
    const doc = new DocumentStore();
    doc.load(SAMPLE_MARKDOWN, HASH);

    doc.mergeSpeakers(["Speaker 5"], "Ross Coulthart");
    const afterFirstEdit = doc.current;
    // Unsolicited re-load during the session
    doc.load(SAMPLE_MARKDOWN, HASH);
    expect(doc.current).toBe(afterFirstEdit);

    doc.renameSpeaker("Speaker 6", "David Marler");
    const afterSecondEdit = doc.current;
    doc.load(SAMPLE_MARKDOWN, HASH);
    expect(doc.current).toBe(afterSecondEdit);

    // And after a real 'refresh'
    const doc2 = new DocumentStore();
    doc2.load(SAMPLE_MARKDOWN, HASH);
    expect(doc2.current).toBe(afterSecondEdit);
  });

  it("persists edits when many rapid-fire changes happen", () => {
    // Simulates user rapid-clicking speaker reassignments.
    const doc = new DocumentStore();
    doc.load(SAMPLE_MARKDOWN, HASH);

    // A chain of edits - each should be saved
    doc.renameSpeaker("Speaker 5", "A");
    doc.renameSpeaker("A", "B");
    doc.renameSpeaker("B", "Ross Coulthart");
    const finalState = doc.current;

    // Refresh
    const doc2 = new DocumentStore();
    doc2.load(SAMPLE_MARKDOWN, HASH);
    expect(doc2.current).toBe(finalState);
    expect(doc2.current).not.toContain("Speaker 5");
    expect(doc2.current).not.toContain('"A"');
    expect(doc2.current).not.toContain('"B"');
  });

  it("uses a per-ingest storage key so different ingests don't cross-contaminate", () => {
    const docA = new DocumentStore();
    docA.load(SAMPLE_MARKDOWN, HASH);
    docA.mergeSpeakers(["Speaker 5"], "Ross Coulthart");

    const OTHER_HASH = "0000000000000000000000000000000000";
    const docB = new DocumentStore();
    docB.load(SAMPLE_MARKDOWN, OTHER_HASH);
    // Different hash = fresh state, no restore of docA's edits
    expect(docB.current).toContain("Speaker 5");
  });
});
