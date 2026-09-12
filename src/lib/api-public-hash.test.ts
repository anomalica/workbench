import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchHousekeepingQueue, fetchIngest, fetchIngests } from "./api";

afterEach(() => vi.unstubAllGlobals());

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("public record identifiers", () => {
  it("uses public_hash as the client-side identity for a gated list row", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response([{ public_hash: "a".repeat(56) }])));

    const rows = await fetchIngests();

    expect(rows[0].content_hash).toBe("a".repeat(56));
  });

  it("uses public_hash as the client-side identity for gated detail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ public_hash: "b".repeat(56) })));

    const detail = await fetchIngest("b".repeat(56));

    expect(detail.content_hash).toBe("b".repeat(56));
  });

  it("normalises gated housekeeping rows without requiring a private hash", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ queue: [{ public_hash: "c".repeat(56) }] })),
    );

    const rows = await fetchHousekeepingQueue();

    expect(rows[0].content_hash).toBe("c".repeat(56));
  });
});
