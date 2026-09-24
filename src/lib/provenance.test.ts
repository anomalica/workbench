import { describe, it, expect } from "vitest";
import { provenanceOf, acquisitionOf, isPubliclyViewable, youtubeIdOf } from "./api";

describe("isPubliclyViewable", () => {
  it("is true for freely-viewable statuses", () => {
    expect(isPubliclyViewable("public_domain")).toBe(true);
    expect(isPubliclyViewable("open_licence")).toBe(true);
    expect(isPubliclyViewable("publicly_accessible")).toBe(true);
  });
  it("is false for gated statuses", () => {
    expect(isPubliclyViewable("licensed")).toBe(false);
    expect(isPubliclyViewable("restricted")).toBe(false);
  });
});

describe("provenanceOf", () => {
  it("treats an http source_url as the traceable origin", () => {
    const p = provenanceOf({ source_url: "https://example.com/x" });
    expect(p).toEqual({ kind: "url", label: "https://example.com/x", traceable: true });
  });

  it("treats a local source_file as the traceable origin", () => {
    const p = provenanceOf({ source_file: "DOW-UAP-D8-Mission-Report.pdf" });
    expect(p).toEqual({
      kind: "file",
      label: "DOW-UAP-D8-Mission-Report.pdf",
      traceable: true,
    });
  });

  it("prefers source_url over source_file when both are present", () => {
    const p = provenanceOf({ source_url: "https://example.com", source_file: "x.pdf" });
    expect(p.kind).toBe("url");
  });

  it("marks provenance: unknown as untraceable", () => {
    const p = provenanceOf({ provenance: "unknown" });
    expect(p).toEqual({ kind: "unknown", label: "Origin unknown", traceable: false });
  });

  it("treats an archived source_hash as traceable even when provenance is unknown", () => {
    // The ebook case: no source_url/source_file, provenance "unknown", but the
    // original epub is archived by its sha256 - a recoverable origin.
    const p = provenanceOf({ provenance: "unknown", source_hash: "sha256:549791432c8b" });
    expect(p).toEqual({ kind: "file", label: "Archived source file", traceable: true });
  });

  it("marks a record with no acquisition fields as untraceable", () => {
    const p = provenanceOf({});
    expect(p.kind).toBe("none");
    expect(p.traceable).toBe(false);
  });

  it("marks a record with empty acquisition strings as untraceable", () => {
    const p = provenanceOf({ source_url: "", source_file: "", provenance: "" });
    expect(p.traceable).toBe(false);
    expect(p.kind).toBe("none");
  });

  it("treats a record/3 provenance block's source_url as the traceable origin", () => {
    // The yellow-triangle bug: record/3 keeps the URL at provenance.source_url,
    // so a flat-field read said "No source recorded" beside a visible URL.
    const p = provenanceOf({
      provenance: { source_url: "https://www.dailymail.com/news/article-1.html" },
    });
    expect(p).toEqual({
      kind: "url",
      label: "https://www.dailymail.com/news/article-1.html",
      traceable: true,
    });
  });

  it("treats record/3 work identifiers as a recoverable origin", () => {
    const p = provenanceOf({ provenance: { identifiers: { isbn: "978-0-00-000000-0" } } });
    expect(p.traceable).toBe(true);
    expect(p.label).toBe("isbn: 978-0-00-000000-0");
  });

  it("marks a record/3 block with no locators as untraceable", () => {
    // Work-origin-unknown is the ABSENCE of source_url and identifiers, not a
    // scalar marker (ingest-format.md#provenance).
    const p = provenanceOf({ provenance: { publisher: "Daily Mail" } });
    expect(p.traceable).toBe(false);
    expect(p.kind).toBe("none");
  });
});

