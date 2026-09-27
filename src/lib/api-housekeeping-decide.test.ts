import { afterEach, describe, expect, it, vi } from "vitest";
import { decideHousekeeping, type HousekeepingFullView } from "./api";

const hash = "a".repeat(64);
const view = {
  schema: "anomalica/housekeeping-view/2",
  access: "full",
  viewed_sidecar_sha: "b".repeat(40),
  viewed_ref: "c".repeat(40),
  viewed_content_hash: `sha256:${hash}`,
  viewed_input_sha256: `sha256:${"d".repeat(64)}`,
  viewed_result_sha256: `sha256:${"d".repeat(64)}`,
  viewed_algorithm_version: "2",
  review_state: "needs-decisions",
  due_reason: null,
  outstanding_count: 1,
  scopes: ["body"],
  deep_link: `/housekeeping?record=${hash}`,
  previews: {},
  sidecar: { items: [{ id: "proposal", status: "proposed" }] },
} as HousekeepingFullView;
const decisions = [{ item_id: "proposal", status: "approved" as const }];

afterEach(() => vi.unstubAllGlobals());

describe("housekeeping decision concurrency", () => {
  it("retries when only the Git ref changed", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Stale housekeeping proposal" }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...view, viewed_ref: "e".repeat(40) })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ applied: 1, rejected: 0 })));
    vi.stubGlobal("fetch", fetch);

    expect(await decideHousekeeping(hash, view, decisions)).toEqual({ applied: 1, rejected: 0 });
    expect(JSON.parse(fetch.mock.calls[2][1].body).viewed_ref).toBe("e".repeat(40));
  });

  it("does not retry if the proposal sidecar changed", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Stale housekeeping proposal" }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...view, viewed_sidecar_sha: "f".repeat(40) })));
    vi.stubGlobal("fetch", fetch);

    await expect(decideHousekeeping(hash, view, decisions)).rejects.toThrow("proposals changed");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
