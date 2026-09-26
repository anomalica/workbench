import { render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestDetail, User } from "$lib/api";
import IngestViewer from "./IngestViewer.svelte";

const chapterOne = `<!-- chapter: 1 -->

{{_kindle_position: 14776}}**CHAPTER 1**

<!-- chapter_title: "An Introduction to the Study of Reincarnation" -->

{{_kindle_position: 14785}}**An Introduction to the Study of Reincarnation**

{{_kindle_position: 14830}}It may disappoint some readers to learn that this book is not about reincarnation directly.
<!-- printed_page: 10 -->
The chapter continues.`;

const ingest: IngestDetail = {
  content_hash: "a".repeat(64),
  public_hash: "a".repeat(56),
  base_record_sha: "b".repeat(40),
  base_ref: "c".repeat(40),
  copyright_status: "public_domain",
  creators: [],
  frontmatter: {
    title: "Children Who Remember Previous Lives",
    source_type: "ebook",
  },
  raw_frontmatter: "---\ntitle: Children Who Remember Previous Lives\nsource_type: ebook\n---\n",
  body: chapterOne,
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

describe("ebook chapter presentation", () => {
  it("keeps the Chapter 1 source headings, adds only a navigation anchor, and retains the printed page", async () => {
    const { container } = render(IngestViewer, {
      props: {
        ingest,
        sourceFile: null,
        user,
        housekeepingState: null,
        onhousekeeping: vi.fn(),
        onback: vi.fn(),
      },
    });

    expect(await screen.findByRole("option", {
      name: "Chapter 1: An Introduction to the Study of Reincarnation",
    })).toBeTruthy();
    expect(screen.getAllByRole("heading", { name: "CHAPTER 1" })).toHaveLength(1);
    expect(screen.getAllByRole("heading", {
      name: "An Introduction to the Study of Reincarnation",
    })).toHaveLength(1);

    await waitFor(() => {
      expect(container.querySelector('[data-chapter-line="0"]')).toHaveClass("ingest-chapter-anchor");
      expect(container.querySelector(".ingest-chapter-divider")).toBeNull();
      expect(container.querySelector('[data-printed-page="10"]')).not.toBeNull();
    });
  });

  it("generates a heading only when a structural label is not printed", async () => {
    const unprinted = {
      ...ingest,
      body: `<!-- chapter_title: "Foreword" -->

This foreword begins without a printed heading.`,
    };
    const { container } = render(IngestViewer, {
      props: {
        ingest: unprinted,
        sourceFile: null,
        user,
        housekeepingState: null,
        onhousekeeping: vi.fn(),
        onback: vi.fn(),
      },
    });

    expect(await screen.findByRole("heading", { name: "Foreword" })).toBeTruthy();
    expect(container.querySelector(".ingest-chapter-divider")).not.toBeNull();
    expect(container.querySelector(".ingest-chapter-anchor")).toBeNull();
  });
});
