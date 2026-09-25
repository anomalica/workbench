import { describe, it, expect } from "vitest";
import yaml from "js-yaml";
import { metadataOf, isRecord3Shape } from "./api";
import { rewriteFrontmatterMetadata } from "./document.svelte";

// The shapes in play: a record/2 video (flat fields, the shape that always
// worked), a record/3 (work metadata in `provenance`, copy retrieval on each
// Asset), and the API's shallow parse of a record/3, which flattens one
// nesting level to dotted keys and cannot represent `assets` at all.

const RECORD2 = {
  schema: "anomalica/record/2",
  title: "Dr. John E. Mack on the Reality of the Alien Abduction Phenomenon",
  source_type: "video",
  posted_by: "Eyes On Cinema",
  posted_date: "2026-06-24T08:45:30+00:00",
  source_url: "https://www.youtube.com/watch?v=ylgNYkrj55o",
  source_id: "youtube:ylgNYkrj55o",
  date_accessed: "2026-09-22T11:52:18.479329+00:00",
};

const RECORD3 = {
  schema: "anomalica/record/3",
  title: "Iran, Ukraine, and the End of the Western Order",
  source_type: "video",
  assets: [
    {
      asset_hash: "sha256:bbdfc7f5",
      file_format: "opus",
      acquisition: {
        acquired_at: "2026-09-24T14:41:32.196136Z",
        source_file: "youtube-PyRZDx4NKv0.opus",
      },
      copyright: { status: "publicly_accessible" },
    },
  ],
  selection: [{ asset_hash: "sha256:bbdfc7f5", selector: { type: "whole" } }],
  provenance: {
    posted_by: "Richard Dolan Intelligent Disclosure",
    posted_date: "2026-06-04",
    source_url: "https://www.youtube.com/watch?v=PyRZDx4NKv0",
    publisher: "Richard Dolan Intelligent Disclosure",
    creators: ["Richard Dolan"],
    published_date: "2026-06-04",
  },
};

// What the API's `frontmatter` map looks like for that same record/3.
const RECORD3_FLAT = {
  schema: "anomalica/record/3",
  title: "Iran, Ukraine, and the End of the Western Order",
  "provenance.posted_by": "Richard Dolan Intelligent Disclosure",
  "provenance.posted_date": "2026-06-04",
  "provenance.source_url": "https://www.youtube.com/watch?v=PyRZDx4NKv0",
};

describe("metadataOf", () => {
  it("reads a record/2's flat fields", () => {
    const meta = metadataOf(RECORD2);
    expect(meta.title).toBe(RECORD2.title);
    expect(meta.sourceUrl).toBe("https://www.youtube.com/watch?v=ylgNYkrj55o");
    expect(meta.postedBy).toBe("Eyes On Cinema");
    expect(meta.postedDate).toBe("2026-06-24T08:45:30+00:00");
    expect(meta.dateAccessed).toBe("2026-09-22T11:52:18.479329+00:00");
  });

  it("reads a record/3's provenance block and asset acquisition", () => {
    // The flat-field read that left every record/3's panel half empty beside a
    // metadata block that was right there.
    const meta = metadataOf(RECORD3);
    expect(meta.publisher).toBe("Richard Dolan Intelligent Disclosure");
    expect(meta.creators).toEqual(["Richard Dolan"]);
    expect(meta.publishedDate).toBe("2026-06-04");
    expect(meta.sourceUrl).toBe("https://www.youtube.com/watch?v=PyRZDx4NKv0");
    expect(meta.postedBy).toBe("Richard Dolan Intelligent Disclosure");
    expect(meta.postedDate).toBe("2026-06-04");
    expect(meta.dateAccessed).toBe("2026-09-24T14:41:32.196136Z");
  });

  it("reads the API's flattened record/3 spelling", () => {
    const meta = metadataOf(RECORD3_FLAT);
    expect(meta.sourceUrl).toBe("https://www.youtube.com/watch?v=PyRZDx4NKv0");
    expect(meta.postedBy).toBe("Richard Dolan Intelligent Disclosure");
    expect(meta.postedDate).toBe("2026-06-04");
  });

  it("lets the canonical home win over a stale flat duplicate", () => {
    // The format never writes both layers; when both are present the flat one
    // is stale migration input.
    const meta = metadataOf({
      ...RECORD3,
      publisher: "Old Channel Name",
      source_url: "https://example.com/stale",
    });
    expect(meta.publisher).toBe("Richard Dolan Intelligent Disclosure");
    expect(meta.sourceUrl).toBe("https://www.youtube.com/watch?v=PyRZDx4NKv0");
  });

  it("shows one retrieval instant only while the assets agree", () => {
    const two = (first: string, second: string) => ({
      schema: "anomalica/record/3",
      assets: [
        { asset_hash: "sha256:aaaa", acquisition: { acquired_at: first } },
        { asset_hash: "sha256:bbbb", acquisition: { acquired_at: second } },
      ],
    });
    expect(metadataOf(two("2026-09-24T14:41:32Z", "2026-09-24T14:41:32Z")).dateAccessed).toBe(
      "2026-09-24T14:41:32Z",
    );
    // Distinct per-Asset times are the Record editor's to show - one flat
    // reading would misdate the rest.
    expect(metadataOf(two("2026-09-24T14:41:32Z", "2026-09-25T09:00:00Z")).dateAccessed).toBe("");
  });

  it("falls back to the legacy date alias for the work date", () => {
    expect(metadataOf({ date: "1947" }).publishedDate).toBe("1947");
    expect(metadataOf({ date_published: "1947-06", date: "1900" }).publishedDate).toBe("1947-06");
  });
});

