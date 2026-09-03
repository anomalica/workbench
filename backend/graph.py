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


def ego_graph(node_id: str, cap: int = 30, db_path: str | Path | None = None):
    """A SCOPED node-link graph around one node, for the visual graph view - never
    the whole 2013-node graph. Nodes = the centre + its top-`cap` neighbours by
    shared-claim weight (co-occurrence in the centre's claims); edges = the
    weighted co-occurrences AMONG those nodes within the centre's claims. Returns
    None (DB absent) / False (unknown node) / {center, nodes, edges}."""
    con = _open(db_path)
    if con is None:
        return None
    try:
        centre = con.execute("SELECT id FROM nodes WHERE id = ?", (node_id,)).fetchone()
        if centre is None:
            return False
        claim_ids = [
            r[0]
            for r in con.execute(
                "SELECT claim_id FROM claim_node_refs WHERE node_id = ?", (node_id,)
            )
        ]
        node_ids = [node_id]
        if claim_ids:
            cph = ",".join("?" * len(claim_ids))
            neighbours = con.execute(
                f"SELECT node_id, count(*) w FROM claim_node_refs"
                f" WHERE claim_id IN ({cph}) AND node_id != ?"
                " GROUP BY node_id ORDER BY w DESC LIMIT ?",
                (*claim_ids, node_id, cap),
            ).fetchall()
            node_ids += [r["node_id"] for r in neighbours]

        nph = ",".join("?" * len(node_ids))
        info = {
            r["id"]: r
            for r in con.execute(
                "SELECT n.id, n.name, n.node_type,"
                " (SELECT count(*) FROM claim_node_refs r WHERE r.node_id = n.id) AS claims"
                f" FROM nodes n WHERE n.id IN ({nph})",
                node_ids,
            )
        }
        nodes = [
            {
                "id": i,
                "name": info[i]["name"],
                "node_type": info[i]["node_type"],
                "claims": info[i]["claims"],
                "center": i == node_id,
            }
            for i in node_ids
            if i in info
        ]

        # Edges: co-occurrence among the node set within the centre's claims.
        edges: dict[tuple[str, str], int] = {}
        if claim_ids and len(node_ids) > 1:
            nodeset = set(node_ids)
            by_claim: dict[str, list[str]] = {}
            cph = ",".join("?" * len(claim_ids))
            for r in con.execute(
                f"SELECT claim_id, node_id FROM claim_node_refs WHERE claim_id IN ({cph})",
                claim_ids,
            ):
                if r["node_id"] in nodeset:
                    by_claim.setdefault(r["claim_id"], []).append(r["node_id"])
            for members in by_claim.values():
                members.sort()
                for a_idx in range(len(members)):
                    for b_idx in range(a_idx + 1, len(members)):
                        key = (members[a_idx], members[b_idx])
                        edges[key] = edges.get(key, 0) + 1
        return {
            "center": node_id,
            "nodes": nodes,
            "edges": [
                {"source": a, "target": b, "weight": w} for (a, b), w in edges.items()
            ],
        }
    finally:
        con.close()


def nodes_brief(ids, db_path: str | Path | None = None) -> dict:
    """{id -> {id, name, node_type, claims}} for a set of node ids, for rendering
    merge-candidate members (which arrive as bare ids). {} if the DB is absent."""
    con = _open(db_path)
    if con is None:
        return {}
    try:
        ids = list(dict.fromkeys(i for i in ids if i))  # de-dupe, drop falsy
        if not ids:
            return {}
        placeholders = ",".join("?" * len(ids))
        out: dict[str, dict] = {}
        for r in con.execute(
            "SELECT n.id, n.name, n.node_type,"
            " (SELECT count(*) FROM claim_node_refs r WHERE r.node_id = n.id) AS claims"
            f" FROM nodes n WHERE n.id IN ({placeholders})",
            ids,
        ):
            out[r["id"]] = {
                "id": r["id"],
                "name": r["name"],
                "node_type": r["node_type"],
                "claims": r["claims"],
                "aliases": [],
            }
        # The node's alias surface forms become prior_names in the curation ledger
        # (name-drift robustness on replay), so the merge can be recorded online
        # without a DB read. One grouped query for the whole candidate set.
        for r in con.execute(
            f"SELECT node_id, alias FROM aliases WHERE node_id IN ({placeholders})"
            " ORDER BY alias COLLATE NOCASE",
            ids,
        ):
            if r["node_id"] in out:
                out[r["node_id"]]["aliases"].append(r["alias"])
        return out
    finally:
        con.close()


def retired_node_ids(ids, db_path: str | Path | None = None) -> set:
    """Which of the given node ids are retired (retired_at set) - i.e. already
    merged into another entity. Used to filter merge candidates whose nodes are
    already decided. Empty set if the DB is absent."""
    con = _open(db_path)
    if con is None:
        return set()
    try:
        ids = list(dict.fromkeys(i for i in ids if i))
        if not ids:
            return set()
        placeholders = ",".join("?" * len(ids))
        return {
            r["id"]
            for r in con.execute(
                f"SELECT id FROM nodes WHERE id IN ({placeholders}) AND retired_at IS NOT NULL",
                ids,
            )
        }
    finally:
        con.close()


