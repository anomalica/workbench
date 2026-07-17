import { describe, it, expect } from "vitest";
import {
  auditGrid,
  gridRow,
  passageQuotes,
  passageTally,
  memberLines,
  frameLabel,
} from "./audit-grid";
import type { AuditCluster, AuditMember, AuditPassage, AuditVariant } from "$lib/api";

const variants: AuditVariant[] = [
  {
    id: "v-haiku",
    model: "haiku",
    cost_usd: 0.28,
    prompt_ids: [],
    prompt_fingerprint: "515508ce",
    claim_count: 2,
  },
  {
    id: "v-sonnet",
    model: "sonnet",
    cost_usd: 0.81,
    prompt_ids: [],
    prompt_fingerprint: "515508ce",
    claim_count: 1,
  },
];

function member(variant: string, text: string, extra: Partial<AuditMember> = {}): AuditMember {
  return {
    variant,
    model: variant.replace("v-", ""),
    claim_id: `${variant}-${text}`,
    location: "8:31",
    quote: "the pilot reported a light",
    text,
    claim_type: "observation",
    attestation: "reported",
    speaker: "",
    refs: [],
    ...extra,
  };
}

function cluster(id: string, members: AuditMember[]): AuditCluster {
  const vs = [...new Set(members.map((m) => m.variant))];
  return { id, singleton: vs.length === 1, variants: vs, members };
}

describe("gridRow: every model always gets a cell", () => {
  it("renders an EXPLICIT empty where a model produced nothing", () => {
    // The whole point. haiku found this fact, sonnet did not - and the reviewer
    // must see sonnet's silence, not infer it from a missing tag.
    const row = gridRow(cluster("c1", [member("v-haiku", "a light was seen")]), variants);

    expect(row.cells).toHaveLength(2); // one per model, ALWAYS
    expect(row.cells[0]).toMatchObject({ model: "haiku", present: true });
    expect(row.cells[1]).toMatchObject({ model: "sonnet", present: false });
    expect(row.cells[1].members).toEqual([]);
    expect(row.singleton).toBe(true);
    expect(row.producedBy).toBe(1);
  });

  it("keeps cells in the record's variant order, so columns line up across rows", () => {
    const a = gridRow(cluster("c1", [member("v-sonnet", "x")]), variants);
    const b = gridRow(cluster("c2", [member("v-haiku", "y")]), variants);
    expect(a.cells.map((c) => c.model)).toEqual(["haiku", "sonnet"]);
    expect(b.cells.map((c) => c.model)).toEqual(["haiku", "sonnet"]);
  });

  it("marks a fact both models produced as not a singleton", () => {
    const row = gridRow(
      cluster("c1", [
        member("v-haiku", "a light was seen"),
        member("v-sonnet", "a light was observed"),
      ]),
      variants,
    );
    expect(row.cells.every((c) => c.present)).toBe(true);
    expect(row.producedBy).toBe(2);
    expect(row.singleton).toBe(false);
  });

  it("a model producing nothing anywhere still gets a column of empty cells", () => {
    const threeModels = [
      ...variants,
      {
        id: "v-opus",
        model: "opus",
        cost_usd: 6.7,
        prompt_ids: [],
        prompt_fingerprint: "515508ce",
        claim_count: 0,
      },
    ];
    const row = gridRow(cluster("c1", [member("v-haiku", "x")]), threeModels);
    expect(row.cells.map((c) => `${c.model}:${c.present}`)).toEqual([
      "haiku:true",
      "sonnet:false",
      "opus:false",
    ]);
  });

  it("carries several members from the same model in one cell", () => {
    const row = gridRow(
      cluster("c1", [member("v-haiku", "a light"), member("v-haiku", "a light, hedged")]),
      variants,
    );
    expect(row.cells[0].members).toHaveLength(2);
    expect(row.cells[1].present).toBe(false);
  });
});

