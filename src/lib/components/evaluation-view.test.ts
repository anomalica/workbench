import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { beforeEach, expect, it, vi } from "vitest";
import * as api from "$lib/api";
import EvaluationView from "./EvaluationView.svelte";

function state(
  evaluationId: string,
  status: api.EvaluationStatus = "adopted",
): api.EvaluationState {
  return {
    schema: "anomalica/evaluation-state/1",
    evaluation_id: evaluationId,
    evidence: [{ artifact_id: `${evaluationId}-result`, sha256: `sha256:${"a".repeat(64)}` }],
    evidence_sha256: `sha256:${"b".repeat(64)}`,
    status,
    gold: { status: "human-reviewed", reviewed: 1, total: 2, unit: "queries" },
    decision: { code: "retain-minilm", summary: "Retain MiniLM after current evidence review." },
  };
}

const searchEntry: api.EvaluationEntry = {
  id: "search-reranker-minilm-vs-granite",
  title: "MiniLM versus Granite search reranking",
  purpose: "Compare identical candidate pools in one controlled search evaluation.",
  owner_repo: "anomalica/assimilator",
  limits: { rights: "CC0 project-authored claims only.", routes: "Local models only." },
  detail_capability: "search-reranker-comparison",
  detail_available: true,
  state: state("search-reranker-minilm-vs-granite"),
};

function searchDetail(): api.SearchEvaluationDetail {
  return {
    evaluation: searchEntry,
    state: state("search-reranker-minilm-vs-granite", "rejected"),
    fixture: { sha256: "a".repeat(64), license: "CC0-1.0", source: {} },
    models: {
      minilm: {
        name: "MiniLM",
        quality: { ndcg_at_10: 0.5 },
        performance: { query_latency_median_ms: 85, cuda_peak_allocated_mib: 157 },
      },
      granite: {
        name: "Granite English R2",
        quality: { ndcg_at_10: 0.51 },
        performance: { query_latency_median_ms: 404, cuda_peak_allocated_mib: 690 },
      },
    },
    comparison: {
      quality_delta_granite_minus_minilm: { ndcg_at_10: 0.01 },
      resource_ratios_granite_over_minilm: { median_latency: 4.75 },
      criteria: { median_latency_no_more_than_2x: false },
      replace_minilm: false,
    },
    queries: [
      {
        id: "q1",
        query: "carrier pilots see a white craft",
        target: { name: "Nimitz encounter", node_type: "event" },
        total_graph_relevant: 10,
        rankings: {
          minilm: [
            { rank: 1, claim_id: "c1", text: "A project-authored relevant claim.", relevance: 1 },
          ],
          granite: [
            {
              rank: 1,
              claim_id: "c2",
              text: "A project-authored irrelevant claim.",
              relevance: 0,
            },
          ],
        },
      },
    ],
    judgements: {},
    judgement_provenance: null,
    judgements_sha256: null,
  };
}

beforeEach(() => {
  history.replaceState(null, "", "/evaluations?evaluation=search-reranker-minilm-vs-granite");
  vi.restoreAllMocks();
  vi.spyOn(api, "fetchEvaluations").mockResolvedValue({
    schema: "anomalica/evaluation-registry/2",
    state_schema: "anomalica/evaluation-state/1",
    evaluations: [searchEntry],
  });
  vi.spyOn(api, "fetchEvaluation").mockResolvedValue(searchDetail());
  vi.spyOn(api, "saveSearchEvaluationJudgements").mockResolvedValue({
    ...searchDetail(),
    judgements: { q1: { decision: "minilm", note: "Better ordering." } },
    judgements_sha256: "b".repeat(64),
  });
});

it("shows backend-derived index progress and loaded detail status", async () => {
  render(EvaluationView);

  expect(await screen.findByText("Current evidence: rejected")).toBeTruthy();
  const card = screen.getAllByText(searchEntry.title)[0].closest("article");
  expect(card).toBeTruthy();
  expect(within(card!).getByText("adopted")).toBeTruthy();
  expect(within(card!).getByText(/Gold: human reviewed · 1 of 2 queries/)).toBeTruthy();
  expect(within(card!).getByText("Retain MiniLM after current evidence review.")).toBeTruthy();
  expect(screen.getByText("A project-authored relevant claim.")).toBeTruthy();
  expect(screen.getByText("A project-authored irrelevant claim.")).toBeTruthy();
});

