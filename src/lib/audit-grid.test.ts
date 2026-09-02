import { describe, it, expect } from "vitest";
import {
  auditGrid,
  visibleRows,
  passageHasContent,
  gridRow,
  passageQuotes,
  passageTally,
  stepsPastRendered,
  memberLines,
  frameLabel,
  doubt,
  doubtfulFirst,
  entailmentLabel,
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
      frameLabel({
        text: "t",
        claim_type: "observation",
        attestation: "reported",
        speaker: "",
        refs: [],
      }),
    ).toBe("observation · reported");
    expect(
      frameLabel({
        text: "t",
        claim_type: "observation",
        attestation: "",
        speaker: "",
        refs: ["doc-1"],
      }),
    ).toBe("observation · refs: doc-1");
  });
});

describe("hiding dead chunks without hiding the missed-fact signal", () => {
  const passage: AuditPassage = {
    index: 0,
    start: 511,
    end: 544,
    raw_locations: ["8:31"],
    clusters: [
      cluster("c1", [member("v-haiku", "haiku found this")]),
      cluster("c2", [member("v-sonnet", "sonnet found this")]),
    ],
  };

  it("KEEPS a fact only some selected models found - that silence is the signal", () => {
    // Both models selected, each found a different fact. Neither row may be
    // hidden: "sonnet found this, haiku didn't" is precisely the missed-fact
    // comparison the view exists to show.
    const rows = visibleRows(passage, variants);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.producedBy === 1)).toBe(true);
    expect(passageHasContent(passage, variants)).toBe(true);
  });

  it("HIDES a fact no selected model produced - it belongs to a model switched off", () => {
    // Only sonnet is selected. haiku's fact is not a gap in sonnet's recall
    // that the reviewer asked to see; it is a row about a model they hid.
    const sonnetOnly = variants.filter((v) => v.id === "v-sonnet");
    const rows = visibleRows(passage, sonnetOnly);
    expect(rows).toHaveLength(1);
    expect(rows[0].cells[0].members[0].text).toBe("sonnet found this");
  });

  it("reports a chunk as empty only when NO selected model produced anything", () => {
    const haikuOnlyPassage: AuditPassage = {
      ...passage,
      clusters: [cluster("c1", [member("v-haiku", "haiku found this")])],
    };
    const sonnetOnly = variants.filter((v) => v.id === "v-sonnet");
    expect(passageHasContent(haikuOnlyPassage, sonnetOnly)).toBe(false);
    // ... and it comes straight back when that model is selected again.
    expect(passageHasContent(haikuOnlyPassage, variants)).toBe(true);
  });

  it("treats a memberless cluster as nothing to show", () => {
    const empty: AuditPassage = { ...passage, clusters: [cluster("c0", [])] };
    expect(visibleRows(empty, variants)).toEqual([]);
    expect(passageHasContent(empty, variants)).toBe(false);
  });
});

describe("frameLabel shows who said it", () => {
  const line = (extra = {}) => ({
    text: "David Grusch has risked his career to expose critical information.",
    claim_type: "opinion",
    attestation: "first_hand",
    speaker: "Burlison, Eric",
    refs: ["Grusch, David"],
    ...extra,
  });

  it("leads with the speaker - it is the attribution", () => {
    // Omitting it made a model that keeps `text` as the bare proposition and
    // the name in `speaker` look like it had dropped the attribution, while a
    // model that baked the name into its prose looked more careful. Both had
    // recorded it; only one was being rendered.
    expect(frameLabel(line())).toBe(
      "said by Burlison, Eric · opinion · first_hand · refs: Grusch, David",
    );
  });

  it("omits the speaker when there is none, rather than saying 'said by'", () => {
    expect(frameLabel(line({ speaker: "" }))).toBe("opinion · first_hand · refs: Grusch, David");
  });

  it("keeps two claims apart when only their speaker differs", () => {
    const a = { ...line(), variant: "a", model: "a", claim_id: "1", location: "", quote: "" };
    const b = { ...a, speaker: "Grusch, David", claim_id: "2" };
    expect(memberLines([a, b])).toHaveLength(2);
  });
});

