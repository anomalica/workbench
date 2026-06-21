#!/usr/bin/env python3
"""Pre-render (serverless online plan): the graph + curation reads -> static JSON.
A tiny graph DB, render it, check the JSON tree + content (the live-API parity is
verified separately; here it's the file layout + that it reuses graph/curation)."""

import json
import os
import sqlite3

import pytest
import yaml

from backend import prerender

NID = "11111111-1111-1111-1111-111111111111"

H_PUB = "a" * 64
H_GATED = "b" * 64


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

    # Isolate the graph/curation render from the live ingests: stub an empty
    # records source so prerender()'s records pass writes nothing here.
    class _EmptySource:
        def list_ingests(self):
            return []

    from backend import server

    monkeypatch.setattr(server, "source", _EmptySource())
    monkeypatch.setattr(server, "ingests_path", tmp_path / "empty-ingests")
    monkeypatch.setattr(server, "digests_path", tmp_path / "empty-digests")
    return db


def test_prerender_writes_graph_and_curation_json(graph_db, tmp_path):
    out = tmp_path / "snap"
    counts = prerender.prerender(out)
    assert counts == {
        "nodes": 1,
        "node_detail": 1,
        "ego": 1,
        "records": 0,
        "record_public": 0,
        "digests": 0,
        "coverage": 0,
    }

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


# --- Records pre-render: the copyright boundary -----------------------------


@pytest.mark.parametrize(
    "status,served",
    [
        ("public_domain", True),
        ("open_licence", True),
        (
            "publicly_accessible",
            False,
        ),  # conservative: source-accessible != redistributable
        ("licensed", False),
        ("restricted", False),
        ("", False),  # absent -> gated
        (None, False),  # unknown -> gated
        ("some_new_status", False),  # allow-list, not blocklist
    ],
)
def test_serves_verbatim_is_a_failsafe_allowlist(status, served):
    assert prerender.serves_verbatim(status) is served


def test_gate_digest_verbatim_strips_quotes_keeps_factual():
    digest = {
        "schema": "anomalica/digest/1",
        "nodes": [{"id": "n1", "name": "X"}],
        "domain_claims": [
            {"id": "c1", "quote": "VERBATIM", "original_excerpt": "V2", "text": "fact"}
        ],
        "infrastructure_claims": [{"id": "c2", "quote": "VERBATIM2", "text": "fact2"}],
    }
    gated = prerender._gate_digest_verbatim(digest)
    for ck in ("domain_claims", "infrastructure_claims"):
        for c in gated[ck]:
            assert "quote" not in c and "original_excerpt" not in c
            assert c["text"]  # factual content stays
    assert gated["nodes"] == digest["nodes"]  # structure untouched


@pytest.fixture
def records_repo(tmp_path, monkeypatch):
    """A tiny ingests store + digests with one public and one gated record."""
    ing = tmp_path / "ingests"
    (ing / "store").mkdir(parents=True)
    (ing / "records").mkdir()
    dig = tmp_path / "digests" / "records"
    dig.mkdir(parents=True)

    for h, status, name in [
        (H_PUB, "public_domain", "rec-pub"),
        (H_GATED, "restricted", "rec-gated"),
    ]:
        md = (
            f"---\ncontent_hash: {h}\ncopyright:\n  status: {status}\n"
            f"title: {name}\n---\nBODY of {name}\n"
        )
        (ing / "store" / f"{h}.md").write_text(md)
        os.symlink(ing / "store" / f"{h}.md", ing / "records" / f"{name}.md")
        (dig / f"{name}.yaml").write_text(
            yaml.safe_dump(
                {
                    "schema": "anomalica/digest/1",
                    "record": {"id": h},
                    "nodes": [],
                    "domain_claims": [
                        {
                            "id": "c1",
                            "type": "x",
                            "quote": f"VERBATIM {name}",
                            "text": f"fact {name}",
                        }
                    ],
                }
            )
        )

    class FakeSource:
        def list_ingests(self):
            return [
                {
                    "content_hash": H_PUB,
                    "copyright_status": "public_domain",
                    "title": "rec-pub",
                },
                {
                    "content_hash": H_GATED,
                    "copyright_status": "restricted",
                    "title": "rec-gated",
                },
            ]

        def get_ingest(self, h):
            status = "public_domain" if h == H_PUB else "restricted"
            return {
                "content_hash": h,
                "copyright_status": status,
                "body": f"BODY {h[:4]}",
                "raw_frontmatter": f"title: rec\ndescription: SECRET BLURB {h[:4]}\n",
                "frontmatter": {
                    "title": "rec",
                    "copyright.status": status,
                    "description": f"SECRET BLURB {h[:4]}",  # free-text, must drop when gated
                    "word_timestamps": [
                        {"word": "secret", "t": 1}
                    ],  # verbatim transcript
                },
            }

        def load_coverage(self, _h):
            return None

    from backend import server

    monkeypatch.setattr(server, "source", FakeSource())
    monkeypatch.setattr(server, "ingests_path", ing)
    monkeypatch.setattr(server, "digests_path", tmp_path / "digests")
    return tmp_path


def test_records_prerender_gates_bodies_and_quotes(records_repo, tmp_path):
    base = tmp_path / "out" / "api"
    counts = prerender._prerender_records(base)
    assert counts == {"records": 2, "record_public": 1, "digests": 2, "coverage": 0}

    # The list ships both records as metadata.
    listed = json.loads((base / "ingests.json").read_text())
    assert {r["content_hash"] for r in listed} == {H_PUB, H_GATED}

    # PUBLIC record: body + digest quote present.
    pub = json.loads((base / "ingests" / f"{H_PUB}.json").read_text())
    assert pub["body"] == f"BODY {H_PUB[:4]}"
    pub_digest = json.loads((base / "ingests" / H_PUB / "digest.json").read_text())
    assert pub_digest["domain_claims"][0]["quote"] == "VERBATIM rec-pub"

    # PUBLIC record keeps its raw frontmatter + free-text (redistribution allowed).
    assert pub["raw_frontmatter"]
    assert pub["frontmatter"].get("description")

    # GATED record: body emptied, digest quote stripped, factual text kept, AND no
    # verbatim frontmatter (raw dropped; free-text description + word_timestamps
    # gone; only whitelisted structured metadata remains).
    gated = json.loads((base / "ingests" / f"{H_GATED}.json").read_text())
    assert gated["body"] == ""
    assert gated["raw_frontmatter"] == ""
    assert "description" not in gated["frontmatter"]
    assert "word_timestamps" not in gated["frontmatter"]
    assert gated["frontmatter"]["title"] == "rec"  # structured metadata kept
    assert gated["frontmatter"]["copyright.status"] == "restricted"
    gated_digest = json.loads((base / "ingests" / H_GATED / "digest.json").read_text())
    claim = gated_digest["domain_claims"][0]
    assert "quote" not in claim and claim["text"] == "fact rec-gated"


def test_records_prerender_never_writes_a_verification_sidecar(records_repo, tmp_path):
    base = tmp_path / "out" / "api"
    prerender._prerender_records(base)
    assert not list(base.rglob("*verification*"))
