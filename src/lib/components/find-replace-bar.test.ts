/**
 * In-editor find/replace panel: literal search over the current record's text,
 * a list of every matching line (term highlighted, transcript markers stripped
 * from the display only), and replace-all that edits through the document store.
 * No regex, no backend.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import FindReplaceBar from "./FindReplaceBar.svelte";

function setup(text: string) {
  const onreplace = vi.fn();
  const onlocate = vi.fn();
  const onclose = vi.fn();
  const utils = render(FindReplaceBar, { props: { text, onreplace, onlocate, onclose } });
  return { ...utils, onreplace, onlocate, onclose };
}

const type = (el: HTMLElement, value: string) => fireEvent.input(el, { target: { value } });

describe("FindReplaceBar (split-view panel)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists every matching line with the term highlighted and a count", async () => {
    const { getByPlaceholderText, getByText, container } = setup("the cat sat\na dog\nthe cat ran");
    await type(getByPlaceholderText("Find in this record"), "cat");
    await waitFor(() => expect(getByText("2 matches")).toBeTruthy());
    const marks = container.querySelectorAll("mark");
    expect(marks.length).toBe(2);
    expect([...marks].every((m) => m.textContent === "cat")).toBe(true);
    // The non-matching line isn't listed.
    expect(container.textContent).not.toContain("a dog");
  });

  it("strips {{t:N}} markers from the displayed line but matches/replaces raw", async () => {
    const raw = "{{t:1.00}}Bob {{t:1.50}}cat sat";
    const { getByPlaceholderText, getByText, container, onreplace } = setup(raw);
    await type(getByPlaceholderText("Find in this record"), "cat");
    await waitFor(() => expect(getByText("1 match")).toBeTruthy());
    // Displayed line is clean prose, no markers.
    expect(container.textContent).toContain("Bob cat sat");
    expect(container.textContent).not.toContain("{{t:");
    // Replace operates on the RAW text (markers preserved).
    await type(getByPlaceholderText("Replace with"), "dog");
    await fireEvent.click(getByText("Replace all"));
    expect(onreplace).toHaveBeenCalledWith("{{t:1.00}}Bob {{t:1.50}}dog sat");
  });

  it("replace all replaces every occurrence verbatim", async () => {
    const { getByPlaceholderText, getByText, onreplace } = setup("cat cat cat");
    await type(getByPlaceholderText("Find in this record"), "cat");
    await type(getByPlaceholderText("Replace with"), "dog");
    await waitFor(() => expect(getByText("3 matches")).toBeTruthy());
    await fireEvent.click(getByText("Replace all"));
    expect(onreplace).toHaveBeenCalledWith("dog dog dog");
  });

  it("treats the query literally (regex metacharacters are not special)", async () => {
    const { getByPlaceholderText, getByText } = setup("a.b axb a.b");
    await type(getByPlaceholderText("Find in this record"), "a.b");
    // "a.b" matches the two literal "a.b", NOT "axb" (which a regex `.` would).
    await waitFor(() => expect(getByText("2 matches")).toBeTruthy());
  });

  it("a literal replacement containing $ is inserted verbatim", async () => {
    const { getByPlaceholderText, getByText, onreplace } = setup("price is X");
    await type(getByPlaceholderText("Find in this record"), "X");
    await type(getByPlaceholderText("Replace with"), "$5");
    await waitFor(() => expect(getByText("1 match")).toBeTruthy());
    await fireEvent.click(getByText("Replace all"));
    expect(onreplace).toHaveBeenCalledWith("price is $5");
  });

  it("honours match case", async () => {
    const { getByPlaceholderText, getByText, getByTitle } = setup("Cat cat CAT");
    await type(getByPlaceholderText("Find in this record"), "cat");
    await waitFor(() => expect(getByText("3 matches")).toBeTruthy());
    await fireEvent.click(getByTitle("Match case").querySelector("input")!);
    await waitFor(() => expect(getByText("1 match")).toBeTruthy());
  });

  it("clicking a result line locates the match in the editor (raw offset)", async () => {
    const { getByPlaceholderText, getByTitle, onlocate } = setup("the cat sat");
    await type(getByPlaceholderText("Find in this record"), "cat");
    await waitFor(() => getByTitle("Locate in the editor"));
    await fireEvent.click(getByTitle("Locate in the editor"));
    expect(onlocate).toHaveBeenCalledWith(4, 7);
  });

  it("Esc closes the panel", async () => {
    const { getByPlaceholderText, onclose } = setup("the cat sat");
    await fireEvent.keyDown(getByPlaceholderText("Find in this record"), { key: "Escape" });
    expect(onclose).toHaveBeenCalled();
  });
});
