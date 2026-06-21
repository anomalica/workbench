#!/usr/bin/env python3
"""Read-only knowledge-graph access (backend/graph.py).

Builds a tiny fixture graph DB matching the assimilator schema and checks the
stats / browse / detail queries - above all that a node's aliases (its merge
decisions) come back, since surfacing those for review is the whole point.
"""

import sqlite3

import pytest

from backend import graph

ORG = "11111111-1111-1111-1111-111111111111"
PERSON = "22222222-2222-2222-2222-222222222222"


@pytest.fixture
def graph_db(tmp_path):
    db = tmp_path / "knowledge.db"
    con = sqlite3.connect(db)
    con.executescript(
        """
        CREATE TABLE nodes (id TEXT PRIMARY KEY, node_type TEXT, name TEXT,
            metadata TEXT, created_at TEXT, retired_at TEXT);
        CREATE TABLE aliases (alias TEXT, node_id TEXT);
        CREATE TABLE records (id TEXT PRIMARY KEY, title TEXT, reference TEXT,
            date TEXT, producer_id TEXT, content_hash TEXT, friendly_name TEXT,
            metadata TEXT, created_at TEXT);
        CREATE TABLE claims (id TEXT PRIMARY KEY, content TEXT, original_excerpt TEXT,
            claim_type TEXT, attestation TEXT, record_id TEXT, speaker_id TEXT,
            location_in_record TEXT, date TEXT, date_end TEXT, confidence REAL,
            metadata TEXT, created_at TEXT, claim_role TEXT);
        CREATE TABLE claim_node_refs (claim_id TEXT, node_id TEXT);
        CREATE TABLE corroborations (claim_a TEXT, claim_b TEXT, similarity REAL);
        CREATE TABLE node_merges (merge_id TEXT, survivor_id TEXT, victim_id TEXT,
            victim_prior_name TEXT, canonical_name TEXT, created_at TEXT,
            created_by TEXT, undone_at TEXT);
        """
    )
    con.execute(
        "INSERT INTO nodes (id, node_type, name) VALUES (?,?,?)",
        (ORG, "organisation", "Defense Intelligence Agency (DIA)"),
    )
    con.execute(
        "INSERT INTO nodes (id, node_type, name) VALUES (?,?,?)",
        (PERSON, "person", "Lazar, Bob"),
    )
    # Two surface forms merged into the org node - the merge decisions.
    con.executemany(
        "INSERT INTO aliases (alias, node_id) VALUES (?,?)",
        [("Defense Intelligence Agency", ORG), ("DIA", ORG)],
    )
    con.execute(
        "INSERT INTO records (id, title, friendly_name) VALUES (?,?,?)",
        ("rec1", "AARO Historical Record Report", "2024-aaro"),
    )
    for i in range(3):
        con.execute(
            "INSERT INTO claims (id, content, original_excerpt, claim_type, attestation,"
            " record_id, location_in_record, claim_role) VALUES (?,?,?,?,?,?,?,?)",
            (
                f"c{i}",
                f"content {i}",
                f"excerpt {i}",
                "administrative",
                "first_hand",
                "rec1",
                f"page {i}",
                "primary",
            ),
        )
        con.execute(
            "INSERT INTO claim_node_refs (claim_id, node_id) VALUES (?,?)",
            (f"c{i}", ORG),
        )
    # Cross-entity refs on c0: PERSON is its speaker, a co-referenced node, and
    # the record's producer - all of which the detail view should surface as
    # followable entity links.
    con.execute("UPDATE records SET producer_id = ? WHERE id = 'rec1'", (PERSON,))
    con.execute("UPDATE claims SET speaker_id = ? WHERE id = 'c0'", (PERSON,))
    con.execute(
        "INSERT INTO claim_node_refs (claim_id, node_id) VALUES ('c0', ?)", (PERSON,)
    )
    # One active merge (a victim folded into ORG) + one already undone (excluded).
    con.executemany(
        "INSERT INTO node_merges (merge_id, survivor_id, victim_id, victim_prior_name,"
        " canonical_name, created_at, undone_at) VALUES (?,?,?,?,?,?,?)",
        [
            (
                "m1",
                ORG,
                "victim-1",
                "DIA (old)",
                "Defense Intelligence Agency (DIA)",
                "2026-06-21T00:00:00Z",
                None,
            ),
            (
                "m2",
                ORG,
                "victim-2",
                "Gone",
                "Whatever",
                "2026-06-20T00:00:00Z",
                "2026-06-21T01:00:00Z",
            ),
        ],
    )
    con.commit()
    con.close()
    return str(db)


