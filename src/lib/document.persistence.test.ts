import { describe, it, expect, beforeEach, vi } from "vitest";
import yaml from "js-yaml";
import { DocumentStore } from "./document.svelte";
import { parseWords } from "./transcript-words";
import { decodePatch, patchSize } from "./draft-patch";

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
    // And it is durably written, which the status bar reports as "saved <time>".
    expect(doc1.lastSavedAt).not.toBeNull();
    expect(doc1.lastSavedAt!).toBeLessThanOrEqual(Date.now());

    // Simulated refresh: a fresh DocumentStore loads the same pristine markdown
    const doc2 = new DocumentStore();
    doc2.load(SAMPLE_MARKDOWN, HASH);

    // The reassignment should persist
    expect(doc2.current).toBe(afterEdit);
    expect(doc2.current).not.toContain("Speaker 5");
    expect(doc2.current).toContain("Ross Coulthart");
  });

  it("undoes within the session but never after refresh (history is memory-only)", () => {
    const doc1 = new DocumentStore();
    doc1.load(SAMPLE_MARKDOWN, HASH);
    doc1.mergeSpeakers(["Speaker 5"], "Ross Coulthart");

    // Undo is in-memory: the live session can walk back an edit.
    expect(doc1.canUndo).toBe(true);
    doc1.undo();
    expect(doc1.current).toContain("Speaker 5");

    // ...but the current text is saved every edit, so a reload restores it
    // with the history cleared. The reviewer loses the walk-back, never the work.
    doc1.mergeSpeakers(["Speaker 5"], "Ross Coulthart");
    const doc2 = new DocumentStore();
    doc2.load(SAMPLE_MARKDOWN, HASH);
    expect(doc2.current).toContain("Ross Coulthart");
    expect(doc2.current).not.toContain("Speaker 5");
    expect(doc2.canUndo).toBe(false);
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

  it("caps in-memory undo history at ten edits, dropping the oldest", () => {
    const doc = new DocumentStore();
    doc.load(SAMPLE_MARKDOWN, HASH);
    for (let i = 0; i < 25; i++) {
      doc.renameSpeaker(i === 0 ? "Speaker 6" : `Name ${i - 1}`, `Name ${i}`);
    }
    // Never more than MAX_HISTORY (10) layers of history are kept alive.
    expect(doc.past.length).toBeLessThanOrEqual(10);
    // The newest ten edits are still undoable this session - the oldest fell off.
    doc.undo();
    expect(doc.current).toContain("Name 23");
  });

  it("keeps draft patches only for document versions the bounded history can reach", () => {
    const doc = new DocumentStore();
    doc.load(SAMPLE_MARKDOWN, HASH);
    for (let i = 0; i < 40; i++) {
      doc.renameSpeaker(i === 0 ? "Speaker 6" : `Name ${i - 1}`, `Name ${i}`);
    }

    const cache = (doc as unknown as { patchCache: Map<string, unknown> }).patchCache;
    expect(cache.size).toBeLessThanOrEqual(11);
    expect([...cache.keys()].every((version) => version === doc.current || doc.past.includes(version))).toBe(
      true,
    );
  });

  it("rebases draft encoding after a successful submission", () => {
    const doc = new DocumentStore();
    doc.load(SAMPLE_MARKDOWN, HASH);
    doc.renameSpeaker("Speaker 6", "Submitted Name");
    const submitted = doc.current;

    doc.acceptSubmitted(submitted);
    expect(doc.dirty).toBe(false);
    expect(doc.canUndo).toBe(false);
    expect(localStorage.getItem(doc.storageKey)).toBeNull();

    doc.renameSpeaker("Submitted Name", "Later Name");
    const reloaded = new DocumentStore();
    reloaded.load(submitted, HASH);
    expect(reloaded.current).toBe(doc.current);
    expect(reloaded.current).toContain("Later Name");
  });

  it("flags the save as failed when localStorage is full, so the banner shows", () => {
    // The blocking saveFailed banner is the only thing standing between the
    // reviewer and a reload losing an edit entirely - it must never regress.
    const quota = {
      map: new Map<string, string>(),
      get length() {
        return this.map.size;
      },
      key() {
        return null;
      },
      clear() {
        this.map.clear();
      },
      removeItem(k: string) {
        this.map.delete(k);
      },
      getItem(k: string) {
        return this.map.get(k) ?? null;
      },
      setItem(k: string, v: string) {
        const e = new Error("quota") as Error & { name: string };
        e.name = "QuotaExceededError";
        throw e;
      },
    } as Storage;
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", { value: quota, configurable: true });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const doc = new DocumentStore();
      doc.load(SAMPLE_MARKDOWN, HASH);
      doc.renameSpeaker("Speaker 6", "David Marler");
      expect(doc.saveFailed).toBe(true);
    } finally {
      err.mockRestore();
      Object.defineProperty(globalThis, "localStorage", { value: original, configurable: true });
    }
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

  it("never stores undo history - the draft is current-state only", () => {
    const doc = new DocumentStore();
    doc.load(SAMPLE_MARKDOWN, HASH);
    for (let i = 0; i < 6; i++) doc.renameSpeaker("Speaker 6", `Name ${i}`);

    const state = JSON.parse(localStorage.getItem(`workbench:doc:${HASH}`)!) as Record<
      string,
      unknown
    >;
    expect(state.v).toBe(2);
    expect(state.patch).toBeDefined();
    expect(state.past).toBeUndefined();
    expect(state.future).toBeUndefined();
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

describe("the speakers-list rewrite touches only the speakers block", () => {
  // The Fravor-style fixture: a folded multi-line title and a numeric field
  // that js-yaml would re-emit differently. Rewriting `speakers:` must leave
  // every other frontmatter byte alone, or the whole body re-encodes as one
  // giant literal (a 901KB draft for a one-line change - the quota bug).
  const FOLDED = `---
schema: anomalica/record/2
title: >-
  David Fravor: UFOs, Aliens, Fighter Jets, and Aerospace Engineering | Lex
  Fridman Podcast #122
published: 2023-01-19
funded: 1947
speakers:
  - Lex Fridman
  - David Fravor
---

<!-- speaker: Lex Fridman -->
{{t:0.05}}The {{t:0.19}}following {{t:0.69}}is {{t:0.79}}a {{t:0.87}}conversation.

<!-- speaker: David Fravor -->
{{t:13.02}}So {{t:13.12}}I {{t:13.28}}was {{t:13.42}}flying.

<!-- speaker: David Fravor -->
{{t:21.02}}We {{t:21.20}}proceeded.
`;

  beforeEach(() => {
    localStorage.clear();
  });

  function frontmatterOf(doc: DocumentStore): string {
    const match = doc.current.match(/^(---\n[\s\S]*?\n---\n)/);
    if (!match) throw new Error("no frontmatter");
    return match[1];
  }

  function loadFm(rawFm: string): { [k: string]: unknown } {
    return (yaml.load(rawFm.replace(/^---\n/, "").replace(/---\n$/, "")) as {
      [k: string]: unknown;
    }) ?? {};
  }

  it("reorders the list without retouching folded titles or numbers", () => {
    const doc = new DocumentStore();
    doc.load(FOLDED, HASH);
    doc.updateFrontmatterSpeakers(["David Fravor", "Lex Fridman", "Marjorie"]);
    const fm = frontmatterOf(doc);
    // Every non-speakers line survives byte-for-byte (folded title and all).
    expect(fm).toBe(`---\nschema: anomalica/record/2\ntitle: >-\n  David Fravor: UFOs, Aliens, Fighter Jets, and Aerospace Engineering | Lex\n  Fridman Podcast #122\npublished: 2023-01-19\nfunded: 1947\nspeakers:\n  - David Fravor\n  - Lex Fridman\n  - Marjorie\n---\n`);
    const loaded = loadFm(fm);
    expect(loaded.title).toBe("David Fravor: UFOs, Aliens, Fighter Jets, and Aerospace Engineering | Lex Fridman Podcast #122");
    expect(loaded.funded).toBe(1947);
    expect(loaded.speakers).toEqual(["David Fravor", "Lex Fridman", "Marjorie"]);
  });

  it("a reassign that reconciles the list still stores a tiny patch", () => {
    const doc = new DocumentStore();
    doc.load(FOLDED, HASH);
    const before = doc.current;
    // Reassign the first run to a real, new name: the frontmatter list must
    // grow, which is exactly the path that used to re-dump the whole
    // frontmatter through js-yaml (every line reshaped -> whole-body literal).
    const [, body] = (() => {
      const m = before.match(/^(---\n[\s\S]*?\n---\n)([\s\S]*)$/);
      return [m![1], m![2]];
    })();
    const parsed = parseWords(body);
    const next = doc.reassignWords(0, 4, "Marjorie", parsed);
    expect(next).not.toBeNull();
    expect(doc.current).toContain("<!-- speaker: Marjorie -->");
    expect(loadFm(frontmatterOf(doc)).speakers).toEqual(["Lex Fridman", "David Fravor", "Marjorie"]);

    const stored = localStorage.getItem(`workbench:doc:${HASH}`);
    expect(stored).not.toBeNull();
    expect(stored!.length).toBeLessThan(1_000);
    const patch = JSON.parse(stored!).patch;
    expect(patchSize(patch)).toBeLessThan(1_000);
    expect(decodePatch(before, patch)).toBe(doc.current);
  });
});
