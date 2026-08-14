"""Pre-render the knowledge graph + curation reads to STATIC JSON for the
serverless workbench (ADR 0039 online plan): the online side has no server-side
SQLite, so the graph is shipped as JSON on the CDN and the SPA fetches it
directly. Run this at LOCAL rebuild (after the assimilator regenerates
knowledge.db + the candidates), then ship the snapshot to the CDN.

Output tree (under SNAPSHOT_DIR, default workbench/snapshot/api/ so the paths
mirror the live API and the SPA can point at either):
  api/graph/stats.json
  api/graph/nodes.json                  - the full node list (SPA filters/searches client-side)
  api/graph/nodes/<id>.json             - per-node detail (claims, corefs, links)
  api/graph/ego/<id>.json               - per-node scoped ego-graph
  api/curation/candidates.json          - enriched + decided-filtered
  api/curation/merges.json              - active merges (cluster/un-merge view)
  api/ingests.json                      - the records list (metadata only, no bodies)
  api/ingests/<hash>.json               - record detail; body ONLY for public records
  api/ingests/<hash>/digest.json        - digest (claims + entities + short quotes), public for all
  api/ingests/<hash>/coverage.json      - review coverage (spans/notes)
  api/ingests/<hash>/media/<file>       - extracted images; PUBLIC RECORDS ONLY

COPYRIGHT: short attributed quotes (the digest + its quotes) are PUBLIC for all
records (lawful quotation, Japan Art 32; the site shows them too). The full record
BODY + frontmatter enters the snapshot for public_domain/open_licence/
publicly_accessible (see serves_verbatim - an allow-list, fail-safe); only the
licensed/restricted records are gated (body emptied, frontmatter whitelisted),
served by the edge after the possession gate. Verification sidecars (answers) are
NEVER rendered.

Extracted IMAGES follow the body's gate exactly (_copy_record_media). They are
page scans and figures taken from the source, so for a licensed book they are the
verbatim content - publishing them would walk around the gate the snapshot just
applied to that same book's text.

Reuses backend.graph / backend.curation, so the JSON is byte-for-byte what the
live API returns - no drift.
"""

from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path

from backend import curation, graph

# The PUBLIC snapshot carries the verbatim record BODY + full frontmatter (incl.
# word_timestamps - the word-level transcript - and description) ONLY for these
# copyright statuses. ALLOW-LIST, fail-safe: anything else - licensed, restricted,
# AND any unknown/absent status - is gated (body emptied, frontmatter whitelisted)
# and served only via the edge after the possession gate.
# publicly_accessible is SERVED per Mark's call (2026-06-22, his jurisdiction): the
# sources are publicly accessible (e.g. YouTube captions are publicly scrapable;
# ours are just more accurate versions), so no real exposure. Only the licensed
# books (Imminent etc.) stay gated, pending Mark's login-gate decision. (Digest
# verbatim QUOTES are a separate, already-all-public policy - see _prerender_records.)
# DO NOT widen without Mark's sign-off: a leak to the public CDN is irreversible.
SNAPSHOT_PUBLIC = frozenset({"public_domain", "open_licence", "publicly_accessible"})


def serves_verbatim(status: str | None) -> bool:
    """True only for statuses whose verbatim source text may enter the public
    snapshot. Allow-list: a new/unknown/absent status returns False (gated)."""
    return status in SNAPSHOT_PUBLIC


# Frontmatter keys safe to ship for a GATED record - pure structured metadata, no
# source content. ALLOW-LIST (same fail-safe discipline as the body): everything
# else is dropped, so free-text never leaks via the header - not `description`
# (publisher blurbs/abstracts), not `word_timestamps`/`speakers` (the verbatim
# transcript), not stray HTML that parsed into the frontmatter, nor any future key.
GATED_FRONTMATTER_ALLOW = frozenset(
    {
        "title",
        "creators",
        "authors",
        "publisher",
        "source_type",
        "source_url",
        "fetched_url",
        "source_file",
        "source_id",
        "source_hash",
        "content_hash",
        "public_hash",
        "provenance",
        "schema",
        "duration",
        "date",
        "date_published",
        "date_accessed",
        "date_extracted",
        "copyright.status",
    }
)


