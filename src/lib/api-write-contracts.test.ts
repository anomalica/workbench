import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decideHousekeeping,
  reviewBaseFor,
  submitReview,
  submitVerification,
  unlockedIngestFromVerification,
  type HousekeepingFullView,
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
      schema: "anomalica/housekeeping-view/1",
      access: "full",
      viewed_sidecar_sha: "b".repeat(40),
      viewed_ref: "c".repeat(40),
      viewed_content_hash: `sha256:${hash}`,
      viewed_input_sha256: `sha256:${"d".repeat(64)}`,
      viewed_algorithm_version: "housekeeping-v2",
      state: "current",
      due_reason: null,
      outstanding_count: 1,
      scopes: ["body"],
      deep_link: `/housekeeping?record=${hash}`,
      sidecar: null,
      previews: {},
    };
    await decideHousekeeping(hash, view, [{ item_id: "rename-1", status: "approved" }]);

    expect(calls[0].body).toEqual({
      schema: "anomalica/housekeeping-decision/1",
      viewed_sidecar_sha: "b".repeat(40),
      viewed_ref: "c".repeat(40),
      viewed_content_hash: `sha256:${hash}`,
      viewed_input_sha256: `sha256:${"d".repeat(64)}`,
      viewed_algorithm_version: "housekeeping-v2",
      decisions: [{ item_id: "rename-1", status: "approved" }],
    });
  });

  it("rejects duplicate decisions before issuing a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const view = {
      access: "full",
      viewed_sidecar_sha: "b".repeat(40),
    } as HousekeepingFullView;
    await expect(
      decideHousekeeping("a".repeat(64), view, [
        { item_id: "same", status: "approved" },
        { item_id: "same", status: "rejected" },
      ]),
    ).rejects.toThrow(/non-empty and unique/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