def test_stats(graph_db):
    s = graph.stats(graph_db)
    assert s["total_nodes"] == 2
    assert s["total_merges"] == 2
    assert s["total_claims"] == 3
    assert s["total_records"] == 1
    assert s["total_corroborations"] == 0
    assert {"type": "organisation", "count": 1} in s["by_type"]


def test_list_nodes_with_counts(graph_db):
    by_id = {n["id"]: n for n in graph.list_nodes(db_path=graph_db)}
    assert by_id[ORG]["alias_count"] == 2
    assert by_id[ORG]["claim_count"] == 3
    assert by_id[PERSON]["alias_count"] == 0


def test_list_nodes_filter_by_type(graph_db):
    nodes = graph.list_nodes(node_type="person", db_path=graph_db)
    assert [n["name"] for n in nodes] == ["Lazar, Bob"]


def test_search_matches_alias_not_just_name(graph_db):
    # "DIA" is an alias of the org, not in its display name's words - searching
    # it must still surface the node it merged into.
    nodes = graph.list_nodes(q="DIA", db_path=graph_db)
    assert any(n["id"] == ORG for n in nodes)


def test_node_detail_surfaces_aliases_and_claims(graph_db):
    d = graph.node_detail(ORG, db_path=graph_db)
    assert d["name"] == "Defense Intelligence Agency (DIA)"
    assert d["aliases"] == ["Defense Intelligence Agency", "DIA"]  # sorted NOCASE
    assert d["claim_count"] == 3
    assert d["claims_truncated"] is False
    assert d["claims"][0]["record_title"] == "AARO Historical Record Report"
    assert d["claims"][0]["excerpt"].startswith("excerpt")


def test_node_detail_surfaces_cross_entity_refs(graph_db):
    d = graph.node_detail(ORG, db_path=graph_db)
    c0 = next(c for c in d["claims"] if c["id"] == "c0")
    # the claim's speaker is a followable node
    assert c0["speaker"] == {"id": PERSON, "name": "Lazar, Bob", "node_type": "person"}
    # the record's producer is a followable node
    assert c0["record_producer"]["id"] == PERSON
    # co-referenced entities include PERSON but exclude THIS node (ORG)
    coref_ids = [r["id"] for r in c0["corefs"]]
    assert PERSON in coref_ids and ORG not in coref_ids
    # a claim with no extra refs has empty corefs / no speaker
    c1 = next(c for c in d["claims"] if c["id"] == "c1")
    assert c1["corefs"] == [] and c1["speaker"] is None


def test_nodes_brief(graph_db):
    brief = graph.nodes_brief([ORG, PERSON, "missing"], db_path=graph_db)
    assert brief[ORG] == {
        "id": ORG,
        "name": "Defense Intelligence Agency (DIA)",
        "node_type": "organisation",
        "claims": 3,
    }
    assert "missing" not in brief  # unknown ids simply absent
    assert graph.nodes_brief([], db_path=graph_db) == {}


def test_list_merges_groups_active_only(graph_db):
    merges = graph.list_merges(db_path=graph_db)
    # m2 is undone -> excluded; m1 active -> present, with the survivor's live name
    assert [m["merge_id"] for m in merges] == ["m1"]
    m1 = merges[0]
    assert m1["survivor_id"] == ORG
    assert m1["survivor_name"] == "Defense Intelligence Agency (DIA)"
    assert m1["victims"] == [{"id": "victim-1", "prior_name": "DIA (old)"}]


def test_ego_graph_scopes_to_neighbours(graph_db):
    # PERSON co-occurs with ORG in claim c0, so ORG's ego-graph has PERSON as a
    # neighbour and an edge between them; the centre is flagged.
    g = graph.ego_graph(ORG, db_path=graph_db)
    ids = {n["id"] for n in g["nodes"]}
    assert ORG in ids and PERSON in ids
    assert next(n for n in g["nodes"] if n["id"] == ORG)["center"] is True
    assert {"source": min(ORG, PERSON), "target": max(ORG, PERSON), "weight": 1} in g[
        "edges"
    ]


def test_ego_graph_unknown_id_is_false(graph_db):
    assert graph.ego_graph("nope", db_path=graph_db) is False


def test_node_detail_unknown_id_is_false(graph_db):
    assert graph.node_detail("nope", db_path=graph_db) is False


def test_missing_db_returns_none(tmp_path):
    missing = str(tmp_path / "absent.db")
    assert graph.stats(missing) is None
    assert graph.list_nodes(db_path=missing) is None
    assert graph.node_detail(ORG, db_path=missing) is None