def _gate_record_detail(detail: dict) -> dict:
    """A gated record's detail with all verbatim source text removed: empty body,
    no raw_frontmatter (the verbatim YAML header), and the parsed frontmatter
    whitelisted to safe structured metadata. Allow-list, fail-safe."""
    fm = detail.get("frontmatter") or {}
    return {
        **detail,
        "body": "",
        "raw_frontmatter": "",
        "frontmatter": {k: v for k, v in fm.items() if k in GATED_FRONTMATTER_ALLOW},
    }


def snapshot_dir() -> Path:
    return Path(
        os.environ.get(
            "SNAPSHOT_DIR", str(Path(__file__).resolve().parents[1] / "snapshot")
        )
    )


def _write(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))


def prerender(out: Path | None = None) -> dict:
    """Render the read surface to static JSON. Returns a count summary."""
    base = (out or snapshot_dir()) / "api"
    counts = {"nodes": 0, "node_detail": 0, "ego": 0}

    stats = graph.stats()
    if stats is None:
        raise RuntimeError("knowledge.db not available - nothing to pre-render")
    _write(base / "graph" / "stats.json", stats)

    nodes = graph.list_nodes() or []
    _write(base / "graph" / "nodes.json", nodes)
    counts["nodes"] = len(nodes)

    for n in nodes:
        nid = n["id"]
        detail = graph.node_detail(nid)
        if detail and detail is not True:
            _write(base / "graph" / "nodes" / f"{nid}.json", detail)
            counts["node_detail"] += 1
        # cap=40 matches what GraphCanvas requests, so the static ego/<id>.json
        # is exactly what the SPA fetches online (no server to recompute a cap).
        ego = graph.ego_graph(nid, cap=40)
        if ego and ego is not True:
            _write(base / "graph" / "ego" / f"{nid}.json", ego)
            counts["ego"] += 1

    # Curation reads (also SQLite/file-backed) - so the online side needs no DB.
    _write(
        base / "curation" / "candidates.json",
        {"candidates": curation.enriched_candidates()},
    )
    _write(base / "curation" / "merges.json", {"merges": graph.list_merges() or []})

    # Assembled knowledge-article listing (public content layer). Walked from the
    # content repo at full-render time only; the records-only incremental refresh
    # leaves it untouched (a record review never changes assembled articles - those
    # change on assembler reassembly, a separate input).
    from backend import server as _server

    articles = _server.list_articles()
    _write(base / "articles.json", articles)
    counts["articles"] = len(articles)

    counts.update(_prerender_records(base))
    return counts


def _build_digest_map(server) -> dict:
    """{content_hash: digest_yaml_path} for every record with a digest, in one
    pass over the by-name/ symlinks (vs _hash_to_digest_path's per-call O(n) walk)."""
    out: dict[str, Path] = {}
    records_dir = server.ingests_path / "by-name"
    if not records_dir.exists():
        return out
    for symlink in records_dir.glob("*.md"):
        try:
            frontmatter, _, _ = server.parse_frontmatter(symlink.resolve().read_text())
        except OSError:
            continue
        content_hash = server.normalise_hash(frontmatter.get("content_hash"))
        if not content_hash:
            continue
        stem = re.sub(r"\.v\d+$", "", symlink.stem)
        yaml_path = server.digests_path / f"{stem}.yaml"
        if yaml_path.exists():
            out[content_hash] = yaml_path
    return out


