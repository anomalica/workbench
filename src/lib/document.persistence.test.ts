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

describe("what a draft costs in the browser", () => {
  const BOOK = `---\ntitle: A Book\n---\n\n${Array.from(
    { length: 20_000 },
    (_, i) => `00:00:0${i % 9}.0 Line ${i} of an ordinary paragraph of prose.`,
  ).join("\n")}\n`;
  const BOOK_HASH = "b00c0ffee0000000000000000000000000";

  const stored = (hash: string) => localStorage.getItem(`workbench:doc:${hash}`)?.length ?? 0;

  beforeEach(() => {
    localStorage.clear();
  });

  it("stores the difference, not another copy of the book", () => {
    // The reported failure: one edit in a 780KB book wrote 780KB, and the next
    // book found the ~5MB origin quota already gone - "your last edit could NOT
    // be saved in this browser".
    const doc = new DocumentStore();
    doc.load(BOOK, BOOK_HASH);
    doc.editBody(doc.current.replace("Line 9000 of", "Line 9000 [irrelevant] of"));

    expect(BOOK.length).toBeGreaterThan(700_000);
    expect(stored(BOOK_HASH)).toBeGreaterThan(0);
    expect(stored(BOOK_HASH)).toBeLessThan(2_000);
  });

  it("restores that edit exactly on the next load", () => {
    const doc = new DocumentStore();
    doc.load(BOOK, BOOK_HASH);
    doc.editBody(doc.current.replace("Line 9000 of", "Line 9000 [irrelevant] of"));
    const edited = doc.current;

    const reopened = new DocumentStore();
    reopened.load(BOOK, BOOK_HASH);
    expect(reopened.current).toBe(edited);
  });

  it("removes the key once the browser matches the server again", () => {
    // Mark's point: after a submit - or an undo back to the start - there is
    // nothing left to protect, so the draft should not sit there holding quota.
    const doc = new DocumentStore();
    doc.load(BOOK, BOOK_HASH);
    doc.editBody(doc.current.replace("Line 5 of", "Line 5 [irrelevant] of"));
    expect(stored(BOOK_HASH)).toBeGreaterThan(0);

    doc.undo();
    expect(doc.current).toBe(BOOK);
    expect(localStorage.getItem(`workbench:doc:${BOOK_HASH}`)).toBeNull();
  });

  it("still restores a draft written before drafts were patches", () => {
    // Someone's unsaved work from the previous format is not forfeit.
    const legacy = SAMPLE_MARKDOWN.replace("Speaker 5", "Ross Coulthart");
    localStorage.setItem(
      `workbench:doc:${HASH}`,
      JSON.stringify({ current: legacy, past: [SAMPLE_MARKDOWN], future: [] }),
    );
    const before = localStorage.getItem(`workbench:doc:${HASH}`)!.length;
    const doc = new DocumentStore();
    doc.load(SAMPLE_MARKDOWN, HASH);
    expect(doc.current).toBe(legacy);
    expect(doc.canUndo).toBe(true);
    // Rewritten as a patch on sight - the quota is filled by drafts for the
    // records the reviewer is NOT currently editing.
    expect(localStorage.getItem(`workbench:doc:${HASH}`)!.length).toBeLessThan(before);
  });

  it("drops a draft whose record has changed underneath it", () => {
    const doc = new DocumentStore();
    doc.load(BOOK, BOOK_HASH);
    doc.editBody(doc.current.replace("Line 5 of", "Line 5 [irrelevant] of"));

    const reingested = `${BOOK}\nAn extra line the ingester added later.\n`;
    const reopened = new DocumentStore();
    reopened.load(reingested, BOOK_HASH);
    expect(reopened.current).toBe(reingested);
    expect(localStorage.getItem(`workbench:doc:${BOOK_HASH}`)).toBeNull();
  });
});

describe("a speaker introduced with where they are from", () => {
  // `Scott Gordon [KXAS]` is a reporter and his station. The station reads with
  // the line; the person is what the record stores and what another record
  // reuses. A stored name carrying the station would make a second Scott Gordon
  // the next time he files for somebody else.
  const QUALIFIED = `---
title: Test Ingest
speakers:
  - India Naftali
---

<!-- speaker: India Naftali -->
00:00:01.0 Over to our reporter.

<!-- speaker: Scott Gordon [KXAS] -->
00:00:05.0 Thanks, I am at the scene.
`;

  beforeEach(() => {
    localStorage.clear();
  });

  it("stores the person, not the station", () => {
    const doc = new DocumentStore();
    doc.load(QUALIFIED, HASH);
    doc.updateFrontmatterSpeakers(["India Naftali", "Scott Gordon [KXAS]"]);

    const [fm] = [doc.current.slice(0, doc.current.indexOf("---", 4))];
    expect(fm).toContain("- Scott Gordon\n");
    expect(fm).not.toContain("KXAS");
    // The body keeps the label as written: that is where the station belongs.
    expect(doc.current).toContain("<!-- speaker: Scott Gordon [KXAS] -->");
  });

  it("does not list one person twice for two stations", () => {
    const doc = new DocumentStore();
    doc.load(QUALIFIED, HASH);
    doc.updateFrontmatterSpeakers(["Scott Gordon [KXAS]", "Scott Gordon [NBC]"]);
    const fm = doc.current.slice(0, doc.current.indexOf("---", 4));
    expect(fm.match(/- Scott Gordon/g)).toHaveLength(1);
  });

  it("leaves a described speaker exactly as it is", () => {
    const doc = new DocumentStore();
    doc.load(QUALIFIED, HASH);
    doc.updateFrontmatterSpeakers(["[audience member]"]);
    expect(doc.current).toContain('- "[audience member]"');
  });
});
