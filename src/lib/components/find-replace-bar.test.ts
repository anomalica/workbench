/**
 * In-editor find/replace bar: finds matches in the current record's text,
 * navigates them, and emits replacements (which the parent applies through the
 * document store). No backend, no corpus write.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import FindReplaceBar from "./FindReplaceBar.svelte";

const TEXT = "the cat sat on the cat";

function setup(text = TEXT) {
  const onreplace = vi.fn();
  const onselect = vi.fn();
  const onclose = vi.fn();
  const utils = render(FindReplaceBar, { props: { text, onreplace, onselect, onclose } });
  return { ...utils, onreplace, onselect, onclose };
}

const type = (input: HTMLElement, value: string) => fireEvent.input(input, { target: { value } });

describe("FindReplaceBar", () => {
  beforeEach(() => vi.clearAllMocks());

  it("counts matches live as you type WITHOUT moving the selection", async () => {
    // Regression: calling onselect on every keystroke made the parent focus the
    // editor, stealing focus from the find box mid-word. The count updates, but
    // the selection must not move until the user navigates.
    const { getByPlaceholderText, getByText, onselect } = setup();
    await type(getByPlaceholderText("Find"), "cat");
    await waitFor(() => expect(getByText("1/2")).toBeTruthy());
    expect(onselect).not.toHaveBeenCalled();
  });

  it("next/prev reveal the current match first, then cycle with wrap-around", async () => {
    const { getByPlaceholderText, getByText, getByLabelText, onselect } = setup();
    await type(getByPlaceholderText("Find"), "cat");
    await waitFor(() => expect(getByText("1/2")).toBeTruthy());
    await fireEvent.click(getByLabelText("Next match")); // reveals match 0, not 1
    expect(getByText("1/2")).toBeTruthy();
    expect(onselect).toHaveBeenLastCalledWith(4, 7);
    await fireEvent.click(getByLabelText("Next match"));
    expect(getByText("2/2")).toBeTruthy();
    expect(onselect).toHaveBeenLastCalledWith(19, 22);
    await fireEvent.click(getByLabelText("Next match")); // wraps
    expect(getByText("1/2")).toBeTruthy();
    expect(onselect).toHaveBeenLastCalledWith(4, 7);
  });

  it("replaces the current match only", async () => {
    const { getByPlaceholderText, getByText, onreplace } = setup();
    await type(getByPlaceholderText("Find"), "cat");
    await type(getByPlaceholderText("Replace"), "dog");
    await waitFor(() => expect(getByText("1/2")).toBeTruthy());
    await fireEvent.click(getByText("Replace"));
    expect(onreplace).toHaveBeenCalledWith("the dog sat on the cat");
  });

  it("replaces all matches", async () => {
    const { getByPlaceholderText, getByText, onreplace } = setup();
    await type(getByPlaceholderText("Find"), "cat");
    await type(getByPlaceholderText("Replace"), "dog");
    await waitFor(() => expect(getByText("1/2")).toBeTruthy());
    await fireEvent.click(getByText("All"));
    expect(onreplace).toHaveBeenCalledWith("the dog sat on the dog");
  });

  it("honours case sensitivity", async () => {
    const { getByPlaceholderText, getByText, getByTitle } = setup("Cat cat CAT");
    await type(getByPlaceholderText("Find"), "cat");
    await waitFor(() => expect(getByText("1/3")).toBeTruthy()); // case-insensitive default
    await fireEvent.click(getByTitle("Match case").querySelector("input")!);
    await waitFor(() => expect(getByText("1/1")).toBeTruthy());
  });

  it("regex replacement supports capture groups", async () => {
    const { getByPlaceholderText, getByText, getByTitle, onreplace } = setup("Smith, John");
    await fireEvent.click(getByTitle("Regular expression").querySelector("input")!);
    await type(getByPlaceholderText("Find"), "(\\w+), (\\w+)");
    await type(getByPlaceholderText(/Replace/), "$2 $1");
    await waitFor(() => expect(getByText("1/1")).toBeTruthy());
    await fireEvent.click(getByText("All"));
    expect(onreplace).toHaveBeenCalledWith("John Smith");
  });

  it("a literal replacement containing $ is inserted verbatim", async () => {
    const { getByPlaceholderText, getByText, onreplace } = setup("price is X");
    await type(getByPlaceholderText("Find"), "X");
    await type(getByPlaceholderText("Replace"), "$5");
    await waitFor(() => expect(getByText("1/1")).toBeTruthy());
    await fireEvent.click(getByText("All"));
    expect(onreplace).toHaveBeenCalledWith("price is $5");
  });

  it("shows an error for an invalid regex and closes on the X", async () => {
    const { getByPlaceholderText, getByText, getByLabelText, getByTitle, onclose } = setup();
    await fireEvent.click(getByTitle("Regular expression").querySelector("input")!);
    await type(getByPlaceholderText("Find"), "[unclosed");
    await waitFor(() => expect(getByText("err")).toBeTruthy());
    await fireEvent.click(getByLabelText("Close"));
    expect(onclose).toHaveBeenCalled();
  });
});
