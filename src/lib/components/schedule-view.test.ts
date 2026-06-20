/**
 * Schedule view (read-only, illustrative placeholder). Guards the tabbed lane
 * model and - the point of Mark's review - that the placeholder does NOT
 * fabricate dollar costs, budgets, run-times, scores or a nightly runner that
 * look like real data.
 */

import { describe, it, expect } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import ScheduleView from "./ScheduleView.svelte";

describe("ScheduleView", () => {
  it("defaults to the Claude tab and flags itself illustrative", () => {
    const { getByText } = render(ScheduleView);
    expect(getByText(/Claude lane/)).toBeTruthy();
    expect(getByText(/Illustrative placeholder/)).toBeTruthy();
  });

  it("has a tab per lane plus By article (no By value)", () => {
    const { getAllByText, queryByText } = render(ScheduleView);
    // "Claude"/"GPU" also appear as card lane badges, so just require >=1.
    for (const t of ["Claude", "GPU", "Review", "By article"]) {
      expect(getAllByText(t).length).toBeGreaterThan(0);
    }
    expect(queryByText("By value")).toBeNull();
  });

  it("does NOT fabricate dollars, budgets, a dry-run, or scores", () => {
    const { container } = render(ScheduleView);
    const text = container.textContent || "";
    expect(text).not.toMatch(/\$\d/); // no dollar amounts
    expect(text).not.toContain("Tonight's run"); // no invented nightly runner
    expect(text.toLowerCase()).not.toContain("needs $ approval");
    expect(text).not.toMatch(/\bvalue \d/); // no fabricated VALUE scores
    expect(text).not.toMatch(/\d+\s*\/\s*\d+\s*tokens/); // no invented token budget
  });

  it("GPU tab is transcription jobs (one per video)", async () => {
    const { getByText, container } = render(ScheduleView);
    await fireEvent.click(getByText("GPU"));
    await waitFor(() => expect(getByText(/one transcription job per queued video/)).toBeTruthy());
    const types = [...container.querySelectorAll("span")]
      .map((s) => (s.textContent || "").trim().toLowerCase())
      .filter((t) => t === "transcribe");
    expect(types.length).toBeGreaterThan(0);
  });

  it("By article tab marks the earliest-stage job next", async () => {
    const { getByText, container } = render(ScheduleView);
    await fireEvent.click(getByText("By article"));
    await waitFor(() => {
      const markers = [...container.querySelectorAll("span")]
        .map((s) => (s.textContent || "").trim())
        .filter((t) => t === "next →" || t === "next");
      expect(markers.length).toBeGreaterThan(0);
    });
  });

  it("notes the eager background plumbing as a footnote, not a lane", () => {
    const { getByText, queryByText } = render(ScheduleView);
    expect(getByText(/Background \(eager/)).toBeTruthy();
    // it isn't a tab
    expect(queryByText("Background")).toBeNull();
  });
});
