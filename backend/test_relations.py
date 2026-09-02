#!/usr/bin/env python3
"""The related-records panel reads the assimilator's judgements for one record."""

import json
import sqlite3

import pytest

from backend import relations

ME = "a" * 64
OTHER = "b" * 64


@pytest.fixture
def graph_db(tmp_path, monkeypatch):
    db = tmp_path / "knowledge.db"
    con = sqlite3.connect(db)
    con.executescript(
        """
        CREATE TABLE records (id TEXT PRIMARY KEY, title TEXT NOT NULL, date TEXT,
                              content_hash TEXT, created_at TEXT NOT NULL);
        CREATE TABLE claims (id TEXT PRIMARY KEY, content TEXT NOT NULL,
                             record_id TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE record_relations (
            record_a TEXT NOT NULL, record_b TEXT NOT NULL, verdict TEXT NOT NULL,
            shared_subject TEXT, reason TEXT, links TEXT, model TEXT,
            prompt_sha TEXT, judged_at TEXT NOT NULL, PRIMARY KEY (record_a, record_b));
        """
    )
    # The graph stores hashes with the prefix; the workbench asks without it.
    con.execute(
        "INSERT INTO records VALUES ('me', 'Mine', '2026-08-01', ?, 't')",
        (f"sha256:{ME}",),
    )
    con.execute(
        "INSERT INTO records VALUES ('other', 'Theirs', '2026-08-02', ?, 't')", (OTHER,)
    )
    con.execute(
        "INSERT INTO records VALUES ('third', 'Third', NULL, 'sha256:' || ?, 't')",
        ("c" * 64,),
    )
    con.execute(
        "INSERT INTO claims VALUES ('c-me', 'The craft hovered over the base.', 'me', 't')"
    )
    con.execute(
        "INSERT INTO claims VALUES ('c-other', 'An object hung above the installation.', 'other', 't')"
    )
    con.commit()
    con.close()
    monkeypatch.setenv("GRAPH_DB_PATH", str(db))
    return db


def _relate(
    db,
    a,
    b,
    verdict,
    links=None,
    subject="the 1997 hover",
    reason="same night, same base",
):
    con = sqlite3.connect(db)
    con.execute(
        "INSERT INTO record_relations VALUES (?, ?, ?, ?, ?, ?, 'haiku', 'sha', '2026-09-03T00:00:00Z')",
        (a, b, verdict, subject, reason, json.dumps(links or [])),
    )
    con.commit()
    con.close()


class TestRelationsFor:
    def test_finds_a_relation_from_either_side_of_the_pair(self, graph_db):
        _relate(graph_db, "other", "me", "same_subject")
        [r] = relations.relations_for(ME)
        assert r["verdict"] == "same_subject"
        assert r["other"]["title"] == "Theirs"
        assert r["other"]["public_hash"] == OTHER[:56]

    def test_the_pass_s_negatives_are_not_shown(self, graph_db):
        _relate(graph_db, "me", "other", "unrelated")
        _relate(graph_db, "me", "third", "possibly_related")
        [r] = relations.relations_for(ME)
        assert r["other"]["title"] == "Third"

    def test_linked_claims_are_resolved_with_this_record_s_claim_first(self, graph_db):
        # Written with the other record's claim as `a`; shown ours-first.
        _relate(
            graph_db,
            "other",
            "me",
            "same_subject",
            links=[{"a": "c-other", "b": "c-me", "relation": "corroborates"}],
        )
        [r] = relations.relations_for(ME)
        [link] = r["links"]
        assert link["a"]["text"] == "The craft hovered over the base."
        assert link["b"]["text"] == "An object hung above the installation."
        assert link["relation"] == "corroborates"

    def test_a_link_to_a_claim_the_graph_no_longer_holds_is_kept_and_marked(
        self, graph_db
    ):
        _relate(
            graph_db,
            "me",
            "other",
            "same_subject",
            links=[{"a": "c-me", "b": "gone", "relation": "x"}],
        )
        [r] = relations.relations_for(ME)
        assert r["links"][0]["b"] == {"id": "gone", "text": None, "record_id": None}

    def test_a_record_the_graph_does_not_know_has_no_relations(self, graph_db):
        assert relations.relations_for("f" * 64) == []

    def test_a_graph_without_the_table_is_not_run_yet(self, tmp_path, monkeypatch):
        db = tmp_path / "old.db"
        con = sqlite3.connect(db)
        con.execute(
            "CREATE TABLE records (id TEXT PRIMARY KEY, title TEXT NOT NULL, date TEXT, content_hash TEXT, created_at TEXT NOT NULL)"
        )
        con.execute("INSERT INTO records VALUES ('me', 'Mine', NULL, ?, 't')", (ME,))
        con.commit()
        con.close()
        monkeypatch.setenv("GRAPH_DB_PATH", str(db))
        assert relations.relations_for(ME) == []

    def test_no_graph_at_all_is_nothing_to_show(self, tmp_path, monkeypatch):
        monkeypatch.setenv("GRAPH_DB_PATH", str(tmp_path / "absent.db"))
        assert relations.relations_for(ME) == []
