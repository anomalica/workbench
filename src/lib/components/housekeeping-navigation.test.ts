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
    schema: "anomalica/housekeeping-view/2",
    access: "full",
    viewed_sidecar_sha: "c".repeat(40),
    viewed_ref: "d".repeat(40),
    viewed_content_hash: `sha256:${hash}`,
    viewed_input_sha256: `sha256:${"b".repeat(64)}`,
    viewed_result_sha256: `sha256:${"b".repeat(64)}`,
    viewed_algorithm_version: "2",
    state: "needs-decisions",
    due_reason: null,
    outstanding_count: 1,
    scopes: ["body"],
    deep_link: `/housekeeping?record=${hash}`,
    previews: { [id]: { removed: ["OSSAP"], added: ["AAWSAP"] } },
    sidecar: {
      schema: "anomalica/housekeeping/3",
      content_hash: `sha256:${hash}`,
      input_sha256: `sha256:${"b".repeat(64)}`,
      result_sha256: `sha256:${"b".repeat(64)}`,
      checked_at: "2026-09-11T00:00:00Z",
      algorithm_version: "2",
      passes: {
        deterministic: { status: "completed", finished_at: "2026-09-11T00:00:00Z" },
        "metadata-research": {
          status: "completed",
          finished_at: "2026-09-11T00:00:00Z",
          usage: {
            transport: "subscription",
            model: "research-model",
            input_tokens: 100,
            output_tokens: 20,
          },
        },
      },
      decisions: [],
      items: [
        {
          id,
          pass: "deterministic",
          category: "known-term",
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
      props: {
        count: 2,
        scopes: ["frontmatter", "body"],
        state: "needs-decisions",
        onopen,
      },
    });

    expect(screen.getByText("2 housekeeping proposals")).toBeTruthy();
    expect(screen.getByText(/metadata and body/)).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Review in Housekeeping" }));
    expect(onopen).toHaveBeenCalledOnce();
  });

  it("does not present pipeline freshness as an actionable proposal", () => {
    render(HousekeepingWarning, {
      props: { count: 0, state: "ready", onopen: vi.fn() },
    });
    expect(screen.queryByLabelText("Housekeeping blocks content review")).toBeNull();
  });

  it.each([
    ["pending-deterministic", /checks are still pending/],
    ["failed-deterministic", /checks failed.*retried successfully/],
    ["pending-research", /research is still pending/],
    ["failed-research", /research failed.*authenticated waiver/],
  ] as const)("explains the %s review block", (state, message) => {
    render(HousekeepingWarning, { props: { count: 0, state, onopen: vi.fn() } });
    expect(screen.getByLabelText("Housekeeping blocks content review").textContent).toMatch(message);
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
      schema: "anomalica/housekeeping-view/2",
      access: "summary",
      state: "needs-decisions",
      due_reason: null,
      outstanding_count: 1,
      scopes: ["body"],
      deep_link: `/housekeeping?record=${hash}`,
      sidecar: null,
    });

    render(HousekeepingView, { props: { initialHash: hash, canDecide: true } });
    expect(await screen.findByText(/prove possession/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
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
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
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
    expect(await screen.findByText(/Older or stale proposals/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
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

  it("stages one proposal at a time and submits the complete set atomically", async () => {
    const hash = "a".repeat(64);
    const next = fullView(hash);
    next.sidecar!.items.push({
      id: "metadata-2",
      pass: "metadata-research",
      category: "metadata",
      check: "publisher",
      operation: "set",
      field: "publisher",
      current: null,
      proposed: "Archive",
      confidence: "medium",
      evidence: { reasoning: "The source identifies the archive.", sources: [], record_spans: ["title"] },
      status: "proposed",
    });
    next.outstanding_count = 2;
    vi.spyOn(api, "fetchHousekeepingQueue").mockResolvedValue([]);
    vi.spyOn(api, "fetchHousekeeping").mockResolvedValue({ ...next, state: "ready" });
    const decide = vi.spyOn(api, "decideHousekeeping").mockResolvedValue({ applied: 1, rejected: 1 });

    render(HousekeepingView, {
      props: { initialHash: hash, initialView: next, canDecide: true },
    });

    const apply = screen.getByRole("button", { name: "Apply all decisions" });
    expect(apply).toBeDisabled();
    await fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("The source identifies the archive.")).toBeTruthy();
    expect(apply).toBeDisabled();
    await fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(apply).not.toBeDisabled();
    await fireEvent.click(apply);

    await waitFor(() =>
      expect(decide).toHaveBeenCalledWith(hash, next, [
        { item_id: "proposal-1", status: "approved" },
        { item_id: "metadata-2", status: "rejected" },
      ]),
    );
  });

  it("shows failed research and sends an audited waiver reason", async () => {
    const hash = "a".repeat(64);
    const pending = fullView(hash);
    pending.state = "failed-research";
    pending.outstanding_count = 0;
    pending.sidecar!.passes["metadata-research"] = {
      status: "failed",
      finished_at: "2026-09-17T00:00:00Z",
      error: "Research provider unavailable.",
    };
    vi.spyOn(api, "fetchHousekeepingQueue").mockResolvedValue([]);
    vi.spyOn(api, "fetchHousekeeping").mockResolvedValue(pending);
    const waive = vi.spyOn(api, "waiveHousekeepingResearch").mockResolvedValue();

    render(HousekeepingView, {
      props: { initialHash: hash, initialView: pending, canDecide: true },
    });

    expect(screen.getByText("Research provider unavailable.")).toBeTruthy();
    await fireEvent.input(screen.getByLabelText("Continue without metadata research"), {
      target: { value: "Checked the source manually." },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Waive research" }));
    await waitFor(() =>
      expect(waive).toHaveBeenCalledWith(hash, pending, "Checked the source manually."),
    );
  });

  it("shows decision and waiver audit history", async () => {
    const hash = "a".repeat(64);
    const complete = fullView(hash);
    complete.state = "ready";
    complete.outstanding_count = 0;
    complete.sidecar!.items[0].status = "approved";
    complete.sidecar!.decisions = [{
      item_id: "proposal-1",
      status: "approved",
      decided_at: "2026-09-17T02:00:00Z",
      decided_by: "reviewer@example.test",
    }];
    complete.sidecar!.passes["metadata-research"] = {
      status: "waived",
      finished_at: "2026-09-17T01:00:00Z",
      waiver: {
        by: "reviewer@example.test",
        at: "2026-09-17T01:00:00Z",
        reason: "Primary source already checked.",
      },
    };
    vi.spyOn(api, "fetchHousekeepingQueue").mockResolvedValue([]);

    render(HousekeepingView, { props: { initialHash: hash, initialView: complete } });

    expect(screen.getAllByText(/Primary source already checked/).length).toBeGreaterThan(0);
    expect(screen.getByText(/proposal-1/)).toBeTruthy();
    expect(screen.getAllByText(/reviewer@example.test/).length).toBeGreaterThan(0);
  });
});
