/**
 * The Python cases from scheduler/backend/test_housekeeping.py, ported.
 *
 * This suite exists because edge/lib/housekeeping.ts duplicates apply_items - the
 * one function guaranteeing housekeeping never touches prose - and a duplicate
 * that is not held to the same cases is a duplicate that drifts. If you change
 * either implementation, change both and run both.
 */

import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import {
  applyItems,
  BodyChanged,
  bodyDigest,
  type HousekeepingItem,
  applyPatch,
  MultilineField,
  scalar,
  unmetDependencies,
} from "./housekeeping.ts";

const RECORD = `---
title: 'Eyewitnesses Talk to Dr. James E. McDonald (1967)'
publisher: 'Eyes On Cinema'
date_published: '2026-08-11'
source_type: 'video'
content_hash: 'sha256:abc123'
---

<!-- speaker: Speaker 1 -->
It's called Cydonia, a complex region.

***

A thematic break above must not truncate the record.
`;

function item(over: Partial<HousekeepingItem>): HousekeepingItem {
  return {
    id: "i",
    check: "c",
    field: "publisher",
    operation: "move",
    to_field: "posted_by",
    current: "Eyes On Cinema",
    proposed: "Eyes On Cinema",
    confidence: "high",
    evidence: { reasoning: "r" },
    status: "approved",
    ...over,
  };
}

const MOVE_PUBLISHER = item({});
const MOVE_DATE = item({
  id: "d",
  field: "date_published",
  to_field: "posted_date",
  current: "2026-08-11",
  proposed: "2026-08-11",
});
const SET_YEAR = item({
  id: "y",
  field: "date_published",
  operation: "set",
  to_field: undefined,
  current: null,
  proposed: "1967",
});

Deno.test("a move relocates the field and its value", async () => {
  const out = await applyItems(RECORD, [MOVE_PUBLISHER]);
  assert(out.includes('posted_by: "Eyes On Cinema"'));
  assert(!out.includes("publisher:"));
});

Deno.test("only approved items are applied", async () => {
  const out = await applyItems(RECORD, [{ ...MOVE_PUBLISHER, status: "rejected" }]);
  assertEquals(out, RECORD);
});

Deno.test("the body is never changed", async () => {
  const out = await applyItems(RECORD, [MOVE_PUBLISHER, MOVE_DATE, SET_YEAR]);
  assertEquals(await bodyDigest(out), await bodyDigest(RECORD));
  assert(out.includes("It's called Cydonia"));
  assert(out.includes("<!-- speaker: Speaker 1 -->"));
  assert(out.includes("***"), "a thematic break must not truncate the split");
});

Deno.test("untouched frontmatter keeps its original bytes", async () => {
  const out = await applyItems(RECORD, [MOVE_PUBLISHER]);
  assert(out.includes("title: 'Eyewitnesses Talk to Dr. James E. McDonald (1967)'"));
  assert(out.includes("source_type: 'video'"));
  assert(out.includes("content_hash: 'sha256:abc123'"));
});

Deno.test("a full ISO date is emitted bare, a reduced-precision one quoted", () => {
  // Precision is the evidence marker: a bare 1967 parses as an integer, so a
  // year-only date must stay a string.
  assertEquals(scalar("2026-08-11"), "2026-08-11");
  assertEquals(scalar("1967"), '"1967"');
  assertEquals(scalar("Eyes On Cinema"), '"Eyes On Cinema"');
});

Deno.test("a quote in a value is escaped", () => {
  assertEquals(scalar('a "quoted" name'), '"a \\"quoted\\" name"');
});

Deno.test("a multiline field does not apply, and does not abort the rest", async () => {
  // The record is not the shape the proposal assumed. It is reported as
  // not-applied rather than raised: raising would discard items that WOULD have
  // applied, and a structural mismatch is the same class of event as any other
  // "the record moved on".
  const withList = RECORD.replace(
    "publisher: 'Eyes On Cinema'",
    "publisher:\n  - Eyes On Cinema\n  - Someone Else",
  );
  const alsoValid = item({
    id: "ok",
    field: "date_published",
    operation: "set",
    to_field: undefined,
    current: "2026-08-11",
    proposed: "1967",
  });
  const r = await applyPatch(withList, [MOVE_PUBLISHER, alsoValid]);
  assertEquals(
    r.didNotApply.map((d) => d.item.id),
    ["i"],
  );
  assertEquals(
    r.applied.map((i) => i.id),
    ["ok"],
    "the other item still applied",
  );
});

Deno.test("a patch does not apply when the record moved on", async () => {
  const edited = RECORD.replace("publisher: 'Eyes On Cinema'", "publisher: 'BBC'");
  const r = await applyPatch(edited, [MOVE_PUBLISHER]);
  assertEquals(r.applied.length, 0);
  assertEquals(r.text, edited, "an unmatched patch leaves the record untouched");
  assertEquals(r.didNotApply.length, 1);
});

Deno.test("a record with no frontmatter is refused", async () => {
  await assertRejects(() => applyItems("just a body\n", [MOVE_PUBLISHER]), BodyChanged);
});

Deno.test("set appends when the field is absent", async () => {
  const out = await applyItems(RECORD.replace("date_published: '2026-08-11'\n", ""), [SET_YEAR]);
  assert(out.includes('date_published: "1967"'));
  assertEquals(await bodyDigest(out), await bodyDigest(RECORD));
});

Deno.test("clear removes the field", async () => {
  const out = await applyItems(RECORD, [
    item({ id: "c1", field: "publisher", operation: "clear", to_field: undefined }),
  ]);
  assert(!out.includes("publisher:"));
  assert(out.includes("source_type: 'video'"));
});

Deno.test("the guard catches a parser fault that swallows a body line", async () => {
  // bodyDigest deliberately does not share a parser with splitRecord, so a
  // mis-split cannot corrupt both sides identically and slip past.
  const mangled = RECORD.replace("---\n\n<!-- speaker", "---\n<!-- speaker");
  assert(
    (await bodyDigest(mangled)) !== (await bodyDigest(RECORD)),
    "a body that lost a line must produce a different digest",
  );
});

Deno.test("a dependent item cannot be approved without its prerequisite", () => {
  // Setting date_published without the move that frees it overwrites the upload
  // date instead of relocating it - so this is refused, not warned about.
  const move = item({ id: "m", field: "date_published", to_field: "posted_date" });
  const set = item({
    id: "s",
    field: "date_published",
    operation: "set",
    to_field: undefined,
    proposed: "2000",
    depends_on: ["m"],
  });
  assertEquals(unmetDependencies([move, set], new Set(["s"])), ["s"]);
  assertEquals(unmetDependencies([move, set], new Set(["m", "s"])), []);
  assertEquals(unmetDependencies([move, set], new Set(["m"])), []);
});
