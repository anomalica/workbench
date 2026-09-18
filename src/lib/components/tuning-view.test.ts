import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "$lib/api";
import TuningView from "./TuningView.svelte";

const ingest: api.IngestDetail = {
  content_hash: "a".repeat(64),
  public_hash: "a".repeat(56),
  base_record_sha: "b".repeat(40),
  base_ref: "c".repeat(40),
  copyright_status: "public_domain",
  creators: [],
  frontmatter: { title: "Review record" },
  raw_frontmatter: "",
  body: "",
};

const user: api.User = {
  name: "Reviewer",
  email: "reviewer@example.invalid",
  login: "reviewer",
  avatar_url: "",
};

function reviewView(): api.GoldReviewView {
  return {
    schema: "anomalica/highlight-gold-view/1",
    record_hash: `sha256:${"a".repeat(64)}`,
    body_sha256: `sha256:${"d".repeat(64)}`,
    body_length: 800,
    stale: false,
    range: {
      id: "1".repeat(32),
      start: 100,
      end: 700,
      complete: false,
      reviewer: { issuer: "github", subject: "42", name: "Reviewer" },
      updated_at: null,
      units: [],
    },
    progress: { total: 2, resolved: 0, deferred: 0, boundary_count: 1 },
    boundary_cases: [
      { highlight_id: "crossing", parts: [{ start: 690, end: 710, text: "boundary text" }] },
    ],
    batch: [
      {
        highlight_id: "h1",
        parts: [
          { start: 120, end: 130, text: "first part" },
          { start: 150, end: 161, text: "second part" },
        ],
        context: [
          { highlight_id: "parent", parts: [{ start: 101, end: 110, text: "who spoke" }] },
        ],
        context_issue: null,
        proposals: [{ text: "The object was intact.", quote: "object was intact" }],
      },
      {
        highlight_id: "h2",
        parts: [{ start: 200, end: 210, text: "weather" }],
        context: [],
        context_issue: null,
        proposals: [],
      },
    ],
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, "fetchGoldReview").mockResolvedValue(reviewView());
  vi.spyOn(api, "saveGoldBatch").mockResolvedValue({
    ...reviewView(),
    progress: { total: 2, resolved: 2, deferred: 0, boundary_count: 1 },
    batch: [],
  });
});

describe("compact human-gold review", () => {
  it("shows every multipart fragment, ancestor context and only batch proposals", async () => {
    render(TuningView, { ingest, user, onback: vi.fn() });

    await screen.findByText("first part");
    expect(screen.getByText("second part")).toBeTruthy();
    expect(screen.getByText("who spoke")).toBeTruthy();
    expect(screen.getByText("The object was intact.")).toBeTruthy();
    expect(screen.queryByText("complete model claim set")).toBeNull();
    expect(screen.getByText(/1 excluded boundary case/)).toBeTruthy();
  });

  it("saves one explicit decision for every unit in the batch", async () => {
    render(TuningView, { ingest, user, onback: vi.fn() });
    await screen.findByText("The object was intact.");

    await fireEvent.click(screen.getByText("The object was intact."));
    await fireEvent.click(screen.getAllByRole("button", { name: "Reject" })[1]);
    await fireEvent.click(screen.getByRole("button", { name: "Save batch (2)" }));

    await waitFor(() => expect(api.saveGoldBatch).toHaveBeenCalledOnce());
    expect(vi.mocked(api.saveGoldBatch).mock.calls[0][1]).toMatchObject({
      body_sha256: `sha256:${"d".repeat(64)}`,
      range: { id: "1".repeat(32), start: 100, end: 700 },
      decisions: [
        { highlight_id: "h1", decision: "accept", facts: ["The object was intact."] },
        { highlight_id: "h2", decision: "reject" },
      ],
    });
  });

  it("opens an exact bounded range", async () => {
    render(TuningView, { ingest, user, onback: vi.fn() });
    await screen.findByText("first part");
    const fields = screen.getAllByRole("spinbutton");
    await fireEvent.input(fields[0], { target: { value: "200" } });
    await fireEvent.input(fields[1], { target: { value: "500" } });
    await fireEvent.click(screen.getByRole("button", { name: "Open range" }));

    await waitFor(() =>
      expect(api.fetchGoldReview).toHaveBeenLastCalledWith(ingest.content_hash, {
        start: 200,
        end: 500,
      }),
    );
  });
});
