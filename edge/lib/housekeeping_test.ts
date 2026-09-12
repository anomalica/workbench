/**
 * The Python cases from scheduler/backend/test_housekeeping.py, ported.
 *
 * This suite exists because edge/lib/housekeeping.ts duplicates apply_items - the
 * one function guaranteeing housekeeping never touches prose - and a duplicate
 * that is not held to the same cases is a duplicate that drifts. If you change
 * either implementation, change both and run both.
 */

import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  ApplyConflict,
  applyItems,
  applyPatch,
  applyTokenReplacements,
  BodyChanged,
  bodyDigest,
  type HousekeepingItem,
  type HousekeepingV2Item,
  InvalidReplacement,
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

function tokenItem(record: string, oldToken = "Speaker_1", newToken = "Alice"): HousekeepingV2Item {
  const bytes = new TextEncoder().encode(record);
  const needle = new TextEncoder().encode(oldToken);
  const bodyStart = new TextEncoder().encode(
    record.match(/^---\n[\s\S]*?\n---\n/)?.[0] ?? "",
  ).length;
  const occurrences = [];
  for (let i = bodyStart; i <= bytes.length - needle.length; i++) {
    const isWord = (byte: number | undefined) =>
      byte !== undefined &&
      ((byte >= 48 && byte <= 57) ||
        (byte >= 65 && byte <= 90) ||
        byte === 95 ||
        (byte >= 97 && byte <= 122));
    if (
      needle.every((byte, j) => bytes[i + j] === byte) &&
      !isWord(bytes[i - 1]) &&
      !isWord(bytes[i + needle.length])
    ) {
      occurrences.push({ start_byte: i, end_byte: i + needle.length });
    }
  }
  return {
    id: "speaker-1",
    check: "speaker-name",
    operation: "replace-token",
    scope: "body",
    old_token: oldToken,
    new_token: newToken,
    case_sensitive: true,
    token_boundary: "ascii-word",
    occurrences,
    expected_count: occurrences.length,
    confidence: "high",
    evidence: { reasoning: "Named in the transcript" },
    status: "proposed",
  };
}

Deno.test("v2 replaces the complete body token set at raw UTF-8 byte offsets", () => {
  const record = "---\ntitle: 敦賀\n---\nSpeaker_1 met Speaker_10. Speaker_1 spoke.\n";
  const item = tokenItem(record);
  const out = applyTokenReplacements(record, [item]);
  assertEquals(out, "---\ntitle: 敦賀\n---\nAlice met Speaker_10. Alice spoke.\n");
});

Deno.test("v2 ignores the same whole token in frontmatter", () => {
  const record = "---\ntitle: Speaker_1\n---\nSpeaker_1 spoke twice: Speaker_1.\n";
  assertEquals(
    applyTokenReplacements(record, [tokenItem(record)]),
    "---\ntitle: Speaker_1\n---\nAlice spoke twice: Alice.\n",
  );
});

Deno.test("v2 refuses incomplete, extra-key, and overlapping replacements", () => {
  const bodyOnly = "---\ntitle: T\n---\nSpeaker_1 spoke twice: Speaker_1.\n";
  const incomplete = tokenItem(bodyOnly);
  incomplete.occurrences.pop();
  incomplete.expected_count--;
  assertThrows(
    () => applyTokenReplacements(bodyOnly, [incomplete]),
    InvalidReplacement,
    "complete body match set",
  );

  const extra = {
    ...tokenItem(bodyOnly),
    extra: true,
  } as unknown as HousekeepingV2Item;
  assertThrows(
    () => applyTokenReplacements(bodyOnly, [extra]),
    InvalidReplacement,
    "invalid item shape",
  );

  const duplicate = tokenItem(bodyOnly);
  assertThrows(
    () =>
      applyTokenReplacements(bodyOnly, [
        duplicate,
        {
          ...duplicate,
          id: "two",
        },
      ]),
    InvalidReplacement,
    "overlapping",
  );
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
  const out = await applyItems(RECORD, [
    {
      ...MOVE_PUBLISHER,
      status: "rejected",
    },
  ]);
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

Deno.test("a multiline field conflict aborts the complete apply", async () => {
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
  await assertRejects(() => applyPatch(withList, [MOVE_PUBLISHER, alsoValid]), ApplyConflict);
});

Deno.test("a patch conflict aborts when the record moved on", async () => {
  const edited = RECORD.replace("publisher: 'Eyes On Cinema'", "publisher: 'BBC'");
  await assertRejects(() => applyPatch(edited, [MOVE_PUBLISHER]), ApplyConflict);
});

Deno.test("CRLF fences and body bytes are preserved", async () => {
  const record = "---\r\ntitle: T\r\npublisher: 'Old'\r\n---\r\nOSSAP body.\r\n";
  const frontmatter = item({
    current: "Old",
    proposed: "New",
    operation: "set",
    to_field: undefined,
  });
  assertEquals(
    await applyItems(record, [frontmatter]),
    '---\r\ntitle: T\r\npublisher: "New"\r\n---\r\nOSSAP body.\r\n',
  );
  assertEquals(
    applyTokenReplacements(record, [tokenItem(record, "OSSAP", "AAWSAP")]),
    "---\r\ntitle: T\r\npublisher: 'Old'\r\n---\r\nAAWSAP body.\r\n",
  );
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
    item({
      id: "c1",
      field: "publisher",
      operation: "clear",
      to_field: undefined,
    }),
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
  const move = item({
    id: "m",
    field: "date_published",
    to_field: "posted_date",
  });
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
