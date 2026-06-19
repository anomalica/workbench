"""Read-only access to the assimilator's knowledge graph.

The assimilator persists its merged entity graph to a SQLite database. The
workbench surfaces it for human review - especially the merge decisions
(``aliases``: every surface form the matcher resolved into a node), so a
reviewer glancing at an entity immediately sees what got merged into it and
whether that merge is wrong.

This module is strictly read-only: it opens the database with SQLite's
``mode=ro`` so a stray write can never corrupt the assimilator's output. The
path is env-configurable (``GRAPH_DB_PATH``); the default is where the
assimilator writes it.
"""

import os
import sqlite3
from pathlib import Path

DEFAULT_GRAPH_DB = Path.home() / ".local" / "share" / "assimilator" / "knowledge.db"

# Cap claims returned per node: a few hub entities have hundreds (Elizondo has
# ~950). The merge review is about the aliases, not reading every claim, so a
# generous cap keeps the payload sane while still showing the source spread.
CLAIM_LIMIT = 500

# Cap the browse list. Set above the current node count (~1900) so the
# unfiltered "All" view isn't silently truncated; type/search filters keep
# results well under it. Bump if the graph outgrows it.
NODE_LIMIT = 5000


def graph_db_path() -> Path:
    return Path(os.environ.get("GRAPH_DB_PATH", str(DEFAULT_GRAPH_DB)))


def _open(db_path: str | Path | None = None) -> sqlite3.Connection | None:
    """Open the graph DB read-only, or None if it doesn't exist yet."""
    p = Path(db_path) if db_path else graph_db_path()
    if not p.exists():
        return None
    con = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def stats(db_path: str | Path | None = None) -> dict | None:
    """Graph totals and a node breakdown by type. None if the DB is absent."""
    con = _open(db_path)
    if con is None:
        return None
    try:

        def scalar(sql):
            return con.execute(sql).fetchone()[0]

        by_type = [
            {"type": r["node_type"], "count": r["c"]}
            for r in con.execute(
                "SELECT node_type, count(*) c FROM nodes GROUP BY node_type ORDER BY c DESC"
            )
        ]
        return {
            "total_nodes": scalar("SELECT count(*) FROM nodes"),
            "total_claims": scalar("SELECT count(*) FROM claims"),
            "total_merges": scalar("SELECT count(*) FROM aliases"),
            "total_records": scalar("SELECT count(*) FROM records"),
            "total_corroborations": scalar("SELECT count(*) FROM corroborations"),
            "by_type": by_type,
        }
    finally:
        con.close()


def list_nodes(
    node_type: str | None = None,
    q: str | None = None,
    db_path: str | Path | None = None,
) -> list[dict] | None:
    """Nodes filtered by type and/or searched by name or alias.

    Each carries its alias-count (how many surface forms merged into it) and
    claim-count, so the browse list can flag heavily-merged entities. None if
    the DB is absent.
    """
    con = _open(db_path)
    if con is None:
        return None
    try:
        sql = [
            "SELECT n.id, n.name, n.node_type,",
            " (SELECT count(*) FROM aliases a WHERE a.node_id = n.id) AS alias_count,",
            " (SELECT count(*) FROM claim_node_refs r WHERE r.node_id = n.id) AS claim_count",
            " FROM nodes n WHERE 1=1",
        ]
        params: list[str] = []
        if node_type:
            sql.append(" AND n.node_type = ?")
            params.append(node_type)
        if q:
            sql.append(
                " AND (n.name LIKE ? OR n.id IN"
                " (SELECT node_id FROM aliases WHERE alias LIKE ?))"
            )
            params += [f"%{q}%", f"%{q}%"]
        sql.append(" ORDER BY n.name COLLATE NOCASE LIMIT ?")
        params.append(NODE_LIMIT)
        return [dict(r) for r in con.execute("".join(sql), params)]
    finally:
        con.close()


def node_detail(node_id: str, db_path: str | Path | None = None):
    """A node with its merge decisions (aliases) and referencing claims.

    Returns None if the DB is absent, False if the node id is unknown, else the
    detail dict. Claims are grouped client-side by source record; here they come
    ordered by record so that grouping is cheap, capped at CLAIM_LIMIT.
    """
    con = _open(db_path)
    if con is None:
        return None
    try:
        n = con.execute(
            "SELECT id, name, node_type, metadata FROM nodes WHERE id = ?", (node_id,)
        ).fetchone()
        if n is None:
            return False
        aliases = [
            r["alias"]
            for r in con.execute(
                "SELECT alias FROM aliases WHERE node_id = ? ORDER BY alias COLLATE NOCASE",
                (node_id,),
            )
        ]
        claim_count = con.execute(
            "SELECT count(*) FROM claim_node_refs WHERE node_id = ?", (node_id,)
        ).fetchone()[0]
        claims = [
            {
                "id": r["id"],
                "content": r["content"],
                "claim_type": r["claim_type"],
                "attestation": r["attestation"],
                "excerpt": r["original_excerpt"],
                "location": r["location_in_record"],
                "claim_role": r["claim_role"],
                "record_id": r["record_id"],
                "record_title": r["record_title"] or r["record_name"] or r["record_id"],
            }
            for r in con.execute(
                "SELECT c.id, c.content, c.claim_type, c.attestation, c.original_excerpt,"
                " c.location_in_record, c.claim_role, c.record_id,"
                " rec.title AS record_title, rec.friendly_name AS record_name"
                " FROM claims c"
                " JOIN claim_node_refs ref ON ref.claim_id = c.id"
                " LEFT JOIN records rec ON rec.id = c.record_id"
                " WHERE ref.node_id = ?"
                " ORDER BY record_title COLLATE NOCASE, c.location_in_record"
                " LIMIT ?",
                (node_id, CLAIM_LIMIT),
            )
        ]
        return {
            "id": n["id"],
            "name": n["name"],
            "node_type": n["node_type"],
            "aliases": aliases,
            "claim_count": claim_count,
            "claims_truncated": claim_count > CLAIM_LIMIT,
            "claims": claims,
        }
    finally:
        con.close()
