import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "$lib/api";
import type { HousekeepingFullView } from "$lib/api";
import HousekeepingView from "./HousekeepingView.svelte";
import HousekeepingWarning from "./HousekeepingWarning.svelte";

beforeEach(() => {
  vi.restoreAllMocks();
});

function fullView(
  hash: string,
  id = "proposal-1",
  reasoning = "Source title differs.",
): HousekeepingFullView {
  return {
    schema: "anomalica/housekeeping-view/1",
    access: "full",
    viewed_sidecar_sha: "c".repeat(40),
    viewed_ref: "d".repeat(40),
    viewed_content_hash: `sha256:${hash}`,
    viewed_input_sha256: `sha256:${"b".repeat(64)}`,
    viewed_algorithm_version: "housekeeping-v2",
    state: "current",
    due_reason: null,
    outstanding_count: 1,
    scopes: ["body"],
    deep_link: `/housekeeping?record=${hash}`,
    previews: { [id]: { removed: ["OSSAP"], added: ["AAWSAP"] } },
    sidecar: {
      schema: "anomalica/housekeeping/2",
      content_hash: `sha256:${hash}`,
      input_sha256: `sha256:${"b".repeat(64)}`,
      checked_at: "2026-09-11T00:00:00Z",
      algorithm_version: "housekeeping-v2",
      outcome: "completed",
      items: [
        {
          id,
          check: "canonical-programme-name",
          operation: "replace-token",
          scope: "body",
          old_token: "OSSAP",
          new_token: "AAWSAP",
          case_sensitive: true,
          token_boundary: "ascii-word",
          occurrences: [{ start_byte: 20, end_byte: 25 }],
          expected_count: 1,
          confidence: "high",
          evidence: { reasoning, sources: [], record_spans: [] },
          status: "proposed",
        },
      ],
    },
  };
}

describe("housekeeping record navigation", () => {
  it("warns before editing and offers the Housekeeping review path", async () => {
    const onopen = vi.fn();
    render(HousekeepingWarning, {
      props: { count: 2, scopes: ["frontmatter", "body"], onopen },
    });

    expect(screen.getByText("2 housekeeping proposals")).toBeTruthy();
    expect(screen.getByText(/metadata and body/)).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Review in Housekeeping" }));
    expect(onopen).toHaveBeenCalledOnce();
  });

  it("does not present pipeline freshness as an actionable proposal", () => {
    render(HousekeepingWarning, { props: { count: 0, onopen: vi.fn() } });
    expect(screen.queryByLabelText("Outstanding housekeeping proposals")).toBeNull();
  });

  it("opens the requested record and reads previews outside the raw sidecar", async () => {
    const hash = "a".repeat(64);
    vi.spyOn(api, "fetchHousekeepingQueue").mockResolvedValue([]);
    const fetchRecord = vi.spyOn(api, "fetchHousekeeping").mockResolvedValue(fullView(hash));

    render(HousekeepingView, { props: { initialHash: hash } });

    await waitFor(() => expect(fetchRecord).toHaveBeenCalledWith(hash));
    expect(await screen.findByText("Source title differs.")).toBeTruthy();
    expect(screen.getByText("OSSAP → AAWSAP")).toBeTruthy();
    expect(screen.getByText("- OSSAP")).toBeTruthy();
    expect(screen.getByText("+ AAWSAP")).toBeTruthy();
  });

  it("keeps a summary view read-only even for an authorised reviewer", async () => {
    const hash = "a".repeat(64);
    vi.spyOn(api, "fetchHousekeepingQueue").mockResolvedValue([]);
    vi.spyOn(api, "fetchHousekeeping").mockResolvedValue({
      schema: "anomalica/housekeeping-view/1",
      access: "summary",
      state: "current",
      due_reason: null,
      outstanding_count: 1,
      scopes: ["body"],
      deep_link: `/housekeeping?record=${hash}`,
      sidecar: null,
    });

    render(HousekeepingView, { props: { initialHash: hash, canDecide: true } });
    expect(await screen.findByText(/prove possession/)).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Reject/ })).toBeNull();
  });

  it("uses the one-shot full view from possession verification without refetching", async () => {
    const hash = "a".repeat(64);
    vi.spyOn(api, "fetchHousekeepingQueue").mockResolvedValue([]);
    const fetchRecord = vi.spyOn(api, "fetchHousekeeping");

    render(HousekeepingView, {
      props: { initialHash: hash, initialView: fullView(hash), canDecide: true },
    });

    expect(await screen.findByText("Source title differs.")).toBeTruthy();
    expect(fetchRecord).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: /Approve/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
  });

  it("shows due proposals for context but offers no decision controls", async () => {
    const hash = "a".repeat(64);
    const due = fullView(hash);
    due.state = "due";
    due.due_reason = "unsupported-schema";
    due.outstanding_count = 0;
    due.scopes = [];
    vi.spyOn(api, "fetchHousekeepingQueue").mockResolvedValue([]);
    vi.spyOn(api, "fetchHousekeeping").mockResolvedValue(due);

    render(HousekeepingView, { props: { initialHash: hash, canDecide: true } });
    expect(await screen.findByText(/older format/)).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Reject/ })).toBeNull();
  });

  it("does not let a slow earlier selection replace the latest record", async () => {
    const firstHash = "a".repeat(64);
    const secondHash = "e".repeat(64);
    vi.spyOn(api, "fetchHousekeepingQueue").mockResolvedValue([
      {
        content_hash: firstHash,
        title: "First",
        copyright_status: "public_domain",
        checked_at: null,
        proposed: 1,
        approved: 0,
        rejected: 0,
      },
      {
        content_hash: secondHash,
        title: "Second",
        copyright_status: "public_domain",
        checked_at: null,
        proposed: 1,
        approved: 0,
        rejected: 0,
      },
    ]);
    let resolveFirst!: (view: HousekeepingFullView) => void;
    let resolveSecond!: (view: HousekeepingFullView) => void;
    vi.spyOn(api, "fetchHousekeeping").mockImplementation(
      (hash) =>
        new Promise((resolve) => {
          if (hash === firstHash) resolveFirst = resolve;
          else resolveSecond = resolve;
        }),
    );

    render(HousekeepingView);
    await fireEvent.click(await screen.findByRole("button", { name: /First/ }));
    await fireEvent.click(screen.getByRole("button", { name: /Second/ }));
    resolveSecond(fullView(secondHash, "second", "Latest response."));
    expect(await screen.findByText("Latest response.")).toBeTruthy();
    resolveFirst(fullView(firstHash, "first", "Stale response."));
    await Promise.resolve();
    expect(screen.queryByText("Stale response.")).toBeNull();
    expect(screen.getByText("Latest response.")).toBeTruthy();
  });
});
