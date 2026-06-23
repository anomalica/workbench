/**
 * The browse list surfaces observed coverage as a progress bar in the
 * Digestible cell - green and full when digestible (100%), the in-progress
 * fill below that - so half-finished records are scannable at a glance.
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/svelte";
import IngestList from "./IngestList.svelte";
import type { IngestSummary } from "$lib/api";

function ingest(over: Partial<IngestSummary>): IngestSummary {
  return {
    content_hash: "h",
    public_hash: "h",
    title: "T",
    creators: [],
    date: "",
    date_ingested: "",
    source_type: "web",
    source_url: "",
    source_file: "",
    source_hash: "",
    provenance: "",
    publisher: "",
    copyright_status: "public_domain",
    digestible: false,
    observed_coverage: 0,
    digested: false,
    ...over,
  };
}

function bars(container: HTMLElement) {
  return [...container.querySelectorAll('span[title*="observed"]')].map((cell) => {
    const fill = [...cell.querySelectorAll("span")].pop() as HTMLElement;
    return {
      width: fill.style.width,
      className: fill.className,
      title: cell.getAttribute("title"),
    };
  });
}

const props = (ingests: IngestSummary[]) => ({
  ingests,
  sortBy: "date",
  sortAsc: false,
  onsort: vi.fn(),
  onselect: vi.fn(),
});

describe("IngestList digestible progress bar", () => {
  it("shows a full green bar when digestible and a partial fill in progress", () => {
    const { container } = render(IngestList, {
      props: props([
        ingest({ content_hash: "done", digestible: true, observed_coverage: 1 }),
        ingest({ content_hash: "wip", digestible: false, observed_coverage: 0.205 }),
        ingest({ content_hash: "fresh", digestible: false, observed_coverage: 0 }),
      ]),
    });
    const [done, wip, fresh] = bars(container);

    expect(done.width).toBe("100%");
    expect(done.className).toContain("bg-success");
    expect(done.title).toContain("100% observed");

    expect(wip.width).toBe("20%"); // floored from 20.5
    expect(wip.className).toContain("bg-primary");
    expect(wip.title).toContain("20% observed");

    expect(fresh.width).toBe("0%");
  });
});
