/**
 * Regression test for the claim deep-link (Review-in-workbench links of the
 * form /<public_hash>#claim-<uuid>).
 *
 * The cold-load path failed because IngestViewer's $effect called
 * _scrollToClaimFromHash, which reads AND writes cols / collapsed /
 * selectedClaimId - so its own writes re-triggered the effect forever
 * (effect_update_depth_exceeded), and the scroll never landed. This mounts the
 * viewer with a #claim- hash present from the start (cold load) and asserts the
 * matching claim card is found and gets .claim-selected - which only happens if
 * the effect does NOT loop. Removing the untrack guard makes the mount throw,
 * failing this test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor } from "@testing-library/svelte";
import IngestViewer from "./IngestViewer.svelte";
import type { IngestDetail, DigestDocument } from "$lib/api";

const CLAIM_ID = "abcdef12-3456-4789-abcd-ef0123456789"; // 36-char uuid form

const INGEST: IngestDetail = {
  content_hash: "f".repeat(64),
  public_hash: "f".repeat(56),
  copyright_status: "public_domain",
  creators: [],
  frontmatter: { title: "Deep-link Test Record", source_type: "web" },
  raw_frontmatter: '---\ntitle: "Deep-link Test Record"\nsource_type: web\n---\n',
  body: "# Deep-link Test Record\n\nSome body text for the record.\n",
};

const DIGEST: DigestDocument = {
  schema: "anomalica/digest/1",
  extracted_at: "2026-01-01T00:00:00Z",
  model: "test",
  record: { id: "f".repeat(64), title: "Deep-link Test Record" },
  nodes: [],
  domain_claims: [
    {
      id: CLAIM_ID,
      type: "event",
      attestation: "asserted",
      text: "A test claim that the deep link should land on.",
    },
  ],
  infrastructure_claims: [],
};

beforeEach(() => {
  // jsdom implements neither; the deep-link path calls scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn();
  window.location.hash = `#claim-${CLAIM_ID}`;
});

afterEach(() => {
  window.location.hash = "";
});

describe("claim deep-link cold load", () => {
  it("selects and scrolls to the matching claim card without looping", async () => {
    // If the effect loops (untrack removed) this render throws
    // effect_update_depth_exceeded and the test fails here.
    render(IngestViewer, {
      props: {
        ingest: INGEST,
        digest: DIGEST,
        sourceFile: null,
        user: null,
        onback: () => {},
      },
    });

    // The card resolves asynchronously (the digest column reveals, then a
    // bounded poll finds the card and applies the selection).
    await waitFor(
      () => {
        const card = document.querySelector(`[data-claim-id="${CLAIM_ID}"]`);
        expect(card).not.toBeNull();
        expect(card?.classList.contains("claim-selected")).toBe(true);
      },
      { timeout: 3000 },
    );

    // The scroll lands via a rAF-driven poll, slightly after the selection.
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled(), {
      timeout: 3000,
    });
  });
});