describe("isRecord3Shape", () => {
  it("answers on the schema string or the assets list", () => {
    expect(isRecord3Shape(RECORD3)).toBe(true);
    expect(isRecord3Shape(RECORD3_FLAT)).toBe(true);
    expect(isRecord3Shape(RECORD2)).toBe(false);
  });
});

// --- writing ---

const FM3 = [
  "---",
  "schema: anomalica/record/3",
  "title: A Video",
  "source_type: video",
  "assets:",
  "- asset_hash: sha256:aaaa",
  "  file_format: opus",
  "  source_type: video",
  "  acquisition:",
  "    acquired_at: '2026-09-24T14:41:32.196136Z'",
  "  copyright:",
  "    status: publicly_accessible",
  "- asset_hash: sha256:bbbb",
  "  file_format: opus",
  "  source_type: video",
  "  acquisition:",
  "    acquired_at: '2026-09-25T09:00:00Z'",
  "  copyright:",
  "    status: publicly_accessible",
  "selection:",
  "- asset_hash: sha256:aaaa",
  "  selector:",
  "    type: whole",
  "provenance:",
  "  posted_by: A Channel",
  "  posted_date: '2026-06-04'",
  "  source_url: https://www.youtube.com/watch?v=PyRZDx4NKv0",
  "publisher: Stale Flat Duplicate",
  "date_accessed: '2020-01-01T00:00:00Z'",
  "---",
  "",
  "Body line one.",
].join("\n") + "\n";

function reparsed(result: string): Record<string, unknown> {
  const block = result.match(/^---\n([\s\S]*?)\n---\n/)![1];
  return yaml.load(block, { schema: yaml.CORE_SCHEMA }) as Record<string, unknown>;
}

// Mirrors DocumentStore.updateMetadata: split the frontmatter block off,
// rewrite it, put the body back untouched.
function updateMetadata(current: string, values: Parameters<typeof rewriteFrontmatterMetadata>[1]): string {
  const match = current.match(/^(---\n[\s\S]*?\n---\n)([\s\S]*)$/)!;
  return rewriteFrontmatterMetadata(match[1], values) + match[2];
}