def list_merges(db_path: str | Path | None = None):
    """Active merges (node_merges, undone_at IS NULL) grouped by merge_id, for the
    cluster / un-merge view. Returns None if the DB is absent, [] if the
    node_merges table doesn't exist yet (the assimilator builds it) or there are
    no merges, else a list of {merge_id, survivor_id, survivor_name,
    canonical_name, created_at, victims:[{id, prior_name}]}."""
    con = _open(db_path)
    if con is None:
        return None
    try:
        try:
            rows = con.execute(
                "SELECT m.merge_id, m.survivor_id, m.canonical_name, m.victim_id,"
                " m.victim_prior_name, m.created_at, m.created_by,"
                " n.name AS survivor_name"
                " FROM node_merges m LEFT JOIN nodes n ON n.id = m.survivor_id"
                " WHERE m.undone_at IS NULL"
                " ORDER BY m.created_at DESC, m.merge_id"
            ).fetchall()
        except sqlite3.OperationalError:
            return []  # node_merges table not created yet
        groups: dict[str, dict] = {}
        for r in rows:
            g = groups.setdefault(
                r["merge_id"],
                {
                    "merge_id": r["merge_id"],
                    "survivor_id": r["survivor_id"],
                    "survivor_name": r["survivor_name"],
                    "canonical_name": r["canonical_name"],
                    "created_at": r["created_at"],
                    # WHO applied it. 163 of the 164 merges in the graph were
                    # applied by a session with nobody confirming, which is the
                    # thing this list now exists to let a person review.
                    "created_by": r["created_by"],
                    "victims": [],
                },
            )
            g["victims"].append(
                {"id": r["victim_id"], "prior_name": r["victim_prior_name"]}
            )
        return list(groups.values())
    finally:
        con.close()


def list_rejections(db_path: str | Path | None = None) -> list[dict]:
    """Active rejections (node_rejections, undone_at IS NULL) grouped by
    rejection_id - each a {rejection_id, node_ids} for the candidate-queue filter
    (a rejected cluster's current node-id set). [] if the DB or table is absent."""
    con = _open(db_path)
    if con is None:
        return []
    try:
        try:
            rows = con.execute(
                "SELECT rejection_id, node_id FROM node_rejections"
                " WHERE undone_at IS NULL"
            ).fetchall()
        except sqlite3.OperationalError:
            return []  # node_rejections table not created yet
        groups: dict[str, list[str]] = {}
        for r in rows:
            groups.setdefault(r["rejection_id"], []).append(r["node_id"])
        return [{"rejection_id": rid, "node_ids": ids} for rid, ids in groups.items()]
    finally:
        con.close()


def _public_hash(content_hash) -> str | None:
    """The record's public hash (content_hash hex, first 56 chars) - the workbench's
    record deep-link key. None if absent."""
    if not content_hash:
        return None
    h = str(content_hash).removeprefix("sha256:")
    return h[:56] if h else None


def _noderef(node_id, name, node_type) -> dict | None:
    """A compact {id, name, node_type} for a referenced node, or None if absent."""
    if not node_id:
        return None
    return {"id": node_id, "name": name, "node_type": node_type}


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
                # The record's public hash (content_hash[:56]) so the UI can deep-
                # link the source to its record in the Records tab.
                "record_public_hash": _public_hash(r["record_content_hash"]),
                # The speaker and the record's producer are themselves nodes -
                # surface them so the UI can link to their entity views.
                "speaker": _noderef(r["sp_id"], r["sp_name"], r["sp_type"]),
                "record_producer": _noderef(r["pr_id"], r["pr_name"], r["pr_type"]),
                "corefs": [],  # filled in below
            }
            for r in con.execute(
                "SELECT c.id, c.content, c.claim_type, c.attestation, c.original_excerpt,"
                " c.location_in_record, c.claim_role, c.record_id,"
                " rec.title AS record_title, rec.friendly_name AS record_name,"
                " rec.content_hash AS record_content_hash,"
                " sp.id AS sp_id, sp.name AS sp_name, sp.node_type AS sp_type,"
                " pr.id AS pr_id, pr.name AS pr_name, pr.node_type AS pr_type"
                " FROM claims c"
                " JOIN claim_node_refs ref ON ref.claim_id = c.id"
                " LEFT JOIN records rec ON rec.id = c.record_id"
                " LEFT JOIN nodes sp ON sp.id = c.speaker_id"
                " LEFT JOIN nodes pr ON pr.id = rec.producer_id"
                " WHERE ref.node_id = ?"
                " ORDER BY record_title COLLATE NOCASE, c.location_in_record"
                " LIMIT ?",
                (node_id, CLAIM_LIMIT),
            )
        ]
        # The OTHER entities each claim references (claim_node_refs, minus this
        # node) - one query for all the claims above, grouped by claim.
        by_claim = {c["id"]: c for c in claims}
        if by_claim:
            placeholders = ",".join("?" * len(by_claim))
            for r in con.execute(
                "SELECT ref.claim_id, n.id, n.name, n.node_type"
                " FROM claim_node_refs ref JOIN nodes n ON n.id = ref.node_id"
                f" WHERE ref.claim_id IN ({placeholders}) AND ref.node_id != ?"
                " ORDER BY n.name COLLATE NOCASE",
                (*by_claim.keys(), node_id),
            ):
                claim = by_claim.get(r["claim_id"])
                if claim is not None:
                    claim["corefs"].append(
                        {"id": r["id"], "name": r["name"], "node_type": r["node_type"]}
                    )
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
