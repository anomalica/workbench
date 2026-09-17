import { render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestDetail, User } from "$lib/api";
import IngestViewer from "./IngestViewer.svelte";

const ingest: IngestDetail = {
  content_hash: "a".repeat(64),
  public_hash: "a".repeat(56),
  base_record_sha: "b".repeat(40),
  base_ref: "c".repeat(40),
  copyright_status: "public_domain",
  creators: [],
  frontmatter: { title: "Gate test", source_type: "web" },
  raw_frontmatter: "---\ntitle: Gate test\nsource_type: web\n---\n",
  body: "Body remains readable.\n",
};

const user: User = {
  name: "Reviewer",
  email: "reviewer@example.test",
  login: "reviewer",
  avatar_url: "",
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const body = input.endsWith("/relations")
      ? []
      : input.endsWith("/coverage")
        ? { reviews: [] }
        : input.endsWith("/supersession")
          ? { exists: true, superseded_by: null, public_supersedes: null }
          : {};
    return new Response(JSON.stringify(body), { status: 200 });
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe("housekeeping content-review gate", () => {
  it("keeps due content read-only and removes editing entry points", () => {
    render(IngestViewer, {
      props: {
        ingest,
        sourceFile: null,
        user,
        housekeepingState: "due",
        onhousekeeping: vi.fn(),
        onback: vi.fn(),
      },
    });

    expect(screen.getByLabelText("Housekeeping blocks content review")).toBeTruthy();
    expect(screen.getByText(/read-only preview/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Raw" })).toBeNull();
    expect(screen.getByRole("button", { name: "Housekeeping required" })).toBeDisabled();
  });

  it("permits grandfathered content review", () => {
    render(IngestViewer, {
      props: {
        ingest,
        sourceFile: null,
        user,
        housekeepingState: "excluded-review-state",
        onhousekeeping: vi.fn(),
        onback: vi.fn(),
      },
    });

    expect(screen.queryByLabelText("Housekeeping blocks content review")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Raw" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).not.toBeDisabled();
  });
});
