import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyMerge,
  filterNodes,
  type GraphNodeSummary,
  type MergeMember,
  rejectCandidate,
  setArticleDirectives,
  submitVerification,
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

describe("setArticleDirectives", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("PUTs the directive list to the article route and returns the stored list", async () => {
    const calls: { url: string; method?: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) });
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, directives: ["Use the full name"] }), {
          status: 200,
        }),
      );
    });
    const out = await setArticleDirectives("people", "luis-elizondo", ["Use the full name"]);
    expect(calls[0].url).toBe("/api/articles/people/luis-elizondo/directives");
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].body).toEqual({ directives: ["Use the full name"] });
    expect(out).toEqual(["Use the full name"]);
  });
});

describe("submitVerification", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the proof to the submit route and returns the gated body on a pass", async () => {
    const calls: { url: string; method?: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            passed: true,
            method: "sha256",
            body: "The body.\n",
            raw_frontmatter: "---\ntitle: x\n---\n",
          }),
          { status: 200 },
        ),
      );
    });
    const hash = "a".repeat(64);
    const out = await submitVerification(hash, { sha256: "deadbeef", ext: "epub" });
    expect(calls[0].url).toBe(`/api/ingests/${hash}/verification/submit`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ sha256: "deadbeef", ext: "epub" });
    expect(out.passed).toBe(true);
    expect(out.body).toBe("The body.\n");
    expect(out.raw_frontmatter).toBe("---\ntitle: x\n---\n");
  });

  it("throws on a non-ok response (so the gate stays closed)", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("nope", { status: 400 })));
    await expect(submitVerification("a".repeat(64), { sha256: "x" })).rejects.toThrow();
  });
});