it("shows a registry sync error instead of claiming a conclusive status", async () => {
  const brokenEntry: api.EvaluationEntry = {
    ...searchEntry,
    state: undefined,
    detail_available: false,
    sync_error: "Owner evidence is out of sync.",
  };
  vi.mocked(api.fetchEvaluations).mockResolvedValue({
    schema: "anomalica/evaluation-registry/2",
    state_schema: "anomalica/evaluation-state/1",
    evaluations: [brokenEntry],
  });

  render(EvaluationView);

  expect(await screen.findAllByText("Owner evidence is out of sync.")).toHaveLength(2);
  expect(api.fetchEvaluation).not.toHaveBeenCalled();
  expect(screen.queryByText("Current evidence: rejected")).toBeNull();
  expect(screen.queryByText("Current evidence: reviewed")).toBeNull();
});

it("keeps rights and routes methodology collapsed", async () => {
  render(EvaluationView);
  await screen.findByText("MiniLM retained; Granite not adopted");

  const methodology = screen.getByText("Rights and routes methodology").closest("details");
  expect(methodology?.open).toBe(false);
  expect(methodology?.textContent).toContain("CC0 project-authored claims only.");
  expect(methodology?.textContent).toContain("Local models only.");
});

it("links digest reference work to the bare 56-character record gold anchor", async () => {
  const recordId = `sha256:${"c".repeat(64)}`;
  const digestEntry: api.EvaluationEntry = {
    ...searchEntry,
    id: "digest-evaluation-corpus",
    title: "Digest evaluation corpus",
    detail_capability: "digest-evaluation-corpus-detail",
    state: state("digest-evaluation-corpus", "ready-for-human-review"),
  };
  const digestDetail: api.DigestEvaluationDetail = {
    evaluation: digestEntry,
    state: digestEntry.state!,
    items: [
      {
        id: "digest-item",
        record_id: recordId,
        review_id: "review-1",
        status: "ready-for-human-review",
        gold: { status: "ready-for-human-review", reviewed: 0, total: 3, unit: "passages" },
      },
    ],
  };
  history.replaceState(null, "", "/evaluations?evaluation=digest-evaluation-corpus");
  vi.mocked(api.fetchEvaluations).mockResolvedValue({
    schema: "anomalica/evaluation-registry/2",
    state_schema: "anomalica/evaluation-state/1",
    evaluations: [digestEntry],
  });
  vi.mocked(api.fetchEvaluation).mockResolvedValue(digestDetail);

  render(EvaluationView);

  expect(
    await screen.findByRole("heading", {
      name: "Needs reference highlights: choose source passages a good digest must preserve",
    }),
  ).toBeTruthy();
  expect(screen.getByText("0 reference passages selected")).toBeTruthy();
  expect(screen.getByText(/Future outputs for this record will be checked against these passages/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Choose reference passages" }).getAttribute("href")).toBe(
    `/${"c".repeat(56)}#gold`,
  );
});

it("saves Mark's query judgement with the compare-and-swap identity", async () => {
  render(EvaluationView);
  await screen.findByText("MiniLM retained; Granite not adopted");
  await fireEvent.click(screen.getByRole("button", { name: "MiniLM better" }));
  await fireEvent.input(screen.getByRole("textbox", { name: "Reason" }), {
    target: { value: "Better ordering." },
  });
  await fireEvent.click(screen.getByRole("button", { name: "Save authenticated judgements" }));

  await waitFor(() => expect(api.saveSearchEvaluationJudgements).toHaveBeenCalledOnce());
  expect(vi.mocked(api.saveSearchEvaluationJudgements).mock.calls[0][0]).toEqual({
    base_sha256: null,
    fixture_sha256: "a".repeat(64),
    judgements: { q1: { decision: "minilm", note: "Better ordering." } },
  });
});
