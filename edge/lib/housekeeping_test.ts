/**
 * The Python cases from scheduler/backend/test_housekeeping.py, ported.
 *
 * This suite exists because edge/lib/housekeeping.ts duplicates apply_items - the
 * one function guaranteeing housekeeping never touches prose - and a duplicate
 * that is not held to the same cases is a duplicate that drifts. If you change
 * either implementation, change both and run both.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
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
  validateV3Sidecar,
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

function tokenItem(
  record: string,
  oldToken = "Speaker_1",
  newToken = "Alice",
): HousekeepingV2Item {
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
  const record =
    "---\ntitle: 敦賀\n---\nSpeaker_1 met Speaker_10. Speaker_1 spoke.\n";
  const item = tokenItem(record);
  const out = applyTokenReplacements(record, [item]);
  assertEquals(
    out,
    "---\ntitle: 敦賀\n---\nAlice met Speaker_10. Alice spoke.\n",
  );
});

Deno.test("v2 ignores the same whole token in frontmatter", () => {
  const record =
    "---\ntitle: Speaker_1\n---\nSpeaker_1 spoke twice: Speaker_1.\n";
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
  assert(
    out.includes("title: 'Eyewitnesses Talk to Dr. James E. McDonald (1967)'"),
  );
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
  await assertRejects(
    () => applyPatch(withList, [MOVE_PUBLISHER, alsoValid]),
    ApplyConflict,
  );
});

Deno.test("a patch conflict aborts when the record moved on", async () => {
  const edited = RECORD.replace(
    "publisher: 'Eyes On Cinema'",
    "publisher: 'BBC'",
  );
  await assertRejects(
    () => applyPatch(edited, [MOVE_PUBLISHER]),
    ApplyConflict,
  );
});

Deno.test("CRLF fences and body bytes are preserved", async () => {
  const record =
    "---\r\ntitle: T\r\npublisher: 'Old'\r\n---\r\nOSSAP body.\r\n";
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

Deno.test("mixed frontmatter line endings are preserved byte for byte", async () => {
  const record =
    "---\r\ntitle: Old\npublisher: Keep\r\ndate_published: '1967'\n---\r\nbody\n";
  const title = item({
    id: "title",
    check: "title",
    field: "title",
    operation: "set",
    to_field: undefined,
    current: "Old",
    proposed: "New",
  });
  assertEquals(
    await applyItems(record, [title]),
    record.replace("title: Old", 'title: "New"'),
  );
});

Deno.test("a record with no frontmatter is refused", async () => {
  await assertRejects(
    () => applyItems("just a body\n", [MOVE_PUBLISHER]),
    BodyChanged,
  );
});

Deno.test("set appends when the field is absent", async () => {
  const out = await applyItems(
    RECORD.replace("date_published: '2026-08-11'\n", ""),
    [SET_YEAR],
  );
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

Deno.test("apply refuses a fully approved dependency cycle", async () => {
  const first = item({ id: "one", depends_on: ["two"] });
  const second = item({
    id: "two",
    field: "date_published",
    operation: "clear",
    to_field: undefined,
    current: "2026-08-11",
    proposed: null,
    depends_on: ["one"],
  });
  await assertRejects(
    () => applyPatch(RECORD, [first, second]),
    Error,
    "dependency graph",
  );
});

Deno.test("frontmatter apply validates dependencies against the full item graph", async () => {
  const token: HousekeepingV2Item = {
    id: "term",
    check: "known-term-check",
    operation: "replace-token",
    scope: "body",
    old_token: "OSAP",
    new_token: "AAWSAP",
    case_sensitive: true,
    token_boundary: "ascii-word",
    occurrences: [{ start_byte: 1, end_byte: 5 }],
    expected_count: 1,
    confidence: "high",
    evidence: { reasoning: "Registered correction" },
    status: "approved",
  };
  const title = item({
    id: "title",
    field: "title",
    operation: "set",
    to_field: undefined,
    current: "Eyewitnesses Talk to Dr. James E. McDonald (1967)",
    proposed: "Corrected title",
    depends_on: ["term"],
  });
  const result = await applyPatch(RECORD, [title], [token, title]);
  assert(result.text.includes('title: "Corrected title"'));
});

function validV3Sidecar() {
  const digest = `sha256:${"a".repeat(64)}`;
  return {
    schema: "anomalica/housekeeping/3",
    content_hash: digest,
    input_sha256: digest,
    result_sha256: digest,
    checked_at: "2026-09-17T00:00:00Z",
    algorithm_version: "3",
    passes: {
      deterministic: {
        status: "completed",
        finished_at: "2026-09-17T00:00:00Z",
      },
      "metadata-research": {
        status: "completed",
        finished_at: "2026-09-17T00:00:00Z",
        usage: { transport: "subscription" },
      },
    },
    items: [{
      id: "publisher",
      check: "publisher",
      category: "metadata",
      pass: "metadata-research",
      field: "publisher",
      operation: "set",
      current: "Old",
      proposed: "New",
      confidence: "high",
      evidence: { reasoning: "The source identifies the publisher." },
      status: "proposed",
    }],
    decisions: [],
  };
}

Deno.test("v3 sidecar validation accepts the strict canonical structure", () => {
  assert(validateV3Sidecar(validV3Sidecar()));
});

Deno.test("v3 sidecar validation rejects extra fields and invalid pass usage", () => {
  assert(!validateV3Sidecar({ ...validV3Sidecar(), outcome: "completed" }));
  const wrongUsage = structuredClone(validV3Sidecar());
  wrongUsage.passes["metadata-research"].usage.transport = "api";
  assert(!validateV3Sidecar(wrongUsage));
});

Deno.test("v3 sidecar validation requires decision audit to match final items", () => {
  const missingAudit = structuredClone(validV3Sidecar());
  missingAudit.items[0].status = "approved";
  assert(!validateV3Sidecar(missingAudit));
  assert(validateV3Sidecar({
    ...missingAudit,
    decisions: [{
      item_id: "publisher",
      status: "approved",
      decided_at: "2026-09-17T00:01:00Z",
      decided_by: "reviewer@example.com",
    }],
  }));
});

Deno.test("v3 sidecar requires canonical timestamps, pass order, and latest checked_at", () => {
  for (
    const timestamp of [
      "2026-09-17T00:00:00+00:00",
      "2026-09-17 00:00:00Z",
      "2026-02-30T00:00:00Z",
    ]
  ) {
    const invalid = structuredClone(validV3Sidecar());
    invalid.checked_at = timestamp;
    assert(!validateV3Sidecar(invalid), timestamp);
  }
  const predates = structuredClone(validV3Sidecar());
  predates.passes.deterministic.finished_at = "2026-09-17T00:00:01Z";
  assert(!validateV3Sidecar(predates));
  const staleCheckedAt = structuredClone(validV3Sidecar());
  staleCheckedAt.passes["metadata-research"].finished_at =
    "2026-09-17T00:00:01Z";
  assert(!validateV3Sidecar(staleCheckedAt));
});

Deno.test("v3 sidecar rejects invalid dependency graphs", () => {
  for (
    const dependencies of [
      ["missing"],
      ["publisher"],
      ["publisher", "publisher"],
    ]
  ) {
    const invalid = structuredClone(validV3Sidecar());
    (invalid.items[0] as { depends_on?: string[] }).depends_on = dependencies;
    assert(!validateV3Sidecar(invalid));
  }
  const cyclic = structuredClone(validV3Sidecar()) as Record<string, unknown>;
  const items = cyclic.items as Record<string, unknown>[];
  items[0].depends_on = ["second"];
  items.push({
    ...items[0],
    id: "second",
    field: "creators",
    depends_on: ["publisher"],
  });
  assert(!validateV3Sidecar(cyclic));
});

Deno.test("v3 replacements require deterministic known-term shape", () => {
  const valid = structuredClone(validV3Sidecar()) as Record<string, unknown>;
  valid.items = [{
    id: "aawsap",
    check: "known-term-check",
    category: "known-term",
    pass: "deterministic",
    operation: "replace-token",
    scope: "body",
    old_token: "OSSAP",
    new_token: "AAWSAP",
    case_sensitive: true,
    token_boundary: "ascii-word",
    occurrences: [{ start_byte: 20, end_byte: 25 }],
    expected_count: 1,
    confidence: "high",
    evidence: { reasoning: "The known-term correction applies." },
    status: "proposed",
  }];
  assert(validateV3Sidecar(valid));
  const research = structuredClone(valid) as Record<string, unknown>;
  (research.items as Record<string, unknown>[])[0].pass = "metadata-research";
  assert(!validateV3Sidecar(research));
});

Deno.test("v3 decisions must form one canonical audit batch", () => {
  const invalid = structuredClone(validV3Sidecar()) as Record<string, unknown>;
  const first = (invalid.items as Record<string, unknown>[])[0];
  first.status = "rejected";
  (invalid.items as Record<string, unknown>[]).push({
    ...first,
    id: "second",
    field: "creators",
  });
  invalid.decisions = [
    {
      item_id: "publisher",
      status: "rejected",
      decided_at: "2026-09-17T00:01:00Z",
      decided_by: "reviewer@example.com",
    },
    {
      item_id: "second",
      status: "rejected",
      decided_at: "2026-09-17T00:01:01Z",
      decided_by: "reviewer@example.com",
    },
  ];
  assert(!validateV3Sidecar(invalid));
});
