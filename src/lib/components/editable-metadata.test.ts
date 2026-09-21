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
    expect(getByPlaceholderText("1947, 1947-06 or 1947-06-24")).toHaveValue("2020-08");
    expect(
      getByPlaceholderText("2026-08-20 or 2026-08-20T12:30:00+09:00"),
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

  it("accepts a date-only access value", async () => {
    const { getByRole, onsave } = subject({ dateAccessed: "2026-09-21" });

    await fireEvent.click(getByRole("button", { name: "Edit" }));
    await fireEvent.click(getByRole("button", { name: "Save" }));

    expect(onsave).toHaveBeenCalledWith(
      expect.objectContaining({ dateAccessed: "2026-09-21" }),
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
