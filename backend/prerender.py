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

COPYRIGHT: short attributed quotes (the digest + its quotes) are PUBLIC for all
records (lawful quotation, Japan Art 32; the site shows them too). Only the full
record BODY (and the verbatim transcript / raw frontmatter) is gated: it enters the
snapshot ONLY for public_domain/open_licence (see serves_verbatim - an allow-list,
fail-safe), else it is emptied + served by the edge after the possession gate.
Verification sidecars (answers) are NEVER rendered.

Reuses backend.graph / backend.curation, so the JSON is byte-for-byte what the
live API returns - no drift.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

from backend import curation, graph

# The PUBLIC snapshot carries verbatim source text (record bodies + digest quotes)
# ONLY for these copyright statuses. This is an ALLOW-LIST, fail-safe by design:
# anything else - licensed, restricted, publicly_accessible, AND any unknown or
# absent status - is gated and served only via the edge after the possession gate.
# IDENTICAL to the site's quote-gating rule (site: feat/public-quote-gating ->
# `in (slice "public_domain" "open_licence")`). DO NOT widen this without changing
# both ends together: a leak to the public CDN is irreversible.
SNAPSHOT_PUBLIC = frozenset({"public_domain", "open_licence"})


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

    counts.update(_prerender_records(base))
    return counts


def _build_digest_map(server) -> dict:
    """{content_hash: digest_yaml_path} for every record with a digest, in one
    pass over the records/ symlinks (vs _hash_to_digest_path's per-call O(n) walk)."""
    out: dict[str, Path] = {}
    records_dir = server.ingests_path / "records"
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
        yaml_path = server.digests_path / "records" / f"{stem}.yaml"
        if yaml_path.exists():
            out[content_hash] = yaml_path
    return out


def _prerender_records(base: Path) -> dict:
    """Render the Records-tab read surface to static JSON, COPYRIGHT-GATED.

    The digest (claims + entities + short attributed quotes) is PUBLIC for all
    records. Only the full record BODY is gated: gated records ship metadata only
    (body emptied, raw_frontmatter dropped, frontmatter whitelisted - so the
    verbatim transcript in word_timestamps doesn't leak) and the body is served
    via the edge after the possession gate. Verification answers never enter the
    snapshot. /me/reviews is per-user -> a dynamic edge endpoint, not static.
    Reuses the FastAPI readers for parity."""
    import yaml as _yaml

    from backend import server

    summaries = server.source.list_ingests()
    _write(base / "ingests.json", summaries)  # the list = metadata only, no bodies

    digest_map = _build_digest_map(server)
    counts = {"records": 0, "record_public": 0, "digests": 0, "coverage": 0}
    for s in summaries:
        h = s["content_hash"]
        public = serves_verbatim(s.get("copyright_status"))
        counts["records"] += 1
        counts["record_public"] += int(public)

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
    return counts


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    summary = prerender(out)
    print(f"pre-rendered to {(out or snapshot_dir())}/api : {summary}")
