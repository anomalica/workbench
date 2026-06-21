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
  api/ingests/<hash>/digest.json        - digest; quotes stripped for gated records
  api/ingests/<hash>/coverage.json      - review coverage (spans/notes)

COPYRIGHT: only public_domain/open_licence record bodies + digest quotes enter the
public snapshot (see serves_verbatim - an allow-list, fail-safe). Gated records ship
metadata only; their bodies/quotes are served by the edge after the possession gate.
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


def _gate_digest_verbatim(digest: dict) -> dict:
    """Strip verbatim source excerpts from a gated record's digest, keeping the
    factual claim text + structure. The digest's verbatim field is `quote` (the
    assembler later renames it original_excerpt); drop both to be safe."""
    out = dict(digest)
    for key in ("domain_claims", "infrastructure_claims"):
        claims = out.get(key)
        if claims:
            out[key] = [
                {k: v for k, v in c.items() if k not in ("quote", "original_excerpt")}
                for c in claims
            ]
    return out


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

    Only public_domain/open_licence record bodies + digest quotes enter the public
    snapshot; gated records ship metadata only (body excluded, digest quotes
    stripped) and their bodies are served via the edge after the possession gate.
    Verification answers never enter the snapshot. /me/reviews is per-user -> a
    dynamic edge endpoint, not static. Reuses the FastAPI readers for parity."""
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
                detail = {
                    **detail,
                    "body": "",
                }  # gated body NEVER in the public snapshot
            _write(base / "ingests" / f"{h}.json", detail)

        yaml_path = digest_map.get(h)
        if yaml_path is not None:
            digest = server._filter_digest(_yaml.safe_load(yaml_path.read_text()) or {})
            if not public:
                digest = _gate_digest_verbatim(digest)
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
