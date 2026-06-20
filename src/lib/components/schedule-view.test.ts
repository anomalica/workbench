/**
 * Schedule view (read-only shell over a sample queue). Guards the grouping +
 * "what's next" logic the spec-review pinned down - if the sample queue is
 * later swapped for the real scheduler output, these assertions document the
 * intended behaviour the wiring must preserve.
 */

import { describe, it, expect } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import ScheduleView from "./ScheduleView.svelte";

describe("ScheduleView", () => {
  it("defaults to By article, ordered by chain value not alphabetically", () => {
    const { container } = render(ScheduleView);
    const heads = [...container.querySelectorAll("h3")].map((h) => h.textContent || "");
    const nimitz = heads.findIndex((h) => h.includes("Nimitz"));
    const stargate = heads.findIndex((h) => h.includes("Project Stargate"));
    expect(nimitz).toBeGreaterThanOrEqual(0);
    expect(stargate).toBeGreaterThanOrEqual(0);
    // Nimitz (highest-value live chain) ranks above the alphabetically-earlier
    // "Project Stargate" - throughput favours the started chain.
    expect(nimitz).toBeLessThan(stargate);
  });

  it("marks the earliest-stage job as next: runnable vs waiting", () => {
    const { container } = render(ScheduleView);
    const markers = [...container.querySelectorAll("span")]
      .map((s) => (s.textContent || "").trim())
      .filter((t) => t === "next →" || t === "next");
    expect(markers).toContain("next →"); // an eligible front-of-chain
    expect(markers).toContain("next"); // a gated front-of-chain still marked
  });

  it("does not force an evidence chip onto every job (per-job drivers)", () => {
    const { container } = render(ScheduleView);
    const evidence = [...container.querySelectorAll("span")].filter((s) =>
      (s.textContent || "").trim().startsWith("evidence:"),
    );
    expect(evidence.length).toBe(0);
  });

  it("shows the dry-run preview and the review-backlog panel", () => {
    const { getByText, container } = render(ScheduleView);
    expect(getByText(/Tonight's run/)).toBeTruthy();
    expect(container.querySelector("#review-backlog")).not.toBeNull();
  });

  it("By lane shows the Claude queue and the Local lane", async () => {
    const { getByText, getAllByText } = render(ScheduleView);
    await fireEvent.click(getByText("By lane"));
    await waitFor(() => expect(getAllByText(/Claude queue/).length).toBeGreaterThan(0));
    expect(getAllByText(/Local lane/).length).toBeGreaterThan(0);
  });
});
