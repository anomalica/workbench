/**
 * GraphNodeDetail surfaces the merge decisions (aliases) prominently and groups
 * a node's claims by source record - the point of the graph-review view.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import GraphNodeDetail from "./GraphNodeDetail.svelte";
import type { GraphNodeDetail as GraphNodeDetailT } from "$lib/api";

const node = (over: Partial<GraphNodeDetailT> = {}): GraphNodeDetailT => ({
  id: "n1",
  name: "Defense Intelligence Agency (DIA)",
  node_type: "organisation",
  aliases: ["DIA", "Defense Intelligence Agency"],
  claim_count: 3,
  claims_truncated: false,
  claims: [
    {
      id: "c1",
      content: "Claim A",
      claim_type: "administrative",
      attestation: "first_hand",
      excerpt: "verbatim A",
      location: "page 1",
      record_title: "Report One",
    },
    { id: "c2", content: "Claim B", claim_type: "observational", record_title: "Report One" },
    { id: "c3", content: "Claim C", claim_type: "administrative", record_title: "Report Two" },
  ],
  ...over,
});

describe("GraphNodeDetail", () => {
  it("shows the entity name, type and every merged surface form", () => {
    const { getByText, getByRole } = render(GraphNodeDetail, { props: { node: node() } });
    getByRole("heading", { name: "Defense Intelligence Agency (DIA)" });
    expect(getByText("organisation")).toBeTruthy();
    // Both aliases (the merge decisions) are rendered.
    expect(getByText("DIA")).toBeTruthy();
    expect(getByText("Defense Intelligence Agency")).toBeTruthy();
    expect(getByText(/Assembled from 2 surface forms/)).toBeTruthy();
  });

  it("groups claims by source record", () => {
    const { getByText, getAllByText } = render(GraphNodeDetail, { props: { node: node() } });
    // Two distinct source records, each shown once as a group header.
    expect(getByText("Report One")).toBeTruthy();
    expect(getByText("Report Two")).toBeTruthy();
    expect(getByText("Claim A")).toBeTruthy();
    expect(getByText("verbatim A")).toBeTruthy();
    // claim_type badges render per claim.
    expect(getAllByText("administrative").length).toBe(2);
  });

  it("states plainly when nothing was merged", () => {
    const { getByText, queryByText } = render(GraphNodeDetail, {
      props: { node: node({ aliases: [] }) },
    });
    expect(getByText(/No merges/)).toBeTruthy();
    expect(queryByText(/Assembled from/)).toBeNull();
  });

  it("flags a truncated claim list", () => {
    const { getByText } = render(GraphNodeDetail, {
      props: { node: node({ claim_count: 900, claims_truncated: true }) },
    });
    expect(getByText(/showing first 3/)).toBeTruthy();
  });

  it("prompts to pick an entity when none is selected", () => {
    const { getByText } = render(GraphNodeDetail, { props: { node: null } });
    expect(getByText(/Select an entity/)).toBeTruthy();
  });
});
