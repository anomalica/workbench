import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decideHousekeeping,
  waiveHousekeepingResearch,
  reviewBaseFor,
  saveAccountChronology,
  saveSearchEvaluationJudgements,
  submitReview,
  submitVerification,
  unlockedIngestFromVerification,
  type HousekeepingFullView,
  type AccountChronologySave,
} from "./api";

afterEach(() => vi.unstubAllGlobals());

function captureFetch(response: object = { ok: true }) {
  const calls: { url: string; method?: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) });
    return Promise.resolve(new Response(JSON.stringify(response), { status: 200 }));
  });
  return calls;
}

describe("canonical write identities", () => {
  it("submits the exact loaded record blob and ref at top level", async () => {
    const calls = captureFetch();
    const hash = "a".repeat(64);
    await submitReview(hash, "---\ntitle: T\n---\nBody\n", "Checked", {
      base_record_sha: "b".repeat(40),
      base_ref: "c".repeat(40),
    });

    expect(calls[0]).toEqual({
      url: `/api/ingests/${hash}`,
      method: "PUT",
      body: {
        content: "---\ntitle: T\n---\nBody\n",
        notes: "Checked",
        base_record_sha: "b".repeat(40),
        base_ref: "c".repeat(40),
      },
    });
  });

  it("returns the committed identity for another submit in the same editor", async () => {
    const fresh = { base_ref: "d".repeat(40), base_record_sha: "e".repeat(40) };
    captureFetch({ submitted: true, ...fresh });

    const result = await submitReview("a".repeat(64), "record", "", {
      base_record_sha: "b".repeat(40),
      base_ref: "c".repeat(40),
    });

    expect(result).toMatchObject({
      ok: true,
      baseRef: fresh.base_ref,
      baseRecordSha: fresh.base_record_sha,
    });
  });

  it("submits fresh unlock identities and resets them when the record changes", async () => {
    const firstHash = "a".repeat(64);
    const secondHash = "d".repeat(64);
    const fresh = { base_record_sha: "e".repeat(40), base_ref: "f".repeat(40) };
    const firstSnapshot = { base_record_sha: "b".repeat(40), base_ref: "c".repeat(40) };
    const secondSnapshot = { base_record_sha: "1".repeat(40), base_ref: "2".repeat(40) };
    const calls: { url: string; method?: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) });
      const response =
        init?.method === "POST"
          ? {
              passed: true,
              body: "Committed body\n",
              raw_frontmatter: "---\ntitle: T\n---\n",
              ...fresh,
            }
          : { ok: true };
      return Promise.resolve(new Response(JSON.stringify(response), { status: 200 }));
    });

    const verification = await submitVerification(firstHash, { sha256: "0".repeat(64) });
    const unlocked = unlockedIngestFromVerification(firstHash, verification);
    await submitReview(
      firstHash,
      "---\ntitle: T\n---\nEdited body\n",
      "Checked",
      reviewBaseFor(firstHash, firstSnapshot, unlocked),
    );

    expect(calls[1].body).toMatchObject(fresh);
    expect(reviewBaseFor(secondHash, secondSnapshot, unlocked)).toEqual(secondSnapshot);
  });

  it("sends only the canonical decision schema, viewed identities and decisions", async () => {
    const calls = captureFetch({ applied: 1, rejected: 0 });
    const hash = "a".repeat(64);
    const view: HousekeepingFullView = {
      schema: "anomalica/housekeeping-view/2",
      access: "full",
      viewed_sidecar_sha: "b".repeat(40),
      viewed_ref: "c".repeat(40),
      viewed_content_hash: `sha256:${hash}`,
      viewed_input_sha256: `sha256:${"d".repeat(64)}`,
      viewed_result_sha256: `sha256:${"e".repeat(64)}`,
      viewed_algorithm_version: "2",
      state: "needs-decisions",
      due_reason: null,
      outstanding_count: 1,
      scopes: ["body"],
      deep_link: `/housekeeping?record=${hash}`,
      sidecar: {
        schema: "anomalica/housekeeping/3",
        content_hash: `sha256:${hash}`,
        input_sha256: `sha256:${"d".repeat(64)}`,
        result_sha256: `sha256:${"e".repeat(64)}`,
        checked_at: "2026-09-17T00:00:00Z",
        algorithm_version: "2",
        passes: {},
        decisions: [],
        items: [{
          id: "rename-1",
          pass: "deterministic",
          category: "known-term",
          check: "canonical-name",
          operation: "replace-token",
          scope: "body",
          old_token: "OLD",
          new_token: "NEW",
          case_sensitive: true,
          token_boundary: "ascii-word",
          occurrences: [{ start_byte: 10, end_byte: 13 }],
          expected_count: 1,
          confidence: "high",
          evidence: { reasoning: "Canonical form.", sources: [], record_spans: ["body"] },
          status: "proposed",
        }],
      },
      previews: {},
    };
    await decideHousekeeping(hash, view, [{ item_id: "rename-1", status: "approved" }]);

    expect(calls[0].body).toEqual({
      schema: "anomalica/housekeeping-decision/2",
      viewed_sidecar_sha: "b".repeat(40),
      viewed_ref: "c".repeat(40),
      viewed_content_hash: `sha256:${hash}`,
      viewed_input_sha256: `sha256:${"d".repeat(64)}`,
      viewed_result_sha256: `sha256:${"e".repeat(64)}`,
      viewed_algorithm_version: "2",
      decisions: [{ item_id: "rename-1", status: "approved" }],
    });
  });

  it("rejects duplicate decisions before issuing a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const view = {
      access: "full",
      viewed_sidecar_sha: "b".repeat(40),
      viewed_result_sha256: `sha256:${"c".repeat(64)}`,
    } as HousekeepingFullView;
    await expect(
      decideHousekeeping("a".repeat(64), view, [
        { item_id: "same", status: "approved" },
        { item_id: "same", status: "rejected" },
      ]),
    ).rejects.toThrow(/every proposed item exactly once/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends only the waiver schema, viewed identities and trimmed reason", async () => {
    const calls = captureFetch({});
    const hash = "a".repeat(64);
    const view = {
      schema: "anomalica/housekeeping-view/2",
      access: "full",
      viewed_sidecar_sha: "b".repeat(40),
      viewed_ref: "c".repeat(40),
      viewed_content_hash: `sha256:${hash}`,
      viewed_input_sha256: `sha256:${"d".repeat(64)}`,
      viewed_result_sha256: `sha256:${"e".repeat(64)}`,
      viewed_algorithm_version: "2",
      state: "pending-research",
      due_reason: null,
      outstanding_count: 0,
      scopes: [],
      deep_link: `/housekeeping?record=${hash}`,
      sidecar: null,
      previews: {},
    } satisfies HousekeepingFullView;

    await waiveHousekeepingResearch(hash, view, "  Source lookup unavailable.  ");

    expect(calls[0]).toEqual({
      url: `/api/ingests/${hash}/housekeeping/waive-research`,
      method: "POST",
      body: {
        schema: "anomalica/housekeeping-research-waiver/1",
        viewed_sidecar_sha: "b".repeat(40),
        viewed_ref: "c".repeat(40),
        viewed_content_hash: `sha256:${hash}`,
        viewed_input_sha256: `sha256:${"d".repeat(64)}`,
        viewed_result_sha256: `sha256:${"e".repeat(64)}`,
        viewed_algorithm_version: "2",
        reason: "Source lookup unavailable.",
      },
    });
  });

  it("sends only report decisions and the private-gold compare-and-swap identity", async () => {
    const calls = captureFetch();
    const hash = "a".repeat(64);
    const body: AccountChronologySave = {
      base_gold_sha256: "b".repeat(64),
      accounts: [{ id: "account-1", spans: [{ start: 1000, end: 2000 }] }],
      before_pairs: [],
      unknown_pairs: [],
      simultaneous_pairs: [],
    };

    await saveAccountChronology(hash, body);

    expect(calls[0]).toEqual({
      url: `/api/ingests/${hash}/account-chronology`,
      method: "PUT",
      body,
    });
  });

  it("sends fixture-bound search judgements to the private evaluation route", async () => {
    const calls = captureFetch();
    const body = {
      base_sha256: "b".repeat(64),
      fixture_sha256: "c".repeat(64),
      judgements: { q1: { decision: "minilm", note: "Better ordering." } },
    };

    await saveSearchEvaluationJudgements(body);

    expect(calls[0]).toEqual({
      url: "/api/evaluations/search-reranker-minilm-vs-granite/judgements",
      method: "PUT",
      body,
    });
  });
});
