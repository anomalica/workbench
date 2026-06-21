#!/usr/bin/env python3
"""Pre-render (serverless online plan): the graph + curation reads -> static JSON.
A tiny graph DB, render it, check the JSON tree + content (the live-API parity is
verified separately; here it's the file layout + that it reuses graph/curation)."""

import json
import sqlite3

import pytest

from backend import prerender

NID = "11111111-1111-1111-1111-111111111111"


@pytest.fixture
def graph_db(tmp_path, monkeypatch):
    db = tmp_path / "knowledge.db"
    con = sqlite3.connect(db)
    con.executescript(
        """
        CREATE TABLE nodes (id TEXT PRIMARY KEY, node_type TEXT, name TEXT,
            metadata TEXT, created_at TEXT, retired_at TEXT);
        CREATE TABLE aliases (alias TEXT, node_id TEXT);
        CREATE TABLE records (id TEXT, title TEXT, reference TEXT, date TEXT,
            producer_id TEXT, content_hash TEXT, friendly_name TEXT, metadata TEXT,
            created_at TEXT);
        CREATE TABLE claims (id TEXT, content TEXT, original_excerpt TEXT,
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
        (NID, "person", "Lazar, Bob"),
    )
    con.commit()
    con.close()
    monkeypatch.setenv("GRAPH_DB_PATH", str(db))
    monkeypatch.setenv("ANOMALICA_MERGE_CANDIDATES", str(tmp_path / "absent.json"))
    return db


def test_prerender_writes_graph_and_curation_json(graph_db, tmp_path):
    out = tmp_path / "snap"
    counts = prerender.prerender(out)
    assert counts == {"nodes": 1, "node_detail": 1, "ego": 1}

    api = out / "api"
    assert json.loads((api / "graph" / "stats.json").read_text())["total_nodes"] == 1
    nodes = json.loads((api / "graph" / "nodes.json").read_text())
    assert [n["name"] for n in nodes] == ["Lazar, Bob"]
    detail = json.loads((api / "graph" / "nodes" / f"{NID}.json").read_text())
    assert detail["name"] == "Lazar, Bob"
    assert (api / "graph" / "ego" / f"{NID}.json").exists()
    assert json.loads((api / "curation" / "candidates.json").read_text()) == {
        "candidates": []
    }
    assert json.loads((api / "curation" / "merges.json").read_text()) == {"merges": []}


def test_prerender_no_db_raises(tmp_path, monkeypatch):
    monkeypatch.setenv("GRAPH_DB_PATH", str(tmp_path / "absent.db"))
    with pytest.raises(RuntimeError):
        prerender.prerender(tmp_path / "snap")
