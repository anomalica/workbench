/**
 * Schedule view (read-only, fed the live scheduler queue via a prop). Guards the
 * tabbed lane model, the loading/empty states, and - the point of Mark's review
 * - that it never fabricates dollar costs, budgets, dry-runs or scores.
 */

import { describe, it, expect } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import ScheduleView from "./ScheduleView.svelte";
import { SAMPLE_QUEUE, type ScheduleQueue } from "$lib/schedule";

const sample = () => render(ScheduleView, { props: { queue: SAMPLE_QUEUE } });

describe("ScheduleView", () => {
  it("shows a loading state until the queue arrives", () => {
    const { getByText } = render(ScheduleView, { props: { queue: null } });
    expect(getByText(/Loading the queue/)).toBeTruthy();
  });

  it("shows an empty state when the scheduler hasn't run", () => {
    const empty: ScheduleQueue = { generatedAt: null, jobs: [], reviewQueue: [], recordDemand: {} };
    const { getByText } = render(ScheduleView, { props: { queue: empty } });
    expect(getByText(/hasn't produced a queue/)).toBeTruthy();
  });

  it("defaults to the Claude tab", () => {
    const { getByText } = sample();
    expect(getByText(/Claude lane/)).toBeTruthy();
  });

  it("has a tab per lane plus By article (no By value)", () => {
    const { getAllByText, queryByText } = sample();
    for (const t of ["Claude", "GPU", "Review", "By article"]) {
      expect(getAllByText(t).length).toBeGreaterThan(0);
    }
    expect(queryByText("By value")).toBeNull();
  });

  it("does NOT fabricate dollars, budgets, a dry-run, or scores", () => {
    const { container } = sample();
    const text = container.textContent || "";
    expect(text).not.toMatch(/\$\d/);
    expect(text).not.toContain("Tonight's run");
    expect(text.toLowerCase()).not.toContain("needs $ approval");
    expect(text).not.toMatch(/\bvalue \d/);
    expect(text).not.toMatch(/\d+\s*\/\s*\d+\s*tokens/);
  });

  it("GPU tab is transcription jobs (one per video)", async () => {
    const { getByText, container } = sample();
    await fireEvent.click(getByText("GPU"));
    await waitFor(() => expect(getByText(/transcription jobs, one per video/)).toBeTruthy());
    const types = [...container.querySelectorAll("span")]
      .map((s) => (s.textContent || "").trim().toLowerCase())
      .filter((t) => t === "transcribe");
    expect(types.length).toBeGreaterThan(0);
  });

  it("By article tab marks the earliest-stage job next", async () => {
    const { getByText, container } = sample();
    await fireEvent.click(getByText("By article"));
    await waitFor(() => {
      const markers = [...container.querySelectorAll("span")]
        .map((s) => (s.textContent || "").trim())
        .filter((t) => t === "next →" || t === "next");
      expect(markers.length).toBeGreaterThan(0);
    });
  });

  it("notes the eager background plumbing as a footnote", () => {
    const { getByText } = sample();
    expect(getByText(/Background \(eager/)).toBeTruthy();
  });
});
