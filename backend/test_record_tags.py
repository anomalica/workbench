#!/usr/bin/env python3
"""Tagging a record with the subject it is about.

The pipeline links two records only through a named entity they share, so two
records about the same UNNAMED thing stay apart. A tag is the link a person
asserts instead, and these pin the two things that make it trustworthy.

A tag is READ FROM THE LEDGER, not from the graph table: a record that has not
been digested has no graph row, its tag is pending, and a table-first read would
show a reviewer nothing where they had just asserted something. And the outcome
is reported as it is - pending is not success and not failure, and a reviewer who
asserted a link is owed the difference.

Nothing here touches the real curation repo or the real graph: the curation
directory is a tmp_path and the assimilator call is stubbed.
"""

import sqlite3
import subprocess

import pytest
import yaml

from backend import tags

HASH = "a" * 64
PREFIXED = f"sha256:{HASH}"


@pytest.fixture
def curation(tmp_path, monkeypatch):
    monkeypatch.setenv("ANOMALICA_CURATION_DIR", str(tmp_path / "curation"))
    return tmp_path / "curation" / "tags.yaml"


@pytest.fixture
def graph_db(tmp_path, monkeypatch):
    db = tmp_path / "knowledge.db"
    con = sqlite3.connect(db)
    con.executescript(
        """
        CREATE TABLE nodes (id TEXT PRIMARY KEY, node_type TEXT, name TEXT,
            retired_at TEXT);
        CREATE TABLE records (id TEXT PRIMARY KEY, title TEXT, content_hash TEXT);
        CREATE TABLE record_tags (tag_id TEXT PRIMARY KEY, status TEXT,
            record_id TEXT, node_id TEXT, created_at TEXT, created_by TEXT,
            note TEXT, reason TEXT, undone_at TEXT);
        """
    )
    con.commit()
    con.close()
    monkeypatch.setenv("GRAPH_DB_PATH", str(db))
    return db


def _stub_apply(monkeypatch, outcome=None, db=None):
    """Stand in for `assimilator.cli apply-tags`, writing the row it would."""

    def fake_run(cmd, **kwargs):
        if outcome is not None and db is not None:
            con = sqlite3.connect(db)
            ledger = tags.read_ledger()
            tag_id = [e["tag_id"] for e in ledger if e.get("op") == "tag"][-1]
            con.execute(
                "INSERT OR REPLACE INTO record_tags (tag_id, status, reason)"
                " VALUES (?,?,?)",
                (tag_id, outcome[0], outcome[1]),
            )
            con.commit()
            con.close()
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(tags.subprocess, "run", fake_run)


class TestWritingATag:
    def test_the_entry_names_the_record_by_content_hash(
        self, curation, graph_db, monkeypatch
    ):
        _stub_apply(monkeypatch, ("applied", None), graph_db)
        tags.add_tag(HASH, "Summoning", "topic", "why", "workbench/mark")

        [entry] = list(yaml.safe_load_all(curation.read_text()))
        assert entry["op"] == "tag"
        assert entry["node"] == {
            "name": "Summoning",
            "node_type": "topic",
            "prior_names": [],
        }
        # Prefixed, the form records.content_hash holds - the workbench keys on
        # the bare digest everywhere else, and the ledger must not be a third
        # spelling.
        assert entry["record"]["content_hash"] == PREFIXED
        assert entry["by"] == "workbench/mark"
        assert entry["note"] == "why"

    def test_a_prefixed_hash_is_not_prefixed_twice(
        self, curation, graph_db, monkeypatch
    ):
        _stub_apply(monkeypatch, ("applied", None), graph_db)
        tags.add_tag(PREFIXED, "Summoning", "topic", None, None)
        [entry] = list(yaml.safe_load_all(curation.read_text()))
        assert entry["record"]["content_hash"] == PREFIXED

    @pytest.mark.parametrize("name", ["", "   "])
    def test_an_empty_subject_is_refused(self, curation, graph_db, monkeypatch, name):
        _stub_apply(monkeypatch)
        with pytest.raises(ValueError):
            tags.add_tag(HASH, name, "topic", None, None)
        assert not curation.exists()


