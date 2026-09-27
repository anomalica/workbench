/**
 * The browse list surfaces observed coverage as a progress bar in the
 * Digestible cell - green and full when digestible (100%), the in-progress
 * fill below that - so half-finished records are scannable at a glance.
 */

import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import IngestList from "./IngestList.svelte";
import type { IngestSummary } from "$lib/api";

function ingest(over: Partial<IngestSummary>): IngestSummary {
  return {
    content_hash: "h",
    public_hash: "h",
    title: "T",
    schema_version: 1,
    creators: [],
    date: "",
    date_ingested: "",
    source_type: "web",
    pipeline_status: "unknown",
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
    const fill = cell.querySelector('span[style*="width"]') as HTMLElement;
    return {
      width: fill.style.width,
      className: fill.className,
      title: cell.getAttribute("title"),
      label: cell.lastElementChild?.textContent?.trim(),
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
    expect(done.label).toBe("100%");

    expect(wip.width).toBe("20%"); // floored from 20.5
    expect(wip.className).toContain("bg-primary");
    expect(wip.title).toContain("20% observed");
    expect(wip.label).toBe("20%");

    expect(fresh.width).toBe("0%");
    expect(fresh.label).toBe("0%");
  });

  it("labels a digestible-but-undigested record Ready, never a bare No", () => {
    const { container } = render(IngestList, {
      props: props([
        ingest({ content_hash: "ready", digestible: true, digested: false }),
        ingest({ content_hash: "built", digestible: true, digested: true }),
        ingest({ content_hash: "todo", digestible: false, digested: false }),
      ]),
    });
    const cells = [...container.querySelectorAll("div[role='button'] .w-20.font-ui")].map((c) =>
      c.textContent?.trim(),
    );
    expect(cells).toEqual(["Ready", "Yes", "No"]);
  });
});

describe("selecting documents for combination", () => {
  it("uses checkboxes or Ctrl-click without opening a record", async () => {
    const onselect = vi.fn();
    const oncompositionselect = vi.fn();
    const { container } = render(IngestList, {
      props: {
        ...props([
          ingest({ content_hash: "pdf", title: "First PDF", source_type: "pdf" }),
          ingest({ content_hash: "image", title: "Second image", source_type: "image" }),
          ingest({ content_hash: "web", title: "Web article", source_type: "web" }),
        ]),
        selectedForComposition: new Set(["pdf"]),
        onselect,
        oncompositionselect,
      },
    });

    expect((screen.getByRole("checkbox", { name: "Select First PDF for combination" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole("checkbox", { name: "Select Web article for combination" })).toBeNull();
    await fireEvent.click(screen.getByRole("checkbox", { name: "Select First PDF for combination" }));
    await fireEvent.click(container.querySelectorAll('div[role="button"]')[1], { ctrlKey: true });
    expect(oncompositionselect.mock.calls).toEqual([["pdf"], ["image"]]);
    expect(onselect).not.toHaveBeenCalled();

    await fireEvent.click(container.querySelectorAll('div[role="button"]')[2]);
    expect(onselect).toHaveBeenCalledWith("web");
  });
});