def _prerender_records(base: Path, only: set[str] | None = None) -> dict:
    """Render the Records-tab read surface to static JSON, COPYRIGHT-GATED.

    The digest (claims + entities + short attributed quotes) is PUBLIC for all
    records. Only the full record BODY is gated: gated records ship metadata only
    (body emptied, raw_frontmatter dropped, frontmatter whitelisted - so the
    verbatim transcript in word_timestamps doesn't leak) and the body is served
    via the edge after the possession gate. Verification answers never enter the
    snapshot. /me/reviews is per-user -> a dynamic edge endpoint, not static.
    Reuses the FastAPI readers for parity.

    `only`: if given, re-render the detail/digest/coverage for just these content
    hashes (the on-review incremental refresh) - the ingests.json list is always
    rewritten (it is cheap and reflects per-record review state)."""
    import yaml as _yaml

    from backend import server

    summaries = server.source.list_ingests()
    _write(base / "ingests.json", summaries)  # the list = metadata only, no bodies

    digest_map = _build_digest_map(server)
    counts = {"records": 0, "record_public": 0, "digests": 0, "coverage": 0, "media": 0}
    for s in summaries:
        h = s["content_hash"]
        public = serves_verbatim(s.get("copyright_status"))
        counts["records"] += 1
        counts["record_public"] += int(public)
        if only is not None and h not in only:
            continue  # incremental: only re-render the changed records' files

        detail = server.source.get_ingest(h)
        if detail is not None:
            if not public:
                # gated: no body, no raw frontmatter, whitelisted metadata only
                detail = _gate_record_detail(detail)
            _write(base / "ingests" / f"{h}.json", detail)

        yaml_path = digest_map.get(h)
        if yaml_path is not None:
            # The digest (claims + entities + SHORT attributed quotes) is public
            # for all records - short quotes are lawful + public (Japan Art 32),
            # and the site shows them too. Only the full record BODY is gated.
            digest = server._filter_digest(_yaml.safe_load(yaml_path.read_text()) or {})
            _write(base / "ingests" / h / "digest.json", digest)
            counts["digests"] += 1

        coverage = server.source.load_coverage(h)
        if coverage is not None:
            _write(base / "ingests" / h / "coverage.json", coverage)
            counts["coverage"] += 1

        counts["media"] += _copy_record_media(base, h, public)
    return counts


def _copy_record_media(base: Path, content_hash: str, public: bool) -> int:
    """Copy a record's extracted images into the snapshot. Returns how many.

    THE SAME GATE AS THE BODY, for the same reason. These are page scans and
    figures lifted from the source, so for a licensed book they ARE the verbatim
    content - the snapshot blanks that book's text, and shipping its 33 scanned
    pages instead would walk straight around the gate it just applied. `public`
    is `serves_verbatim(status)`, so the allow-list decides both in one place and
    a status can never be public for images and gated for text.

    Without this the images 404 in production for EVERY record - nothing ever
    copied them - while working locally, where FastAPI reads the ingests
    directory directly. The path mirrors the endpoint the SPA already requests,
    `/api/ingests/{hash}/media/{file}`, so the CDN serves it with no edge route.
    """
    if not public:
        return 0
    from backend import server

    src_dir = server.ingests_path / "media" / content_hash
    if not src_dir.is_dir():
        return 0
    dest_dir = base / "ingests" / content_hash / "media"
    copied = 0
    for src in sorted(src_dir.iterdir()):
        # The endpoint's OWN pattern, not a copy of it: a restated one drifted
        # wider on first writing, which would let the snapshot publish a file the
        # live endpoint refuses to serve.
        if not src.is_file() or not server.MEDIA_FILENAME_PATTERN.match(src.name):
            continue
        dest_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest_dir / src.name)
        copied += 1
    return copied


def prerender_records_only(
    out: Path | None = None, hashes: list[str] | None = None
) -> dict:
    """Re-render ONLY the records read surface (no graph) - cheap (~seconds),
    used by the on-review incremental snapshot refresh. `hashes` limits the
    detail/digest/coverage re-render to those records; the ingests.json list is
    always rewritten. The graph snapshot is left untouched (a review never changes
    the graph)."""
    base = (out or snapshot_dir()) / "api"
    return _prerender_records(base, only=set(hashes) if hashes else None)


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser(prog="backend.prerender")
    p.add_argument("out", nargs="?", help="output dir (default: SNAPSHOT_DIR)")
    p.add_argument(
        "--records-only",
        action="store_true",
        help="re-render just the records surface (skip the ~15s graph render)",
    )
    p.add_argument(
        "--hash",
        action="append",
        metavar="CONTENT_HASH",
        help="re-render only this record (repeatable; implies --records-only)",
    )
    args = p.parse_args()
    out = Path(args.out) if args.out else None
    if args.records_only or args.hash:
        summary = prerender_records_only(out, args.hash)
        print(f"records re-rendered to {(out or snapshot_dir())}/api : {summary}")
    else:
        summary = prerender(out)
        print(f"pre-rendered to {(out or snapshot_dir())}/api : {summary}")
