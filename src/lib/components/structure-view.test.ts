import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, expect, it, vi } from "vitest";
import * as api from "$lib/api";
import StructureView from "./StructureView.svelte";

const PDF_RECORD = "a".repeat(64);
const IMAGE_RECORD = "b".repeat(64);
const PDF_ASSET = `sha256:${"c".repeat(64)}`;
const IMAGE_ASSET = `sha256:${"d".repeat(64)}`;
const BASE_REF = "e".repeat(40);

const candidates: api.StructureCandidates = {
  schema: "anomalica/structure-candidates/1",
  viewed_ref: BASE_REF,
  parents: [
    {
      content_hash: `sha256:${PDF_RECORD}`,
      title: "Collected Papers",
      ready: true,
      legacy: false,
      assets: [
        {
          asset_hash: PDF_ASSET,
          source_type: "pdf",
          file_format: "pdf",
          pages: 3,
          copyright_status: "licensed",
        },
      ],
      pages: [
        {
          asset_hash: PDF_ASSET,
          asset_file_page: 1,
          source_type: "pdf",
          excerpt: "First paper text.",
        },
        {
          asset_hash: PDF_ASSET,
          asset_file_page: 2,
          source_type: "pdf",
          excerpt: "Second paper text.",
        },
        {
          asset_hash: PDF_ASSET,
          asset_file_page: 3,
          source_type: "pdf",
          excerpt: "Third paper text.",
        },
      ],
    },
    {
      content_hash: `sha256:${IMAGE_RECORD}`,
      title: "Frontispiece",
      ready: true,
      legacy: false,
      assets: [
        {
          asset_hash: IMAGE_ASSET,
          source_type: "image",
          file_format: "png",
          pages: 1,
          copyright_status: "public_domain",
        },
      ],
      pages: [
        {
          asset_hash: IMAGE_ASSET,
          asset_file_page: 1,
          source_type: "image",
          excerpt: "Portrait and caption.",
        },
      ],
    },
  ],
  blocked: [],
};

function previewFor(request: api.StructureRequest): api.StructurePreview {
  return {
    schema: "anomalica/structure-preview/1",
    viewed_ref: BASE_REF,
    parents: request.parents.map((contentHash) => ({
      content_hash: contentHash,
      title: "Parent",
      retired_into: [`sha256:${"f".repeat(64)}`],
    })),
    outputs: request.outputs.map((output, index) => ({
      content_hash: `sha256:${String(index + 1).repeat(64)}`,
      public_hash: String(index + 1).repeat(56),
      title: output.metadata.title,
      assets: [{}],
      selection: output.selection,
      page_map: output.selection.map((entry, pageIndex) => ({
        record_page: pageIndex + 1,
        asset_hash: entry.asset_hash,
        asset_file_page: entry.selector.type === "pdf_page" ? entry.selector.page : 1,
      })),
      body: "Derived body",
      pre_digest: {
        sha256: `sha256:${"1".repeat(64)}`,
        prep_version: 2,
        source_map_sha256: `sha256:${"2".repeat(64)}`,
      },
    })),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, "fetchStructureCandidates").mockResolvedValue(structuredClone(candidates));
  vi.spyOn(api, "previewStructure").mockImplementation(async (request) => previewFor(request));
  vi.spyOn(api, "commitStructure").mockResolvedValue({
    committed: true,
    commit_ref: "0".repeat(40),
    created: [`sha256:${"f".repeat(64)}`],
    retired: [`sha256:${PDF_RECORD}`],
  });
});

it("previews and commits the exact canonical request", async () => {
  const oncommitted = vi.fn();
  render(StructureView, { oncommitted });

  await fireEvent.click(await screen.findByRole("checkbox", { name: "Select Collected Papers" }));
  await fireEvent.click(screen.getByRole("button", { name: "Preview final Records" }));

  await waitFor(() => expect(api.previewStructure).toHaveBeenCalledOnce());
  const request = vi.mocked(api.previewStructure).mock.calls[0][0];
  expect(request).toEqual({
    schema: "anomalica/record-structure/1",
    viewed_ref: BASE_REF,
    parents: [`sha256:${PDF_RECORD}`],
    outputs: [
      {
        metadata: { title: "Collected Papers - Part 1" },
        selection: [
          { asset_hash: PDF_ASSET, selector: { type: "pdf_page", page: 1 } },
          { asset_hash: PDF_ASSET, selector: { type: "pdf_page", page: 2 } },
        ],
      },
      {
        metadata: { title: "Collected Papers - Part 2" },
        selection: [{ asset_hash: PDF_ASSET, selector: { type: "pdf_page", page: 3 } }],
      },
    ],
  });

  expect(await screen.findByRole("region", { name: "Structure preview" })).toBeTruthy();
  await fireEvent.click(screen.getByRole("button", { name: "Commit structure" }));

  await waitFor(() => expect(api.commitStructure).toHaveBeenCalledOnce());
  expect(api.commitStructure).toHaveBeenCalledWith(request);
  await waitFor(() => expect(oncommitted).toHaveBeenCalledOnce());
  expect(await screen.findByText(/Created 1 Record and retired 1 temporary parent/)).toBeTruthy();
});