describe("stepsPastRendered", () => {
  it("extends rather than stopping at the last rendered claim", () => {
    expect(stepsPastRendered(1, 24, 25, 268)).toBe(true);
  });

  it("does not extend from the middle of what is rendered", () => {
    expect(stepsPastRendered(1, 10, 25, 268)).toBe(false);
  });

  it("does not extend when everything is already rendered", () => {
    // Otherwise the last claim in the audit would swallow every `j` press
    // instead of staying put, and the reviewer could never rest on it.
    expect(stepsPastRendered(1, 24, 25, 0)).toBe(false);
  });

  it("never extends going backwards", () => {
    expect(stepsPastRendered(-1, 24, 25, 268)).toBe(false);
  });
});

describe("doubt ordering", () => {
  const e = (label: "entails" | "neutral" | "contradicts", score: number) => ({
    label,
    score,
    model: "m",
  });

  it("puts a confident contradiction before everything", () => {
    expect(doubt(e("contradicts", 0.9))).toBeLessThan(doubt(e("contradicts", 0.5)));
    expect(doubt(e("contradicts", 0.5))).toBeLessThan(doubt(e("neutral", 0.99)));
  });

  it("puts a confident neutral before a weak entailment", () => {
    expect(doubt(e("neutral", 0.9))).toBeLessThan(doubt(e("entails", 0.3)));
  });

  it("puts a weak entailment before a strong one", () => {
    // The quote only just supports it: the next most worth a look.
    expect(doubt(e("entails", 0.51))).toBeLessThan(doubt(e("entails", 0.99)));
  });

  it("puts an entailment carried only by the surrounding record before one the quote carries", () => {
    const window = { ...e("entails", 0.9), premise: "window" as const };
    const quote = { ...e("entails", 0.6), premise: "quote" as const };
    expect(doubt(window)).toBeLessThan(doubt(quote));
    // Within the window band, weak first, as with the quote band.
    expect(doubt({ ...window, score: 0.5 })).toBeLessThan(doubt(window));
    // Still after every neutral.
    expect(doubt(e("neutral", 0.5))).toBeLessThan(doubt({ ...window, score: 0.1 }));
  });

  it("reads a missing premise as the quote", () => {
    expect(doubt(e("entails", 0.7))).toBe(doubt({ ...e("entails", 0.7), premise: "quote" }));
  });

  it("puts not-assessed last, after every entailment", () => {
    expect(doubt(null)).toBeGreaterThan(doubt(e("entails", 1.0)));
    expect(doubt(null)).toBeGreaterThan(doubt({ ...e("entails", 1.0), premise: "window" }));
    expect(doubt(undefined)).toBe(doubt(null));
  });

  it("labels only what needs a look", () => {
    expect(entailmentLabel(e("entails", 0.99))).toBe("");
    expect(entailmentLabel(e("neutral", 0.8))).toBe("neutral");
    expect(entailmentLabel(e("contradicts", 0.8))).toBe("contradicts");
    expect(entailmentLabel(null)).toBe("");
  });

  it("orders passages by their most doubtful claim and keeps document order otherwise", () => {
    const passage = (index: number, ents: (ReturnType<typeof e> | null)[]) =>
      ({
        index,
        clusters: [
          {
            id: `c${index}`,
            singleton: false,
            variants: ["a"],
            members: ents.map((en, i) => ({
              variant: "a",
              model: "a",
              claim_id: `${index}-${i}`,
              location: "",
              quote: "q",
              text: "t",
              claim_type: "",
              attestation: "",
              speaker: "",
              refs: [],
              entailment: en,
            })),
          },
        ],
      }) as unknown as import("$lib/api").AuditPassage;
    const ps = [
      passage(0, [null]),
      passage(1, [e("entails", 0.9)]),
      passage(2, [e("neutral", 0.7), e("entails", 0.9)]),
      passage(3, [e("contradicts", 0.6)]),
      passage(4, [null]),
    ];
    expect(doubtfulFirst(ps).map((p) => p.index)).toEqual([3, 2, 1, 0, 4]);
    // The input is not reordered in place.
    expect(ps.map((p) => p.index)).toEqual([0, 1, 2, 3, 4]);
  });
});
