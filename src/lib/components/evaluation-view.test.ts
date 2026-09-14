import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, expect, it, vi } from "vitest";
import * as api from "$lib/api";
import EvaluationView from "./EvaluationView.svelte";

const searchEntry: api.EvaluationEntry = {
  id: "search-reranker-minilm-vs-granite",
  title: "MiniLM versus Granite search reranking",
  purpose: "Compare identical candidate pools.",
  owner_repo: "anomalica/assimilator",
  status: "adopted",
  gold: { status: "reviewed-derived", provenance: "Graph-derived relevance labels." },
  limits: { rights: "CC0 project-authored claims only.", routes: "Local models only." },
  decision: "Retain MiniLM; Granite failed the quality and resource gates.",
};

function detail(): api.SearchEvaluationDetail {
  return {
    evaluation: searchEntry,
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
            { rank: 1, claim_id: "c2", text: "A project-authored irrelevant claim.", relevance: 0 },
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
    schema: "anomalica/evaluation-registry/1",
    statuses: ["proposed", "ready-for-human-review", "reviewed", "adopted", "rejected", "blocked"],
    gold_statuses: [],
    evaluations: [searchEntry],
  });
  vi.spyOn(api, "fetchEvaluation").mockResolvedValue(detail());
  vi.spyOn(api, "saveSearchEvaluationJudgements").mockResolvedValue({
    ...detail(),
    judgements: { q1: { decision: "minilm", note: "Better ordering." } },
    judgements_sha256: "b".repeat(64),
  });
});

it("shows the adopted MiniLM decision with side-by-side authored claims", async () => {
  render(EvaluationView);

  expect(await screen.findByText(/Retain MiniLM; Granite failed/)).toBeTruthy();
  expect(screen.getByText("MiniLM retained; Granite not adopted")).toBeTruthy();
  expect(screen.getByText("A project-authored relevant claim.")).toBeTruthy();
  expect(screen.getByText("A project-authored irrelevant claim.")).toBeTruthy();
  expect(screen.getByText("graph relevant")).toBeTruthy();
  expect(screen.getByText("not graph relevant")).toBeTruthy();
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