it("allows a split to overlap and omit physical pages", async () => {
  render(StructureView);

  await fireEvent.click(await screen.findByRole("checkbox", { name: "Select Collected Papers" }));
  await fireEvent.click(
    screen.getByRole("checkbox", {
      name: "Include PDF page 2 in Collected Papers - Part 2",
    }),
  );
  await fireEvent.click(
    screen.getByRole("checkbox", {
      name: "Include PDF page 3 in Collected Papers - Part 2",
    }),
  );
  await fireEvent.click(screen.getByRole("button", { name: "Preview final Records" }));

  await waitFor(() => expect(api.previewStructure).toHaveBeenCalledOnce());
  expect(vi.mocked(api.previewStructure).mock.calls[0][0].outputs).toEqual([
    {
      metadata: { title: "Collected Papers - Part 1" },
      selection: [
        { asset_hash: PDF_ASSET, selector: { type: "pdf_page", page: 1 } },
        { asset_hash: PDF_ASSET, selector: { type: "pdf_page", page: 2 } },
      ],
    },
    {
      metadata: { title: "Collected Papers - Part 2" },
      selection: [{ asset_hash: PDF_ASSET, selector: { type: "pdf_page", page: 2 } }],
    },
  ]);
});

it("lets a reviewer define a PDF split by inclusive page ranges", async () => {
  render(StructureView);
  await fireEvent.click(await screen.findByRole("checkbox", { name: "Select Collected Papers" }));
  const inputs = screen.getAllByLabelText("PDF pages (for example, 1-3, 5)");
  await fireEvent.input(inputs[0], { target: { value: "1" } });
  await fireEvent.input(inputs[1], { target: { value: "2-3" } });
  await fireEvent.click(screen.getByRole("button", { name: "Preview final Records" }));

  await waitFor(() => expect(api.previewStructure).toHaveBeenCalledOnce());
  const outputs = vi.mocked(api.previewStructure).mock.calls[0][0].outputs;
  expect(outputs[0].selection).toEqual([
    { asset_hash: PDF_ASSET, selector: { type: "pdf_page", page: 1 } },
  ]);
  expect(outputs[1].selection).toEqual([
    { asset_hash: PDF_ASSET, selector: { type: "pdf_page", page: 2 } },
    { asset_hash: PDF_ASSET, selector: { type: "pdf_page", page: 3 } },
  ]);
});

it("prepares selected older records before offering the split preview", async () => {
  const initial = structuredClone(candidates);
  initial.parents[0].ready = false;
  initial.parents[0].legacy = true;
  vi.mocked(api.fetchStructureCandidates).mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(initial).mockResolvedValue(structuredClone(candidates));
  vi.spyOn(api, "prepareStructure").mockResolvedValue({
    content_hash: `sha256:${PDF_RECORD}`, commit_ref: "f".repeat(40),
  });
  render(StructureView);
  await fireEvent.click(await screen.findByRole("checkbox", { name: "Select Collected Papers" }));
  expect(screen.queryByRole("button", { name: "Preview final Records" })).toBeNull();
  await fireEvent.click(screen.getByRole("button", { name: "Prepare selected documents" }));

  await waitFor(() => expect(api.prepareStructure).toHaveBeenCalledWith(`sha256:${PDF_RECORD}`, BASE_REF));
  expect(await screen.findByRole("button", { name: "Preview final Records" })).toBeTruthy();
});

it("composes parents in click order and uses a whole selector for the image", async () => {
  render(StructureView);

  await fireEvent.click(await screen.findByRole("checkbox", { name: "Select Frontispiece" }));
  await fireEvent.click(screen.getByRole("checkbox", { name: "Select Collected Papers" }));
  await fireEvent.click(screen.getByRole("button", { name: "Move PDF page 2 earlier" }));
  await fireEvent.click(screen.getByRole("button", { name: "Preview final Records" }));

  await waitFor(() => expect(api.previewStructure).toHaveBeenCalledOnce());
  const request = vi.mocked(api.previewStructure).mock.calls[0][0];
  expect(request.parents).toEqual([`sha256:${IMAGE_RECORD}`, `sha256:${PDF_RECORD}`]);
  expect(request.outputs).toEqual([
    {
      metadata: { title: "Frontispiece + Collected Papers" },
      selection: [
        { asset_hash: IMAGE_ASSET, selector: { type: "whole" } },
        { asset_hash: PDF_ASSET, selector: { type: "pdf_page", page: 2 } },
        { asset_hash: PDF_ASSET, selector: { type: "pdf_page", page: 1 } },
        { asset_hash: PDF_ASSET, selector: { type: "pdf_page", page: 3 } },
      ],
    },
  ]);
});
