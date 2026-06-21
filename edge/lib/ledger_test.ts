import { assert, assertEquals } from "jsr:@std/assert@1";
import { parseAll } from "jsr:@std/yaml@1";
import {
  appendEntry,
  buildMergeEntry,
  buildRejectEntry,
  isoSeconds,
  serialiseEntry,
} from "./ledger.ts";

const MERGE = buildMergeEntry({
  mergeId: "6cd0ae3b-44d9-4f4e-8568-26d91ab3a5d7",
  at: "2026-06-21T05:37:52Z",
  by: "reviewer@example.com",
  canonicalName: "Tic Tac",
  survivor: { id: "s1", name: "Tic Tac", node_type: "object", aliases: [] },
  victims: [{ id: "v1", name: "Tic-Tac UAP", node_type: "object", aliases: ["the Tic Tac"] }],
});

Deno.test("merge entry: op-first key order, no document-end marker", () => {
  const doc = serialiseEntry(MERGE);
  assert(doc.startsWith("---\nop: merge\n"), doc);
  assert(!doc.includes("\n..."), "no document-end marker");
  // unicode/spaces kept readable, not escaped
  assert(doc.includes("Tic Tac"));
});

Deno.test("merge entry round-trips through a YAML parser unchanged", () => {
  const [parsed] = parseAll(serialiseEntry(MERGE)) as Record<string, unknown>[];
  assertEquals(parsed, MERGE as unknown as Record<string, unknown>);
});

Deno.test("reject entry shape matches the assimilator writer", () => {
  const entry = buildRejectEntry({
    rejectionId: "r1",
    at: "2026-06-21T05:37:52Z",
    by: null,
    reason: "distinct sections",
    nodes: [
      { id: "n1", name: "Section 1632", node_type: "matter" },
      { id: "n2", name: "Section 1673", node_type: "matter" },
    ],
  });
  assertEquals(entry.op, "reject");
  assertEquals(entry.audit.node_ids, ["n1", "n2"]);
  assertEquals(entry.nodes[0], {
    name: "Section 1632",
    node_type: "matter",
    prior_names: [],
  });
  const [parsed] = parseAll(serialiseEntry(entry)) as Record<string, unknown>[];
  assertEquals(parsed, entry as unknown as Record<string, unknown>);
});

Deno.test("appendEntry builds a multi-doc stream", () => {
  const stream = appendEntry(appendEntry("", MERGE), MERGE);
  const docs = parseAll(stream) as unknown[];
  assertEquals(docs.length, 2);
});

Deno.test("isoSeconds drops millis, keeps Z", () => {
  assertEquals(isoSeconds(new Date("2026-06-21T05:37:52.123Z")), "2026-06-21T05:37:52Z");
});