class TestTheOutcome:
    def test_applied_is_success(self, curation, graph_db, monkeypatch):
        _stub_apply(monkeypatch, ("applied", None), graph_db)
        out = tags.add_tag(HASH, "Summoning", "topic", None, None)
        assert out["status"] == "applied"
        assert out["ok"] is True

    def test_pending_is_not_a_failure(self, curation, graph_db, monkeypatch):
        """Most records in the store have no graph row - they have not been
        digested. The reviewer is reading the record NOW and knows what it is
        about; holding the judgement beats refusing it."""
        _stub_apply(monkeypatch, ("pending", "not digested yet?"), graph_db)
        out = tags.add_tag(HASH, "Summoning", "topic", None, None)
        assert out["status"] == "pending"
        assert out["ok"] is True
        assert out["reason"] == "not digested yet?"

    def test_lost_is_a_failure(self, curation, graph_db, monkeypatch):
        _stub_apply(monkeypatch, ("lost", "unknown node type"), graph_db)
        out = tags.add_tag(HASH, "Summoning", "wombat", None, None)
        assert out["status"] == "lost"
        assert out["ok"] is False

    def test_no_row_at_all_reads_as_pending(self, curation, graph_db, monkeypatch):
        """apply-tags has not reached it. That is pending in every sense that
        matters to somebody who just pressed the button."""
        _stub_apply(monkeypatch)
        assert (
            tags.add_tag(HASH, "Summoning", "topic", None, None)["status"] == "pending"
        )


class TestReadingBack:
    def test_a_pending_tag_is_still_shown(self, curation, graph_db, monkeypatch):
        """The whole reason the ledger is the source: a pending tag has no row
        keyed to the record, so a table-first read would show nothing."""
        _stub_apply(monkeypatch)
        tags.add_tag(HASH, "Summoning", "topic", None, "workbench/mark")

        [row] = tags.tags_for_record(HASH)
        assert row["name"] == "Summoning"
        assert row["status"] == "pending"

    def test_an_untagged_tag_disappears(self, curation, graph_db, monkeypatch):
        _stub_apply(monkeypatch, ("applied", None), graph_db)
        out = tags.add_tag(HASH, "Summoning", "topic", None, None)
        tags.remove_tag(out["tag_id"], "workbench/mark")
        assert tags.tags_for_record(HASH) == []

        # Withdrawn, not deleted: both entries survive in the ledger.
        ops = [e["op"] for e in yaml.safe_load_all(curation.read_text()) if e]
        assert ops == ["tag", "untag"]

    def test_another_record_s_tags_are_not_shown(self, curation, graph_db, monkeypatch):
        _stub_apply(monkeypatch)
        tags.add_tag(HASH, "Summoning", "topic", None, None)
        assert tags.tags_for_record("b" * 64) == []

    def test_the_name_it_resolved_to_is_reported(self, curation, graph_db, monkeypatch):
        """A subject renamed or merged since the tag was written resolves through
        its alias, so the name in the ledger is not the name it landed on. Saying
        so beats showing a name that no longer exists."""
        _stub_apply(monkeypatch, ("applied", None), graph_db)
        out = tags.add_tag(HASH, "Grey aliens", "topic", None, None)

        con = sqlite3.connect(graph_db)
        con.execute(
            "INSERT INTO nodes (id, node_type, name) VALUES ('n1','topic','The Greys')"
        )
        con.execute(
            "UPDATE record_tags SET node_id='n1' WHERE tag_id=?", (out["tag_id"],)
        )
        con.commit()
        con.close()

        [row] = tags.tags_for_record(HASH)
        assert row["name"] == "Grey aliens"
        assert row["resolved_name"] == "The Greys"


class TestTheEndpointIsGated:
    @pytest.fixture
    def client(self, tmp_path, monkeypatch):
        from fastapi.testclient import TestClient

        import backend.server as server

        ingests = tmp_path / "ingests"
        ingests.mkdir()
        (ingests / "roles.yaml").write_text("rev: reviewer\n")
        monkeypatch.setattr(server, "ingests_path", ingests)
        monkeypatch.setattr(
            server.tags, "add_tag", lambda *a, **k: {"ok": True, "status": "applied"}
        )
        monkeypatch.setattr(server.tags, "tags_for_record", lambda h: [])

        state: dict = {"user": None}
        monkeypatch.setattr(
            server,
            "_require_user",
            lambda request: state["user"]
            or (_ for _ in ()).throw(
                server.HTTPException(status_code=401, detail="Login required")
            ),
        )
        tc = TestClient(server.app)
        tc.login = lambda login: state.update(
            user={"login": login, "email": f"{login}@x.invalid"}
        )
        return tc

    def test_reading_needs_no_login(self, client):
        assert client.get(f"/api/ingests/{HASH}/tags").status_code == 200

    def test_writing_does(self, client):
        assert (
            client.post(f"/api/ingests/{HASH}/tags", json={"name": "X"}).status_code
            == 401
        )

    def test_a_contributor_may_not_tag(self, client):
        client.login("nobody")
        assert (
            client.post(f"/api/ingests/{HASH}/tags", json={"name": "X"}).status_code
            == 403
        )

    def test_a_reviewer_may(self, client):
        client.login("rev")
        assert (
            client.post(f"/api/ingests/{HASH}/tags", json={"name": "X"}).status_code
            == 200
        )

    def test_a_bad_hash_is_not_found(self, client):
        client.login("rev")
        assert (
            client.post("/api/ingests/nothash/tags", json={"name": "X"}).status_code
            == 404
        )
