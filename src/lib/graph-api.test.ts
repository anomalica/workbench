import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyMerge,
  filterNodes,
  type GraphNodeSummary,
  type MergeMember,
  rejectCandidate,
} from "./api";

const nodes: GraphNodeSummary[] = [
  { id: "1", name: "Bob Lazar", node_type: "person", alias_count: 0, claim_count: 5 },
  { id: "2", name: "Lue Elizondo", node_type: "person", alias_count: 1, claim_count: 3 },
  { id: "3", name: "AATIP", node_type: "organisation", alias_count: 0, claim_count: 9 },
];

describe("filterNodes (client-side static-mode filter)", () => {
  it("filters by exact type", () => {
    expect(filterNodes(nodes, "person").map((n) => n.id)).toEqual(["1", "2"]);
  });
  it("filters by case-insensitive name substring", () => {
    expect(filterNodes(nodes, undefined, "laz").map((n) => n.id)).toEqual(["1"]);
    expect(filterNodes(nodes, undefined, "AATIP").map((n) => n.id)).toEqual(["3"]);
  });
  it("combines type + query", () => {
    expect(filterNodes(nodes, "person", "elizondo").map((n) => n.id)).toEqual(["2"]);
  });
  it("no filters returns all", () => {
    expect(filterNodes(nodes)).toHaveLength(3);
  });
});

describe("curation writes carry both ids and node refs", () => {
  afterEach(() => vi.unstubAllGlobals());

  function captureFetch() {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });
    return calls;
  }

  const survivor: MergeMember = {
    id: "s1",
    name: "Tic Tac",
    node_type: "object",
    claims: 9,
    aliases: ["the Tic Tac"],
  };
  const victim: MergeMember = {
    id: "v1",
    name: "Tic-Tac UAP",
    node_type: "object",
    claims: 2,
  };

  it("applyMerge sends survivor_id/victim_ids AND survivor/victims refs", async () => {
    const calls = captureFetch();
    await applyMerge(survivor, [victim], "Tic Tac");
    expect(calls[0].url).toBe("/api/curation/merge");
    expect(calls[0].body).toEqual({
      survivor_id: "s1",
      victim_ids: ["v1"],
      canonical_name: "Tic Tac",
      survivor: { id: "s1", name: "Tic Tac", node_type: "object", aliases: ["the Tic Tac"] },
      victims: [{ id: "v1", name: "Tic-Tac UAP", node_type: "object", aliases: [] }],
    });
  });

  it("rejectCandidate sends node_ids AND node refs", async () => {
    const calls = captureFetch();
    await rejectCandidate([survivor, victim]);
    expect(calls[0].url).toBe("/api/curation/reject");
    expect(calls[0].body).toEqual({
      node_ids: ["s1", "v1"],
      nodes: [
        { id: "s1", name: "Tic Tac", node_type: "object", aliases: ["the Tic Tac"] },
        { id: "v1", name: "Tic-Tac UAP", node_type: "object", aliases: [] },
      ],
    });
  });
});
