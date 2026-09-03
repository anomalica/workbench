#!/usr/bin/env python3
"""One page covering several subjects.

UAP and UFO are the same phenomenon under two vocabularies. Merging the nodes
would destroy which word each source used, so the nodes stay separate and one
page covers both. These pin the parts the workbench owns: the ledger entry is
keyed on natural identity rather than ids, and a member that no longer resolves
is reported rather than silently missing.

Nothing here touches the real curation repo or the real graph.
"""

import sqlite3
import subprocess

import pytest
import yaml

from backend import compositions

UAP = "11111111-1111-4111-8111-111111111111"
UFO = "22222222-2222-4222-8222-222222222222"


@pytest.fixture
def curation(tmp_path, monkeypatch):
    monkeypatch.setenv("ANOMALICA_CURATION_DIR", str(tmp_path / "curation"))
    return tmp_path / "curation" / "pages.yaml"


@pytest.fixture
def graph_db(tmp_path, monkeypatch):
    db = tmp_path / "knowledge.db"
    con = sqlite3.connect(db)
    con.executescript(
        """
        CREATE TABLE nodes (id TEXT PRIMARY KEY, node_type TEXT, name TEXT,
            retired_at TEXT);
        CREATE TABLE aliases (alias TEXT, node_id TEXT);
        -- Mirrors the assimilator's own schema. There is no undone_at: it
        -- rebuilds both tables from the ledger on every apply, so a decomposed
        -- page is simply absent.
        CREATE TABLE pages (page_id TEXT PRIMARY KEY, name TEXT, slug TEXT,
            node_type TEXT, created_at TEXT, created_by TEXT, note TEXT);
        CREATE TABLE page_members (page_id TEXT, node_id TEXT, position INT);
        CREATE TABLE superseded_pages (section TEXT, slug TEXT, page_id TEXT,
            node_id TEXT, reason TEXT);
        """
    )
    con.executemany(
        "INSERT INTO nodes (id, node_type, name) VALUES (?,?,?)",
        [
            (UAP, "topic", "Unidentified Anomalous Phenomena (UAP)"),
            (UFO, "topic", "Unidentified Flying Object (UFO)"),
        ],
    )
    con.execute(
        "INSERT INTO aliases (alias, node_id) VALUES ('Unidentified Aerial Phenomena (UAP)', ?)",
        (UAP,),
    )
    con.commit()
    con.close()
    monkeypatch.setenv("GRAPH_DB_PATH", str(db))
    return db


def _stub_apply(monkeypatch, db, *, members=(UAP, UFO), name=None, slug="a-page"):
    """Stand in for `assimilator.cli apply-pages`, writing the rows it would."""

    def fake_run(cmd, **kwargs):
        entries = [e for e in compositions.read_ledger() if e.get("op") == "compose"]
        if entries:
            e = entries[-1]
            con = sqlite3.connect(db)
            con.execute(
                "INSERT OR REPLACE INTO pages (page_id, name, slug, node_type,"
                " created_at) VALUES (?,?,?,?,?)",
                (e["page_id"], name or e["page"]["name"], slug, "topic", e["at"]),
            )
            for i, nid in enumerate(members):
                con.execute(
                    "INSERT INTO page_members (page_id, node_id, position) VALUES (?,?,?)",
                    (e["page_id"], nid, i),
                )
            con.commit()
            con.close()
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(compositions.subprocess, "run", fake_run)


