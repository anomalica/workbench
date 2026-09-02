import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import ToolbarMenu from "./ToolbarMenu.svelte";

const options = [
  { id: "all", label: "All", count: 40 },
  { id: "podcast", label: "Podcast", count: 12 },
  { id: "pdf", label: "PDF", count: 3 },
];

function mount(value = "all") {
  const onpick = vi.fn();
  const r = render(ToolbarMenu, { label: "Type", value, options, onpick });
  return { ...r, onpick };
}

describe("ToolbarMenu", () => {
  it("shows the current choice and nothing else until opened", () => {
    const { getByRole, queryByRole } = mount("podcast");
    expect(getByRole("button", { name: /Podcast/ })).toBeTruthy();
    expect(queryByRole("listbox")).toBeNull();
  });

  it("lists every option with how many records it leaves", async () => {
    const { getByRole, getAllByRole } = mount();
    await fireEvent.click(getByRole("button", { name: /All/ }));
    const items = getAllByRole("option");
    expect(items.map((o) => o.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "All 40",
      "Podcast 12",
      "PDF 3",
    ]);
  });

  it("reports a pick and closes", async () => {
    const { getByRole, queryByRole, onpick } = mount();
    await fireEvent.click(getByRole("button", { name: /All/ }));
    await fireEvent.click(getByRole("option", { name: /PDF/ }));
    expect(onpick).toHaveBeenCalledWith("pdf");
    expect(queryByRole("listbox")).toBeNull();
  });

  it("closes on a click elsewhere without picking", async () => {
    const { getByRole, queryByRole, onpick } = mount();
    await fireEvent.click(getByRole("button", { name: /All/ }));
    expect(queryByRole("listbox")).toBeTruthy();
    await fireEvent.mouseDown(document.body);
    expect(queryByRole("listbox")).toBeNull();
    expect(onpick).not.toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    const { getByRole, queryByRole } = mount();
    await fireEvent.click(getByRole("button", { name: /All/ }));
    await fireEvent.keyDown(document, { key: "Escape" });
    expect(queryByRole("listbox")).toBeNull();
  });

  it("falls back to the raw value when it is not in the list", () => {
    // A type filter saved from a record that has since been archived must
    // still show what it is filtering by, not a blank button.
    const { getByRole } = mount("memo");
    expect(getByRole("button", { name: /memo/ })).toBeTruthy();
  });
});
