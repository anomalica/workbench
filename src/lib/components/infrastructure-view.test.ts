/**
 * The infrastructure tab reads a database nothing else has ever opened, so the
 * two things worth pinning are the ones a reviewer would act on: which works
 * the corpus is missing, and how many claims are actually on the page.
 */

import { render, screen, waitFor, fireEvent } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import InfrastructureView from "./InfrastructureView.svelte";
import * as api from "$lib/api";

const summary: api.InfrastructureSummary = {
  claims: 4,
  records: 2,
  entities: { document: 3, person: 1, organisation: 0 },
  connected: { document: 3, person: 1 },
  works_named: 3,
  works_held: 1,
  by_type: [
    { type: "administrative", count: 2 },
    { type: "opinion", count: 1 },
    { type: "testimony", count: 1 },
  ],
  suspect: 2,
  works_double_listed: 0,
  works_by_stage: { named: 2, queued: 0, ingested: 0, reviewed: 0, digested: 1 },
};

const works: api.InfrastructureEntity[] = [
  { id: "w1", name: "American Cosmic", mentions: 30, records: 2, stage: "digested", stale: false },
  { id: "w2", name: "Haunted Media", mentions: 3, records: 1, stage: "named", stale: false },
  { id: "w3", name: "Passport to Magonia", mentions: 2, records: 1, stage: "named", stale: false },
];

const claim = (over: Partial<api.InfrastructureClaim>): api.InfrastructureClaim => ({
  content: "something bibliographic",
  claim_type: "administrative",
  attestation: null,
  location_in_record: null,
  origin: null,
  relay: null,
  record_title: "American Cosmic",
  record_hash: "a".repeat(64),
  ...over,
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, "fetchInfrastructure").mockResolvedValue({ summary, records: [] });
  vi.spyOn(api, "fetchInfrastructureEntities").mockResolvedValue(works);
  vi.spyOn(api, "fetchInfrastructureClaims").mockResolvedValue([]);
});

describe("the shelf-check", () => {
  it("counts works we do not hold, and filters to them", async () => {
    render(InfrastructureView, {});
    // The headline number is the acquisition question: named minus held.
    const missing = await screen.findByTitle(/Works our records name but we do not have/);
    expect(missing.textContent?.replace(/\s+/g, " ").trim()).toBe("2 not held");

    await fireEvent.click(screen.getByText("Not held"));
    await waitFor(() => {
      expect(screen.queryByText("American Cosmic")).toBeNull();
      expect(screen.getByText("Haunted Media")).toBeTruthy();
    });
  });

  it("shows every work's pipeline stage on the same track", async () => {
    // One indicator, filled as far as the work has got, on every row - so a
    // reader compares works against each other rather than reading a sentence
    // per work.
    const { container } = render(InfrastructureView, {});
    await screen.findByText("American Cosmic");
    const rows = container.querySelectorAll(
      "button span[title^='Named by'], button span[title^='Claims extracted']",
    );
    expect(rows).toHaveLength(3);
    expect(container.querySelectorAll("button span[title^='Claims extracted']")).toHaveLength(1);
  });
});

describe("the claims view", () => {
  it("states the count it is actually showing, not the count in the database", async () => {
    // The frontend used to cap at 500 while the header said 1,830 - a silent
    // truncation with nothing on the page to reveal it.
    vi.spyOn(api, "fetchInfrastructureClaims").mockResolvedValue([
      claim({ content: "one" }),
      claim({ content: "two" }),
      claim({ content: "three", record_title: "Communion", record_hash: "b".repeat(64) }),
    ]);
    render(InfrastructureView, {});
    await screen.findByText("American Cosmic");
    await fireEvent.click(screen.getByRole("button", { name: "Claims" }));
    await screen.findByText("3 claims across 2 records.");
  });

  it("gathers claims under the record they came from", async () => {
    vi.spyOn(api, "fetchInfrastructureClaims").mockResolvedValue([
      claim({ content: "one" }),
      claim({ content: "two", record_title: "Communion", record_hash: "b".repeat(64) }),
    ]);
    const { container } = render(InfrastructureView, {});
    await screen.findByText("American Cosmic");
    await fireEvent.click(screen.getByRole("button", { name: "Claims" }));
    await waitFor(() => {
      expect(container.querySelectorAll("section[id^='infra-rec-']")).toHaveLength(2);
    });
  });
});

it("says the database is missing rather than showing an empty bibliography", async () => {
  // None means the assimilator has not built it; an empty list would read as
  // "there is nothing in here", which is a different statement.
  vi.spyOn(api, "fetchInfrastructure").mockResolvedValue({ summary: null, records: [] });
  render(InfrastructureView, {});
  await screen.findByText(/hasn't been built yet/);
});
