import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RenameEditor from "./RenameEditor.svelte";

const api = vi.hoisted(() => ({
  fetchNameCheck: vi.fn(),
  fetchNameSuggestions: vi.fn(),
  renameTopic: vi.fn(),
}));

vi.mock("$lib/api", () => api);

describe("RenameEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchNameCheck.mockResolvedValue({ title: "The Greys", warnings: [] });
    api.fetchNameSuggestions.mockResolvedValue([
      {
        id: "existing",
        name: "The Greys",
        node_type: "topic",
        claims: 9,
        exact: true,
      },
    ]);
    api.renameTopic.mockResolvedValue({
      ok: true,
      status: "merged",
      name: "The Greys",
      merged_into: { id: "existing", name: "The Greys", node_type: "topic", claims: 9 },
    });
  });

  it("confirms the merge on Enter when the visible action says merge", async () => {
    const { getByLabelText, getByRole } = render(RenameEditor, {
      props: {
        node: { id: "source", name: "Grey aliens", node_type: "topic", claims: 4 },
        onchanged: vi.fn(),
        oncancel: vi.fn(),
      },
    });
    const input = getByLabelText("New name");

    await fireEvent.input(input, { target: { value: "The Greys" } });
    await waitFor(() => expect(getByRole("button", { name: "Merge into it" })).toBeTruthy());
    await fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(api.renameTopic).toHaveBeenCalledWith(
        "source",
        "Grey aliens",
        "The Greys",
        undefined,
        true,
        undefined,
      ),
    );
  });

  it("requires a second explicit action for a clash discovered by the backend", async () => {
    api.fetchNameSuggestions.mockResolvedValue([]);
    api.renameTopic
      .mockResolvedValueOnce({
        ok: false,
        status: "clash",
        name: "Grey aliens",
        proposal_id: "rename-proposal:p1",
        target: { id: "existing", name: "Taken", node_type: "topic", claims: 9 },
        source: { id: "source", name: "Grey aliens", node_type: "topic", claims: 4 },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: "merged",
        name: "Taken",
        proposal_id: "rename-proposal:p1",
        merged_into: { id: "existing", name: "Taken", node_type: "topic", claims: 9 },
      });
    const { getByLabelText, getByRole } = render(RenameEditor, {
      props: {
        node: { id: "source", name: "Grey aliens", node_type: "topic", claims: 4 },
        onchanged: vi.fn(),
        oncancel: vi.fn(),
      },
    });

    await fireEvent.input(getByLabelText("New name"), { target: { value: "Taken" } });
    await fireEvent.click(getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(getByRole("button", { name: "Confirm merge" })).toBeTruthy());
    expect(api.renameTopic).toHaveBeenNthCalledWith(
      1,
      "source",
      "Grey aliens",
      "Taken",
      undefined,
      false,
      undefined,
    );

    await fireEvent.click(getByRole("button", { name: "Confirm merge" }));
    await waitFor(() =>
      expect(api.renameTopic).toHaveBeenNthCalledWith(
        2,
        "source",
        "Grey aliens",
        "Taken",
        undefined,
        true,
        "rename-proposal:p1",
      ),
    );
  });
});
