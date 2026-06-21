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

Reuses backend.graph / backend.curation, so the JSON is byte-for-byte what the
live API returns - no drift.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from backend import curation, graph


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
        ego = graph.ego_graph(nid)
        if ego and ego is not True:
            _write(base / "graph" / "ego" / f"{nid}.json", ego)
            counts["ego"] += 1

    # Curation reads (also SQLite/file-backed) - so the online side needs no DB.
    _write(
        base / "curation" / "candidates.json",
        {"candidates": curation.enriched_candidates()},
    )
    _write(base / "curation" / "merges.json", {"merges": graph.list_merges() or []})

    return counts


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    summary = prerender(out)
    print(f"pre-rendered to {(out or snapshot_dir())}/api : {summary}")
