/**
 * Find/replace view: literal search over the record's prose (annotations
 * hidden), every occurrence listed with the change shown inline, and
 * per-occurrence control over what gets replaced.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import FindReplaceView from "./FindReplaceView.svelte";

function setup(text: string, seed = "", seedSeq = 0) {
  const onreplace = vi.fn();
  const onclose = vi.fn();
  const utils = render(FindReplaceView, { props: { text, seed, seedSeq, onreplace, onclose } });
  return { ...utils, onreplace, onclose };
}

const type = (el: HTMLElement, value: string) => fireEvent.input(el, { target: { value } });
const rows = (c: HTMLElement) => c.querySelectorAll('input[aria-label="Include this occurrence"]');

async function search(utils: ReturnType<typeof setup>, query: string, replacement?: string) {
  await type(utils.getByPlaceholderText("Find in this record"), query);
  if (replacement !== undefined) {
    await type(utils.getByPlaceholderText("Replace with"), replacement);
  }
}

describe("FindReplaceView", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists every occurrence with the match highlighted and a count", async () => {
    const u = setup("the cat sat\na dog\nthe cat ran");
    await search(u, "cat");
    await waitFor(() => expect(u.getByText("2 matches")).toBeTruthy());
    expect(rows(u.container as HTMLElement)).toHaveLength(2);
    const marks = u.container.querySelectorAll("mark");
    expect([...marks].map((m) => m.textContent)).toEqual(["cat", "cat"]);
  });

  it("finds a multi-word phrase split across word timestamps", async () => {
    const raw = "{{t:1.00}}my {{t:1.50}}consciousness {{t:2.00}}was";
    expect(raw).not.toContain("my consciousness"); // not present in the raw body
    const u = setup(raw);
    await search(u, "my consciousness");
    await waitFor(() => expect(u.getByText("1 match")).toBeTruthy());
    expect(u.container.textContent).not.toContain("{{t:");
  });

  it("shows no timestamps or speaker names in the results", async () => {
    const u = setup("<!-- speaker: Bob -->\n{{t:1.00}}the {{t:1.50}}cat");
    await search(u, "cat");
    await waitFor(() => expect(u.getByText("1 match")).toBeTruthy());
    expect(u.container.textContent).not.toContain("Bob");
    expect(u.container.textContent).not.toContain("{{t:");
  });

  it("previews the change inline once a replacement is typed", async () => {
    const u = setup("the cat sat");
    await search(u, "cat", "dog");
    // The preview is debounced - wait for it, don't assume it lands with the input.
    await waitFor(() => expect(u.container.querySelector("ins")?.textContent).toBe("dog"));
    expect(u.container.querySelector("del")?.textContent).toBe("cat");
  });

  it("preserves whitespace in the preview so a bad replacement is visible", async () => {
    const u = setup("a  cat  b");
    await search(u, "cat", "dog");
    await waitFor(() => expect(u.container.querySelector("ins")).toBeTruthy());
    const line = u.container.querySelector("p.whitespace-pre-wrap");
    expect(line?.textContent).toBe("a  catdog  b");
  });

  it("replaces with what is in the box even if clicked inside the debounce window", async () => {
    const u = setup("the cat");
    await search(u, "cat");
    await waitFor(() => expect(u.getByText("1 match")).toBeTruthy());
    // Type and click immediately: no waiting for the preview to catch up.
    await type(u.getByPlaceholderText("Replace with"), "dog");
    await fireEvent.click(u.getByText("Replace selected"));
    expect(u.onreplace).toHaveBeenCalledWith("the dog");
  });

  it("replaces just one occurrence from its own Replace button", async () => {
    const u = setup("cat cat cat");
    await search(u, "cat", "dog");
    await waitFor(() => expect(u.getAllByTitle("Replace just this occurrence")).toHaveLength(3));
    await fireEvent.click(u.getAllByTitle("Replace just this occurrence")[1]);
    expect(u.onreplace).toHaveBeenCalledWith("cat dog cat");
  });

  it("replaces every occurrence when all are selected", async () => {
    const u = setup("cat cat cat");
    await search(u, "cat", "dog");
    await waitFor(() => expect(u.getByText("3 of 3 selected")).toBeTruthy());
    await fireEvent.click(u.getByText("Replace selected"));
    expect(u.onreplace).toHaveBeenCalledWith("dog dog dog");
  });

  it("skips an occurrence the reviewer unticks", async () => {
    const u = setup("cat cat cat");
    await search(u, "cat", "dog");
    await waitFor(() => expect(rows(u.container as HTMLElement)).toHaveLength(3));
    await fireEvent.click(rows(u.container as HTMLElement)[1]);
    await waitFor(() => expect(u.getByText("2 of 3 selected")).toBeTruthy());
    await fireEvent.click(u.getByText("Replace selected"));
    expect(u.onreplace).toHaveBeenCalledWith("dog cat dog");
  });

  it("Select none disables Replace selected; Select all restores it", async () => {
    const u = setup("cat cat");
    await search(u, "cat", "dog");
    await waitFor(() => expect(u.getByText("2 of 2 selected")).toBeTruthy());
    await fireEvent.click(u.getByText("Select none"));
    await waitFor(() => expect(u.getByText("0 of 2 selected")).toBeTruthy());
    expect((u.getByText("Replace selected") as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.click(u.getByText("Select all"));
    await waitFor(() => expect(u.getByText("2 of 2 selected")).toBeTruthy());
    expect((u.getByText("Replace selected") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a cross-timestamp replacement keeps the timestamp it spanned", async () => {
    const u = setup("{{t:1.00}}my {{t:1.50}}cat {{t:2.00}}sat");
    await search(u, "my cat", "our dog");
    await waitFor(() => expect(u.getByText("1 match")).toBeTruthy());
    await fireEvent.click(u.getByText("Replace selected"));
    expect(u.onreplace).toHaveBeenCalledWith("{{t:1.00}}our dog{{t:1.50}} {{t:2.00}}sat");
  });

  it("treats the query literally and inserts $ verbatim", async () => {
    const u = setup("a.b axb");
    await search(u, "a.b", "$5");
    await waitFor(() => expect(u.getByText("1 match")).toBeTruthy());
    await fireEvent.click(u.getByText("Replace selected"));
    expect(u.onreplace).toHaveBeenCalledWith("$5 axb");
  });

  it("honours match case", async () => {
    const u = setup("Cat cat CAT");
    await search(u, "cat");
    await waitFor(() => expect(u.getByText("3 matches")).toBeTruthy());
    await fireEvent.click(u.getByTitle("Match case").querySelector("input")!);
    await waitFor(() => expect(u.getByText("1 match")).toBeTruthy());
  });

  it("an empty replacement deletes the match, once the field is touched", async () => {
    const u = setup("a bad word");
    await search(u, "bad ", "x");
    await search(u, "bad ", "");
    await waitFor(() => expect(u.getByText("1 match")).toBeTruthy());
    await fireEvent.click(u.getByText("Replace selected"));
    expect(u.onreplace).toHaveBeenCalledWith("a word");
  });

  it("Replace is disabled until a replacement is typed", async () => {
    const u = setup("the cat");
    await search(u, "cat");
    await waitFor(() => expect(u.getByText("1 match")).toBeTruthy());
    expect((u.getByText("Replace selected") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a seeded query runs the search immediately", async () => {
    const u = setup("the cat sat", "cat", 1);
    await waitFor(() => expect(u.getByText("1 match")).toBeTruthy());
    expect((u.getByPlaceholderText("Find in this record") as HTMLInputElement).value).toBe("cat");
  });

  it("a seeded multi-word phrase runs against the prose, not the raw body", async () => {
    const u = setup("{{t:1.00}}my {{t:1.50}}cat", "my cat", 1);
    await waitFor(() => expect(u.getByText("1 match")).toBeTruthy());
  });

  it("reports no matches rather than an empty list", async () => {
    const u = setup("the cat");
    await search(u, "zebra");
    await waitFor(() => expect(u.getByText("No matches.")).toBeTruthy());
  });

  it("Esc closes the view", async () => {
    const u = setup("the cat");
    await fireEvent.keyDown(u.getByPlaceholderText("Find in this record"), { key: "Escape" });
    expect(u.onclose).toHaveBeenCalled();
  });
});
