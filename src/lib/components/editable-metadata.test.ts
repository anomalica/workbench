import { fireEvent, render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import EditableMetadata from "./EditableMetadata.svelte";

function subject(overrides: Record<string, unknown> = {}) {
  const onsave = vi.fn();
  const view = render(EditableMetadata, {
    props: {
      title: "Record",
      publisher: "",
      creators: [],
      datePublished: "2020-08",
      sourceUrl: "https://example.com/source",
      dateAccessed: "2026-09-21T10:15:30.123456+09:00",
      canEdit: true,
      onsave,
      ...overrides,
    },
  });
  return { ...view, onsave };
}

describe("EditableMetadata dates", () => {
  it("preserves publication precision and a complete offset access timestamp", async () => {
    const { getByRole, getByPlaceholderText, onsave } = subject();

    await fireEvent.click(getByRole("button", { name: "Edit" }));
    expect(
      getByPlaceholderText("1947, 1947-06, 1947-06-24 or an offset time"),
    ).toHaveValue("2020-08");
    expect(
      getByPlaceholderText("2026-08-20T12:30:00+09:00"),
    ).toHaveValue(
      "2026-09-21T10:15:30.123456+09:00",
    );

    await fireEvent.click(getByRole("button", { name: "Save" }));
    expect(onsave).toHaveBeenCalledWith(
      expect.objectContaining({
        datePublished: "2020-08",
        dateAccessed: "2026-09-21T10:15:30.123456+09:00",
      }),
    );
  });

  it("preserves an existing date-only access value", async () => {
    const { getByRole, onsave } = subject({ dateAccessed: "2026-09-21" });

    await fireEvent.click(getByRole("button", { name: "Edit" }));
    await fireEvent.click(getByRole("button", { name: "Save" }));

    expect(onsave).toHaveBeenCalledWith(
      expect.objectContaining({ dateAccessed: "2026-09-21" }),
    );
  });

  it("does not produce a new date-only access value", async () => {
    const { getByRole, getByPlaceholderText, onsave } = subject();

    await fireEvent.click(getByRole("button", { name: "Edit" }));
    await fireEvent.input(getByPlaceholderText("2026-08-20T12:30:00+09:00"), {
      target: { value: "2026-09-22" },
    });
    await fireEvent.click(getByRole("button", { name: "Save" }));

    expect(onsave).not.toHaveBeenCalled();
  });

  it("rejects calendar dates that only match the lexical shape", async () => {
    const { getByRole, getByPlaceholderText, onsave } = subject();

    await fireEvent.click(getByRole("button", { name: "Edit" }));
    await fireEvent.input(
      getByPlaceholderText("1947, 1947-06, 1947-06-24 or an offset time"),
      { target: { value: "2026-02-31" } },
    );
    await fireEvent.click(getByRole("button", { name: "Save" }));

    expect(onsave).not.toHaveBeenCalled();
  });

  it("accepts an offset publication timestamp when the source provides one", async () => {
    const published = "2026-09-21T10:15:30+09:00";
    const { getByRole, onsave } = subject({ datePublished: published });

    await fireEvent.click(getByRole("button", { name: "Edit" }));
    await fireEvent.click(getByRole("button", { name: "Save" }));

    expect(onsave).toHaveBeenCalledWith(
      expect.objectContaining({ datePublished: published }),
    );
  });

  it("preserves legacy offset timestamps while editing other metadata", async () => {
    const legacy = "2026-07-24 10:00:00+09:00";
    const { getByRole, getByLabelText, onsave } = subject({ dateAccessed: legacy });

    await fireEvent.click(getByRole("button", { name: "Edit" }));
    await fireEvent.input(getByLabelText("Title"), { target: { value: "Renamed" } });
    await fireEvent.click(getByRole("button", { name: "Save" }));

    expect(onsave).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Renamed", dateAccessed: legacy }),
    );
  });
});

describe("EditableMetadata copy axis", () => {
  it("shows the channel and its post date beside the work's own metadata", () => {
    // posted_by/posted_date describe THIS COPY - the channel that posted it and
    // when. They are not publisher and published, and the panel keeps them
    // apart rather than folding a re-upload into the work's identity.
    const { getByText } = subject({
      postedBy: "Eyes On Cinema",
      postedDate: "2026-06-24T08:45:30+00:00",
    });
    expect(getByText("Posted by").parentElement).toHaveTextContent("Eyes On Cinema");
    expect(getByText("Posted").parentElement).toHaveTextContent("2026-06-24T08:45:30+00:00");
  });

  it("hides the copy rows when the record carries none", () => {
    const { queryByText } = subject();
    expect(queryByText("Posted by")).toBeNull();
    expect(queryByText("Posted")).toBeNull();
  });

  it("saves the copy axis with the rest of the metadata", async () => {
    const { getByRole, getByPlaceholderText, onsave } = subject();

    await fireEvent.click(getByRole("button", { name: "Edit" }));
    await fireEvent.input(getByPlaceholderText("e.g. Eyes On Cinema"), {
      target: { value: "A Channel" },
    });
    await fireEvent.input(getByPlaceholderText("2026-06-24 or 2026-06-24T08:45:30+00:00"), {
      target: { value: "2026-06-04" },
    });
    await fireEvent.click(getByRole("button", { name: "Save" }));

    expect(onsave).toHaveBeenCalledWith(
      expect.objectContaining({ postedBy: "A Channel", postedDate: "2026-06-04" }),
    );
  });

  it("rejects a post date that is not a real date", async () => {
    const { getByRole, getByPlaceholderText, onsave } = subject();

    await fireEvent.click(getByRole("button", { name: "Edit" }));
    await fireEvent.input(
      getByPlaceholderText("2026-06-24 or 2026-06-24T08:45:30+00:00"),
      { target: { value: "2026-02-31" } },
    );
    await fireEvent.click(getByRole("button", { name: "Save" }));

    expect(onsave).not.toHaveBeenCalled();
  });
});