describe("acquisitionOf", () => {
  it("passes flat /1 /2 fields through unchanged", () => {
    expect(
      acquisitionOf({
        source_url: "https://example.com/x",
        source_file: "x.pdf",
        source_hash: "sha256:ab",
        provenance: "unknown",
      }),
    ).toEqual({
      source_url: "https://example.com/x",
      source_file: "x.pdf",
      source_hash: "sha256:ab",
      provenance: "unknown",
    });
  });

  it("resolves record/3 provenance.source_url and leaves the block as the marker", () => {
    const acq = acquisitionOf({
      provenance: { source_url: "https://example.com/a", publisher: "Daily Mail" },
    });
    expect(acq.source_url).toBe("https://example.com/a");
    expect(acq.provenance).toEqual({
      source_url: "https://example.com/a",
      publisher: "Daily Mail",
    });
  });

  it("falls back to the asset's fetched_url when the work URL is absent", () => {
    const acq = acquisitionOf({
      assets: [
        {
          acquisition: { fetched_url: "https://web.archive.org/web/1id_/https://x" },
        },
      ],
      provenance: { publisher: "Daily Mail" },
    });
    expect(acq.source_url).toBe("https://web.archive.org/web/1id_/https://x");
  });

  it("reads the API's flattened provenance.source_url spelling", () => {
    // The API's frontmatter map is the backend's shallow parse, which flattens
    // one nesting level to dotted keys. Reading only the block spelling leaves
    // every record/3 of the live API without a source URL.
    const acq = acquisitionOf({ "provenance.source_url": "https://example.com/a" });
    expect(acq.source_url).toBe("https://example.com/a");
  });
});

describe("youtubeIdOf", () => {
  it("reads the legacy flat source_url of a record/2 video", () => {
    // The shape that always worked: Dr. John E. Mack and every other /2
    // transcript carries the work URL at the top level.
    expect(
      youtubeIdOf({
        source_url: "https://www.youtube.com/watch?v=ylgNYkrj55o",
        source_id: "youtube:ylgNYkrj55o",
      }),
    ).toBe("ylgNYkrj55o");
  });

  it("reads record/3 provenance.source_url", () => {
    // The record/3 shape: the work URL moved to the provenance block, so the
    // viewer found no video id and rendered the archived audio extraction
    // instead of the YouTube video.
    expect(
      youtubeIdOf({
        provenance: { source_url: "https://www.youtube.com/watch?v=PyRZDx4NKv0" },
      }),
    ).toBe("PyRZDx4NKv0");
  });

  it("reads the flattened provenance.source_url spelling from the API map", () => {
    expect(
      youtubeIdOf({ "provenance.source_url": "https://www.youtube.com/watch?v=mu9mw6GHPEM" }),
    ).toBe("mu9mw6GHPEM");
  });

  it("falls back to an asset copy identifier when no URL carries the id", () => {
    expect(
      youtubeIdOf({
        assets: [
          {
            acquisition: {
              source_file: "youtube-PyRZDx4NKv0.opus",
              copy_identifiers: { source_id: "youtube:PyRZDx4NKv0" },
            },
          },
        ],
      }),
    ).toBe("PyRZDx4NKv0");
  });

  it("recognises short and embed URLs", () => {
    expect(youtubeIdOf({ source_url: "https://youtu.be/ylgNYkrj55o" })).toBe("ylgNYkrj55o");
    expect(youtubeIdOf({ source_url: "https://www.youtube.com/embed/ylgNYkrj55o" })).toBe(
      "ylgNYkrj55o",
    );
    expect(youtubeIdOf({ source_url: "https://www.youtube.com/shorts/ylgNYkrj55o" })).toBe(
      "ylgNYkrj55o",
    );
  });

  it("returns null for records that are not YouTube videos", () => {
    expect(youtubeIdOf({ source_url: "https://www.dailymail.com/news/article-1.html" })).toBe(null);
    expect(youtubeIdOf({ provenance: { source_url: "https://example.org/a.pdf" } })).toBe(null);
    expect(youtubeIdOf({})).toBe(null);
  });
});