class TestTheLedgerEntry:
    def test_members_are_named_not_identified(self, curation, graph_db, monkeypatch):
        """Node ids are minted fresh by every extraction, so a page keyed on them
        would replay onto nothing after a rebuild."""
        _stub_apply(monkeypatch, graph_db)
        compositions.compose("UAPs and UFOs", [UAP, UFO], None, "workbench/mark")

        [entry] = list(yaml.safe_load_all(curation.read_text()))
        assert entry["op"] == "compose"
        assert [m["name"] for m in entry["members"]] == [
            "Unidentified Anomalous Phenomena (UAP)",
            "Unidentified Flying Object (UFO)",
        ]
        assert all("id" not in m for m in entry["members"])
        assert entry["page"]["name"] == "UAPs and UFOs"
        assert entry["by"] == "workbench/mark"

    def test_a_member_carries_what_it_used_to_be_called(
        self, curation, graph_db, monkeypatch
    ):
        """So a member renamed between writing and replay still resolves."""
        _stub_apply(monkeypatch, graph_db)
        compositions.compose("A page", [UAP, UFO], None, None)
        [entry] = list(yaml.safe_load_all(curation.read_text()))
        assert (
            "Unidentified Aerial Phenomena (UAP)" in entry["members"][0]["prior_names"]
        )

    def test_a_page_needs_a_name(self, curation, graph_db, monkeypatch):
        _stub_apply(monkeypatch, graph_db)
        with pytest.raises(ValueError):
            compositions.compose("  ", [UAP, UFO], None, None)
        assert not curation.exists()

    def test_a_page_covers_at_least_two(self, curation, graph_db, monkeypatch):
        _stub_apply(monkeypatch, graph_db)
        with pytest.raises(ValueError):
            compositions.compose("A page", [UAP], None, None)
        assert not curation.exists()

    def test_members_that_do_not_resolve_are_not_written(
        self, curation, graph_db, monkeypatch
    ):
        _stub_apply(monkeypatch, graph_db)
        with pytest.raises(ValueError):
            compositions.compose("A page", [UAP, "gone"], None, None)


class TestTheOutcome:
    def test_it_reports_what_landed(self, curation, graph_db, monkeypatch):
        _stub_apply(monkeypatch, graph_db, slug="uaps-and-ufos")
        out = compositions.compose("UAPs and UFOs", [UAP, UFO], None, None)
        assert out["ok"] is True
        assert out["slug"] == "uaps-and-ufos"
        assert len(out["members"]) == 2
        assert out["dropped"] == []

    def test_a_dropped_member_is_named(self, curation, graph_db, monkeypatch):
        """A member that no longer resolves leaves the page composed of the rest.
        Saying nothing would leave a reviewer believing they covered two
        subjects when the page covers one."""
        _stub_apply(monkeypatch, graph_db, members=(UAP,))
        out = compositions.compose("UAPs and UFOs", [UAP, UFO], None, None)
        assert out["members"] == ["Unidentified Anomalous Phenomena (UAP)"]
        assert out["dropped"] == ["Unidentified Flying Object (UFO)"]

    def test_a_page_that_never_landed_raises(self, curation, graph_db, monkeypatch):
        def fake_run(cmd, **kwargs):
            return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="boom")

        monkeypatch.setattr(compositions.subprocess, "run", fake_run)
        with pytest.raises(RuntimeError, match="boom"):
            compositions.compose("A page", [UAP, UFO], None, None)


class TestListing:
    def test_a_composed_page_lists_its_members(self, curation, graph_db, monkeypatch):
        _stub_apply(monkeypatch, graph_db)
        compositions.compose("UAPs and UFOs", [UAP, UFO], None, None)
        [page] = compositions.list_compositions()
        assert page["name"] == "UAPs and UFOs"
        assert [m["name"] for m in page["members"]] == [
            "Unidentified Anomalous Phenomena (UAP)",
            "Unidentified Flying Object (UFO)",
        ]

    def test_a_graph_without_the_tables_lists_nothing(
        self, tmp_path, monkeypatch, curation
    ):
        db = tmp_path / "old.db"
        con = sqlite3.connect(db)
        con.execute("CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT)")
        con.commit()
        con.close()
        monkeypatch.setenv("GRAPH_DB_PATH", str(db))
        assert compositions.list_compositions() == []


class TestTheEndpointIsGated:
    @pytest.fixture
    def client(self, tmp_path, monkeypatch):
        from fastapi.testclient import TestClient

        import backend.server as server

        ingests = tmp_path / "ingests"
        ingests.mkdir()
        (ingests / "roles.yaml").write_text("ed: editor\nrev: reviewer\n")
        monkeypatch.setattr(server, "ingests_path", ingests)
        monkeypatch.setattr(
            server.compositions, "compose", lambda *a, **k: {"ok": True, "members": []}
        )
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

    def test_composing_needs_an_editor(self, client):
        body = {"name": "A page", "node_ids": [UAP, UFO]}
        assert client.post("/api/pages/compose", json=body).status_code == 401
        client.login("rev")
        assert client.post("/api/pages/compose", json=body).status_code == 403
        client.login("ed")
        assert client.post("/api/pages/compose", json=body).status_code == 200
