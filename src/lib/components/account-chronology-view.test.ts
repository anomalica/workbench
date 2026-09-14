import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "$lib/api";
import AccountChronologyView from "./AccountChronologyView.svelte";

const hash = "a".repeat(64);

function reviewView(): api.AccountChronologyView {
  return {
    schema: "anomalica/account-chronology-review-view/1",
    report_only: true,
    canonical_activation: "forbidden",
    record_name: "Test account record",
    record_status: "legacy-evidence-not-scoreable",
    record_content_hash: `sha256:${hash}`,
    pre_digest_sha256: "b".repeat(64),
    digest_sha256: "c".repeat(64),
    coordinate_system: "media_time_ms",
    prediction: { status: "blocked", reason: "No exact prediction yet." },
    claims: [
      {
        id: "c1",
        record_content_hash: `sha256:${hash}`,
        position: 1000,
        section: "domain_claims",
        location: "00:00:01.000-00:00:02.000",
        text: "First event",
        quote: "First supplied quote",
      },
      {
        id: "c2",
        record_content_hash: `sha256:${hash}`,
        position: 2000,
        section: "domain_claims",
        location: "00:00:02.000-00:00:03.000",
        text: "Second event",
      },
      {
        id: "lost",
        record_content_hash: `sha256:${hash}`,
        position: null,
        section: "infrastructure_claims",
        text: "No usable location",
      },
    ],
    suggestions: [
      {
        title: "A reviewed account",
        subject: "A reviewed subject",
        summary: "Existing semantic gold.",
        approx_when: "During the test",
      },
    ],
    gold: null,
    gold_sha256: null,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.spyOn(api, "fetchAccountChronology").mockResolvedValue(reviewView());
  vi.spyOn(api, "saveAccountChronology").mockResolvedValue({
    ...reviewView(),
    gold_sha256: "d".repeat(64),
    gold: {
      reviewed_by: "reviewer@example.invalid",
      reviewed_at: "2026-09-14T00:00:00Z",
      accounts: [
        {
          id: "acct-a-reviewed-account",
          title: "A reviewed account",
          spans: [{ start: 500, end: 2500 }],
        },
      ],
      before_pairs: [
        {
          account_id: "acct-a-reviewed-account",
          before_claim_id: "c1",
          after_claim_id: "c2",
        },
      ],
      unknown_pairs: [],
      simultaneous_pairs: [],
    },
  });
});

describe("report-only account chronology review", () => {
  it("guides review in order and hides the exhaustive assignment table", async () => {
    render(AccountChronologyView, { hash });

    await screen.findByText("Account chronology gold");
    expect(screen.getByText("Report only")).toBeTruthy();
    expect(screen.getByText("3 claims")).toBeTruthy();
    expect(screen.getByText(/Prediction blocked/)).toBeTruthy();
    expect(screen.getByText(/A reviewed subject/)).toBeTruthy();

    const suggestions = screen.getByRole("heading", { name: "1. Reviewed suggestions" });
    const evidence = screen.getByRole("heading", { name: "Backend-supplied claim evidence" });
    const boundaries = screen.getByRole("heading", {
      name: "2. Account boundaries and nesting",
    });
    const previews = screen.getByRole("heading", { name: "3. Account claim previews" });
    const chronology = screen.getByRole("heading", { name: "4. Account-scoped chronology" });
    const firstQuote = screen.getAllByText("First supplied quote")[0];
    expect(suggestions.compareDocumentPosition(evidence) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(firstQuote.compareDocumentPosition(boundaries) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(suggestions.compareDocumentPosition(boundaries) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(boundaries.compareDocumentPosition(previews) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(previews.compareDocumentPosition(chronology) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const assignmentDisclosure = screen.getByText("All 3 claim assignments").closest("details");
    expect(assignmentDisclosure?.open).toBe(false);
    expect(screen.queryByText("outside")).toBeNull();
    expect(screen.queryByText("unlocatable")).toBeNull();

    await fireEvent.click(screen.getByText("All 3 claim assignments"));
    expect(screen.getAllByText("not inside an account you have marked").length).toBeGreaterThan(0);
    expect(screen.getAllByText("claim has no usable timestamp").length).toBeGreaterThan(0);
  });

  it("previews member claim text and backend-supplied quote", async () => {
    render(AccountChronologyView, { hash });
    await screen.findAllByText("A reviewed account");
    await fireEvent.click(screen.getByRole("button", { name: "Add legacy account" }));
    await fireEvent.input(screen.getAllByRole("spinbutton")[1], {
      target: { value: "2500" },
    });

    expect(screen.getAllByText("First event").length).toBeGreaterThan(0);
    expect(screen.getAllByText("First supplied quote").length).toBeGreaterThan(1);
  });

  it("saves exact millisecond spans and account-scoped chronology", async () => {
    render(AccountChronologyView, { hash });
    await screen.findAllByText("A reviewed account");
    await fireEvent.click(screen.getByRole("button", { name: "Add legacy account" }));

    const milliseconds = screen.getAllByRole("spinbutton");
    await fireEvent.input(milliseconds[0], { target: { value: "500" } });
    await fireEvent.input(milliseconds[1], { target: { value: "2500" } });
    await fireEvent.click(screen.getByRole("button", { name: "Add pair" }));
    await fireEvent.click(
      screen.getByRole("button", { name: "Validate and save private gold" }),
    );

    await waitFor(() => expect(api.saveAccountChronology).toHaveBeenCalledOnce());
    expect(vi.mocked(api.saveAccountChronology).mock.calls[0]).toEqual([
      hash,
      {
        base_gold_sha256: null,
        accounts: [
          {
            id: "acct-a-reviewed-account",
            title: "A reviewed account",
            spans: [{ start: 500, end: 2500 }],
          },
        ],
        before_pairs: [
          {
            account_id: "acct-a-reviewed-account",
            before_claim_id: "c1",
            after_claim_id: "c2",
          },
        ],
        unknown_pairs: [],
        simultaneous_pairs: [],
      },
    ]);
    expect(await screen.findByText("Evaluator-valid gold saved.")).toBeTruthy();
  });

  it("preserves a stale draft against the latest gold version", async () => {
    localStorage.setItem(
      `workbench:account-chronology:${hash}`,
      JSON.stringify({
        digest_sha256: "c".repeat(64),
        base_gold_sha256: "old-gold",
        accounts: [
          {
            id: "acct-draft",
            title: "Preserved draft",
            spans: [{ start: 500, end: 2500 }],
          },
        ],
        relations: [],
      }),
    );
    vi.mocked(api.fetchAccountChronology).mockResolvedValue({
      ...reviewView(),
      gold_sha256: "latest-gold",
    });

    render(AccountChronologyView, { hash });

    expect(await screen.findByDisplayValue("Preserved draft")).toBeTruthy();
    expect(screen.getByText(/saved gold changed/)).toBeTruthy();
    await fireEvent.click(
      screen.getByRole("button", { name: "Validate and save private gold" }),
    );
    await waitFor(() => expect(api.saveAccountChronology).toHaveBeenCalledOnce());
    expect(vi.mocked(api.saveAccountChronology).mock.calls[0][1].base_gold_sha256).toBe(
      "latest-gold",
    );
  });
});