describe("rewriteFrontmatterMetadata", () => {
  it("writes record/3 fields into provenance and drops the flat duplicates", () => {
    const out = updateMetadata(FM3, {
      publisher: "Richard Dolan Intelligent Disclosure",
      creators: ["Richard Dolan"],
      datePublished: "2026-06-04",
      sourceUrl: "https://www.youtube.com/watch?v=PyRZDx4NKv0",
      postedBy: "A Channel",
      postedDate: "2026-06-04",
    });
    const fm = reparsed(out);
    const prov = fm.provenance as Record<string, unknown>;
    expect(prov.publisher).toBe("Richard Dolan Intelligent Disclosure");
    expect(prov.creators).toEqual(["Richard Dolan"]);
    expect(prov.published_date).toBe("2026-06-04");
    expect(prov.source_url).toBe("https://www.youtube.com/watch?v=PyRZDx4NKv0");
    expect(prov.posted_by).toBe("A Channel");
    expect(prov.posted_date).toBe("2026-06-04");
    // One field, one home: the stale flat spelling is gone.
    expect("publisher" in fm).toBe(false);
    expect(out.endsWith("Body line one.\n")).toBe(true);
  });

  it("leaves fields it was not given alone", () => {
    const out = updateMetadata(FM3, { title: "Renamed" });
    const fm = reparsed(out);
    expect(fm.title).toBe("Renamed");
    expect((fm.provenance as Record<string, unknown>).posted_by).toBe("A Channel");
    // A title edit is not an occasion to reinterpret a date.
    expect(out).toContain("2026-06-04");
  });

  it("writes the retrieval instant onto the selected asset only", () => {
    const out = updateMetadata(FM3, { dateAccessed: "2026-09-26T10:00:00Z" });
    const fm = reparsed(out);
    const assets = fm.assets as Record<string, unknown>[];
    expect((assets[0].acquisition as Record<string, unknown>).acquired_at).toBe(
      "2026-09-26T10:00:00Z",
    );
    // The unselected asset keeps its own instant.
    expect((assets[1].acquisition as Record<string, unknown>).acquired_at).toBe(
      "2026-09-25T09:00:00Z",
    );
    expect("date_accessed" in fm).toBe(false);
    // Temporal values are strings on disk whatever they look like.
    expect(out).toContain('acquired_at: "2026-09-26T10:00:00Z"');
  });

  it("does not flatten distinct per-asset instants", () => {
    // Selection covering both assets with two different instants: one panel
    // field cannot carry them, so the edit must not destroy either.
    const both = FM3.replace(
      "selection:\n- asset_hash: sha256:aaaa",
      "selection:\n- asset_hash: sha256:aaaa",
    ).replace(
      "  selector:\n    type: whole",
      "  selector:\n    type: whole\n- asset_hash: sha256:bbbb\n  selector:\n    type: whole",
    );
    const out = updateMetadata(both, { dateAccessed: "2026-09-26T10:00:00Z" });
    const assets = reparsed(out).assets as Record<string, unknown>[];
    expect((assets[0].acquisition as Record<string, unknown>).acquired_at).toBe(
      "2026-09-24T14:41:32.196136Z",
    );
    expect((assets[1].acquisition as Record<string, unknown>).acquired_at).toBe(
      "2026-09-25T09:00:00Z",
    );
  });

  it("never clears a record/3 retrieval instant", () => {
    // The format requires one per Asset; an empty panel field may not drop it.
    const out = updateMetadata(FM3, { dateAccessed: "" });
    const assets = reparsed(out).assets as Record<string, unknown>[];
    expect((assets[0].acquisition as Record<string, unknown>).acquired_at).toBe(
      "2026-09-24T14:41:32.196136Z",
    );
  });

  it("keeps writing the flat fields for record/1 and record/2", () => {
    const fm1 = [
      "---",
      "schema: anomalica/record/1",
      "title: A Record",
      "publisher: Someone",
      "authors:",
      "  - Old, Author",
      "date_accessed: 2026-07-24 10:00:00+09:00",
      "---",
      "",
      "Body.",
    ].join("\n");
    const out = updateMetadata(fm1, {
      publisher: "The Debrief",
      creators: ["Ramsey, Chris"],
      datePublished: "1947",
      dateAccessed: "",
    });
    const fm = reparsed(out);
    expect(fm.publisher).toBe("The Debrief");
    expect(fm.creators).toEqual(["Ramsey, Chris"]);
    // `authors` is the legacy alias of `creators`: one edit leaves one home.
    expect("authors" in fm).toBe(false);
    expect(fm.date_published).toBe("1947");
    // An optional legacy instant may be cleared.
    expect("date_accessed" in fm).toBe(false);
    expect(out).toContain('date_published: "1947"');
  });
});
