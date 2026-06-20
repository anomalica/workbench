/**
 * Schedule view (read-only shell, sample queue). Guards the lane model +
 * grouping logic; documents the intended behaviour the real-data wiring must
 * preserve.
 */

import { describe, it, expect } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import ScheduleView from "./ScheduleView.svelte";

describe("ScheduleView", () => {
  it("defaults to By lane, showing the three resource lanes", () => {
    const { getByText } = render(ScheduleView);
    expect(getByText(/Claude lane/)).toBeTruthy();
    expect(getByText(/GPU lane/)).toBeTruthy();
    expect(getByText(/Review lane/)).toBeTruthy();
  });

  it("Review lane ranks records by demand, highest first", () => {
    const { container } = render(ScheduleView);
    const demands = [...container.querySelectorAll("span")]
      .map((s) => (s.textContent || "").trim())
      .filter((t) => /^d \d+$/.test(t))
      .map((t) => Number(t.slice(2)));
    expect(demands.length).toBeGreaterThan(0);
    expect(demands).toEqual([...demands].sort((a, b) => b - a));
  });

  it("By article orders by chain value and marks the earliest-stage job next", async () => {
    const { getByText, container } = render(ScheduleView);
    await fireEvent.click(getByText("By article"));
    await waitFor(() => {
      const heads = [...container.querySelectorAll("h3")].map((h) => h.textContent || "");
      const nimitz = heads.findIndex((h) => h.includes("Nimitz"));
      const stargate = heads.findIndex((h) => h.includes("Project Stargate"));
      expect(nimitz).toBeGreaterThanOrEqual(0);
      expect(nimitz).toBeLessThan(stargate); // live chain over alphabetical
    });
    const markers = [...container.querySelectorAll("span")]
      .map((s) => (s.textContent || "").trim())
      .filter((t) => t === "next →" || t === "next");
    expect(markers).toContain("next →"); // eligible front-of-chain
    expect(markers).toContain("next"); // gated front-of-chain still marked
  });

  it("does not force an evidence chip onto every job (per-job drivers)", () => {
    const { container } = render(ScheduleView);
    const evidence = [...container.querySelectorAll("span")].filter((s) =>
      (s.textContent || "").trim().startsWith("evidence:"),
    );
    expect(evidence.length).toBe(0);
  });

  it("shows the dry-run preview", () => {
    const { getByText } = render(ScheduleView);
    expect(getByText(/Tonight's run/)).toBeTruthy();
  });
});