describe("auditGrid", () => {
  const passage: AuditPassage = {
    index: 0,
    start: 511,
    end: 544,
    raw_locations: ["8:31"],
    clusters: [
      cluster("c1", [member("v-haiku", "both saw this"), member("v-sonnet", "both saw this too")]),
      cluster("c2", [member("v-haiku", "only haiku saw this")]),
    ],
  };

  it("gives one row per fact, each with a full set of cells", () => {
    const rows = auditGrid(passage, variants);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.cells.length === variants.length)).toBe(true);
  });

  it("makes a singleton readable WITHOUT the other rows - the standalone property", () => {
    const [, singletonRow] = auditGrid(passage, variants);
    // Everything needed to judge this fact is in its own cells: what haiku said,
    // and that sonnet said nothing. No "only haiku" badge required.
    expect(singletonRow.cells[0].members[0].text).toBe("only haiku saw this");
    expect(singletonRow.cells[1].present).toBe(false);
  });

  it("survives a passage where a cluster has no members", () => {
    const empty: AuditPassage = { ...passage, clusters: [cluster("c0", [])] };
    const rows = auditGrid(empty, variants);
    expect(rows[0].cells.every((c) => !c.present)).toBe(true);
    expect(rows[0].producedBy).toBe(0);
    expect(rows[0].singleton).toBe(false);
  });

  it("yields no rows for a passage with no clusters, rather than throwing", () => {
    expect(auditGrid({ ...passage, clusters: [] }, variants)).toEqual([]);
  });

  it("yields no cells when the record has no variants", () => {
    const rows = auditGrid(passage, []);
    expect(rows[0].cells).toEqual([]);
    expect(rows[0].producedBy).toBe(0);
  });
});

describe("passageTally: what each model did in this chunk, zeros included", () => {
  const passage: AuditPassage = {
    index: 0,
    start: 0,
    end: 10,
    raw_locations: ["8:31"],
    clusters: [
      cluster("c1", [member("v-haiku", "a"), member("v-sonnet", "a2")]),
      cluster("c2", [member("v-haiku", "b")]),
    ],
  };

  it("counts per model and states an explicit zero", () => {
    const threeModels = [
      ...variants,
      {
        id: "v-opus",
        model: "opus",
        cost_usd: null,
        prompt_ids: [],
        prompt_fingerprint: "515508ce",
        claim_count: 0,
      },
    ];
    expect(passageTally(passage, threeModels)).toEqual([
      { variant: "v-haiku", model: "haiku", count: 2 },
      { variant: "v-sonnet", model: "sonnet", count: 1 },
      { variant: "v-opus", model: "opus", count: 0 }, // said nothing in this chunk - stated, not omitted
    ]);
  });
});

describe("passageQuotes", () => {
  it("collects the distinct source quotes the claims cited", () => {
    const p: AuditPassage = {
      index: 0,
      start: 0,
      end: 1,
      raw_locations: [],
      clusters: [
        cluster("c1", [member("v-haiku", "a", { quote: "first quote" })]),
        cluster("c2", [
          member("v-sonnet", "b", { quote: "first quote" }), // dupe drops
          member("v-haiku", "c", { quote: "second quote" }),
        ]),
      ],
    };
    expect(passageQuotes(p.clusters)).toEqual(["first quote", "second quote"]);
  });

  it("drops the (mock) placeholder - it is not source text", () => {
    const p = [cluster("c1", [member("v-haiku", "a", { quote: "(mock)" })])];
    expect(passageQuotes(p)).toEqual([]);
  });
});

describe("memberLines / frameLabel", () => {
  it("collapses identical wording+frame, splits a flattened one", () => {
    const lines = memberLines([
      member("v-haiku", "same", { attestation: "reported" }),
      member("v-sonnet", "same", { attestation: "reported" }),
      member("v-opus", "same", { attestation: "" }), // flattened: lost the attestation
    ]);
    expect(lines).toHaveLength(2);
  });

  it("builds a compact frame, dropping empty parts", () => {
    expect(
      frameLabel({ text: "t", claim_type: "observation", attestation: "reported", refs: [] }),
    ).toBe("observation · reported");
    expect(
      frameLabel({ text: "t", claim_type: "observation", attestation: "", refs: ["doc-1"] }),
    ).toBe("observation · refs: doc-1");
  });
});
