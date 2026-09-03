#!/usr/bin/env python3
"""Renaming a graph node from the workbench.

The name IS the page title and the address, so this is a write to published
output - and the workbench holds the graph read-only, so it cannot make the
change itself. It drops a proposal file and the assimilator applies it through
the curation ledger, which is what survives a rebuild.

Two things these pin. The proposal must carry the name the reviewer SAW (a
rebuild mints new node ids, so the name is the fallback identity), and an
outcome that is not `applied` must never be reported as success: `rejected` and
`lost` both exit zero, so a caller reading the exit code tells somebody their
rename landed when nothing moved.

Nothing here reaches the real curation repo or the real graph: the curation
directory is a tmp_path and the assimilator call is stubbed.
"""

import json
import sqlite3
import subprocess

import pytest

from backend import pages

NID = "11111111-1111-4111-8111-111111111111"


@pytest.fixture
def curation(tmp_path, monkeypatch):
    monkeypatch.setenv("ANOMALICA_CURATION_DIR", str(tmp_path / "curation"))
    return tmp_path / "curation" / "rename-proposals"


@pytest.fixture
def graph_db(tmp_path, monkeypatch):
    db = tmp_path / "knowledge.db"
    con = sqlite3.connect(db)
    con.executescript(
        """
        CREATE TABLE nodes (id TEXT PRIMARY KEY, node_type TEXT, name TEXT,
            retired_at TEXT);
        CREATE TABLE page_proposals (node_id TEXT, node_type TEXT, tier TEXT,
            claim_count INT, source_count INT, independent_source_count INT,
            second_source_claims INT, subject_claims INT, status TEXT);
        CREATE TABLE page_vetoes (node_id TEXT);
        CREATE TABLE rename_proposals (id TEXT PRIMARY KEY, node_id TEXT,
            node_name_at_proposal TEXT, proposed_name TEXT, reason TEXT,
            proposed_by TEXT, proposed_at TEXT, status TEXT, resolved_at TEXT,
            resolution_note TEXT);
        CREATE TABLE claim_node_refs (claim_id TEXT, node_id TEXT);
        CREATE TABLE aliases (alias TEXT, node_id TEXT);
        """
    )
    con.execute(
        "INSERT INTO nodes (id, node_type, name) VALUES (?,?,?)",
        (NID, "topic", "Unidentified Flying Object (UFO)"),
    )
    con.execute(
        "INSERT INTO page_proposals (node_id, node_type, tier, claim_count,"
        " source_count, independent_source_count, second_source_claims,"
        " subject_claims, status) VALUES (?,?,?,?,?,?,?,?,?)",
        (NID, "topic", "1", 40, 6, 4, 9, 12, "proposed"),
    )
    con.commit()
    con.close()
    monkeypatch.setenv("GRAPH_DB_PATH", str(db))
    monkeypatch.setenv("ANOMALICA_BRIEFS_DIR", str(tmp_path / "briefs"))
    return db


def _stub_assimilator(monkeypatch, *, status, returncode=0, stderr=""):
    """Stand in for `assimilator.cli apply-renames`, recording its argv and
    writing the outcome the real command would have recorded."""
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, returncode, stdout="", stderr=stderr)

    monkeypatch.setattr(pages.subprocess, "run", fake_run)
    monkeypatch.setattr(
        pages,
        "rename_outcome",
        lambda pid: None if status is None else {"status": status, "note": None},
    )
    return calls


class TestTheProposalFile:
    def test_it_carries_the_name_the_reviewer_saw(self, curation, monkeypatch):
        _stub_assimilator(monkeypatch, status="applied")
        pages.propose_rename(NID, "Old Name", "New Name", "why", "workbench/mark")

        files = list(curation.glob("*.json"))
        assert len(files) == 1
        doc = json.loads(files[0].read_text())
        assert doc["node_id"] == NID
        assert doc["node_name_at_proposal"] == "Old Name"
        assert doc["proposed_name"] == "New Name"
        assert doc["reason"] == "why"
        assert doc["proposed_by"] == "workbench/mark"
        assert doc["id"]

    def test_two_renames_in_one_second_are_two_files(self, curation, monkeypatch):
        _stub_assimilator(monkeypatch, status="applied")
        pages.propose_rename(NID, "Old Name", "First", None, None)
        pages.propose_rename(NID, "Old Name", "Second", None, None)
        assert len(list(curation.glob("*.json"))) == 2

    def test_the_assimilator_is_asked_to_apply_it(self, curation, monkeypatch):
        calls = _stub_assimilator(monkeypatch, status="applied")
        pages.propose_rename(NID, "Old Name", "New Name", None, None)
        assert "apply-renames" in calls[0]

    @pytest.mark.parametrize("proposed", ["", "   ", "Old Name"])
    def test_a_name_that_changes_nothing_is_refused(
        self, curation, monkeypatch, proposed
    ):
        _stub_assimilator(monkeypatch, status="applied")
        with pytest.raises(ValueError):
            pages.propose_rename(NID, "Old Name", proposed, None, None)
        assert not curation.exists() or not list(curation.glob("*.json"))


class TestTheOutcomeIsReportedHonestly:
    def test_applied_is_the_new_name(self, curation, monkeypatch):
        _stub_assimilator(monkeypatch, status="applied")
        out = pages.propose_rename(NID, "Old Name", "New Name", None, None)
        assert out["ok"] is True
        assert out["name"] == "New Name"

    @pytest.mark.parametrize("status", ["lost", "pending"])
    def test_anything_else_is_not_success(self, curation, monkeypatch, status):
        """Both exit zero. Reading the exit code would call them success."""
        _stub_assimilator(monkeypatch, status=status)
        out = pages.propose_rename(NID, "Old Name", "New Name", None, None)
        assert out["ok"] is False
        assert out["status"] == status
        assert out["name"] == "Old Name"

    def test_an_unrecorded_proposal_raises(self, curation, monkeypatch):
        """No row means the command never got to it, whatever it exited with."""
        _stub_assimilator(monkeypatch, status=None, returncode=1, stderr="boom")
        with pytest.raises(RuntimeError, match="boom"):
            pages.propose_rename(NID, "Old Name", "New Name", None, None)

    def test_another_file_being_unreadable_does_not_lose_our_outcome(
        self, curation, monkeypatch
    ):
        """apply-renames exits non-zero when ANY file in the drop directory will
        not parse. Ours has a recorded outcome, so ours is what we report."""
        _stub_assimilator(
            monkeypatch, status="applied", returncode=1, stderr="one bad file"
        )
        assert (
            pages.propose_rename(NID, "Old Name", "New Name", None, None)["ok"] is True
        )


class TestTheTopicRow:
    def test_an_unlanded_rename_is_shown(self, graph_db, curation):
        con = sqlite3.connect(graph_db)
        con.execute(
            "INSERT INTO rename_proposals (id, node_id, node_name_at_proposal,"
            " proposed_name, proposed_at, status, resolution_note)"
            " VALUES ('p1', ?, 'Unidentified Flying Object (UFO)', 'UFO',"
            " '2026-09-03T00:00:00Z', 'rejected', 'name taken')",
            (NID,),
        )
        con.commit()
        con.close()

        topic = pages.list_topics()["topics"][0]
        assert topic["rename"] == {
            "status": "rejected",
            "proposed_name": "UFO",
            "note": "name taken",
        }

    def test_an_applied_rename_is_not_shown(self, graph_db, curation):
        """The row already carries the new name - repeating it is noise."""
        con = sqlite3.connect(graph_db)
        con.execute(
            "INSERT INTO rename_proposals (id, node_id, node_name_at_proposal,"
            " proposed_name, proposed_at, status) VALUES ('p1', ?, 'Old', 'New',"
            " '2026-09-03T00:00:00Z', 'applied')",
            (NID,),
        )
        con.commit()
        con.close()
        assert pages.list_topics()["topics"][0]["rename"] is None

    def test_the_latest_attempt_wins(self, graph_db, curation):
        con = sqlite3.connect(graph_db)
        con.executemany(
            "INSERT INTO rename_proposals (id, node_id, node_name_at_proposal,"
            " proposed_name, proposed_at, status) VALUES (?,?,?,?,?,?)",
            [
                ("p1", NID, "Old", "First try", "2026-09-01T00:00:00Z", "rejected"),
                ("p2", NID, "Old", "Second try", "2026-09-02T00:00:00Z", "lost"),
            ],
        )
        con.commit()
        con.close()
        assert (
            pages.list_topics()["topics"][0]["rename"]["proposed_name"] == "Second try"
        )

    def test_a_graph_without_the_table_still_lists(
        self, tmp_path, monkeypatch, curation
    ):
        """The pre-render must not fall over on a graph built before renames."""
        db = tmp_path / "old.db"
        con = sqlite3.connect(db)
        con.executescript(
            """
            CREATE TABLE nodes (id TEXT PRIMARY KEY, node_type TEXT, name TEXT,
                retired_at TEXT);
            CREATE TABLE page_proposals (node_id TEXT, node_type TEXT, tier TEXT,
                claim_count INT, source_count INT, independent_source_count INT,
                second_source_claims INT, subject_claims INT, status TEXT);
            CREATE TABLE page_vetoes (node_id TEXT);
            """
        )
        con.execute(
            "INSERT INTO nodes (id, node_type, name) VALUES (?,?,?)",
            (NID, "topic", "T"),
        )
        con.execute(
            "INSERT INTO page_proposals (node_id, node_type, tier, claim_count,"
            " source_count, independent_source_count, second_source_claims,"
            " subject_claims, status) VALUES (?,?,?,?,?,?,?,?,?)",
            (NID, "topic", "1", 4, 2, 2, 3, 2, "proposed"),
        )
        con.commit()
        con.close()
        monkeypatch.setenv("GRAPH_DB_PATH", str(db))
        monkeypatch.setenv("ANOMALICA_BRIEFS_DIR", str(tmp_path / "briefs"))
        topics = pages.list_topics()["topics"]
        assert len(topics) == 1
        assert topics[0]["rename"] is None


class TestTheEndpointIsGated:
    """A rename changes the page title and its address, so it is editor work -
    the same class as archiving a record, not an assessment of one. Vetoing and
    seeding decide what gets published at all and were ungated entirely."""

    @pytest.fixture
    def client(self, tmp_path, monkeypatch):
        from fastapi.testclient import TestClient

        import backend.server as server

        ingests = tmp_path / "ingests"
        ingests.mkdir()
        (ingests / "roles.yaml").write_text("ed: editor\nrev: reviewer\n")
        monkeypatch.setattr(server, "ingests_path", ingests)
        monkeypatch.setattr(
            server.pages,
            "propose_rename",
            lambda *a, **k: {"ok": True, "status": "applied"},
        )
        monkeypatch.setattr(server.pages, "veto", lambda *a, **k: {"ok": True})
        monkeypatch.setattr(server.pages, "add_seeded", lambda *a, **k: {"name": "x"})

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

    def _rename(self, client):
        return client.post(
            "/api/topics/rename",
            json={"node_id": NID, "name": "Old", "new_name": "New"},
        )

    def test_anonymous_is_refused(self, client):
        assert self._rename(client).status_code == 401

    def test_a_reviewer_is_refused(self, client):
        client.login("rev")
        assert self._rename(client).status_code == 403

    def test_an_editor_may_rename(self, client):
        client.login("ed")
        assert self._rename(client).status_code == 200

    def test_a_missing_node_id_is_a_bad_request(self, client):
        client.login("ed")
        assert (
            client.post("/api/topics/rename", json={"new_name": "New"}).status_code
            == 400
        )

    def test_veto_is_gated_too(self, client):
        client.login("rev")
        assert (
            client.post("/api/topics/veto", json={"node_ids": [NID]}).status_code == 403
        )
        client.login("ed")
        assert (
            client.post("/api/topics/veto", json={"node_ids": [NID]}).status_code == 200
        )

    def test_seeding_is_gated_too(self, client):
        client.login("rev")
        assert (
            client.post("/api/topics/seed", json={"name": "Summoning"}).status_code
            == 403
        )
        client.login("ed")
        assert (
            client.post("/api/topics/seed", json={"name": "Summoning"}).status_code
            == 200
        )


OTHER = "22222222-2222-4222-8222-222222222222"


def _add_node(db, node_id, name, node_type="topic", claims=0, retired=None):
    con = sqlite3.connect(db)
    con.execute(
        "INSERT INTO nodes (id, node_type, name, retired_at) VALUES (?,?,?,?)",
        (node_id, node_type, name, retired),
    )
    for i in range(claims):
        con.execute(
            "INSERT INTO claim_node_refs (claim_id, node_id) VALUES (?,?)",
            (f"{node_id}-c{i}", node_id),
        )
    con.commit()
    con.close()


class TestRenamingOntoATakenName:
    """Typing a name another node already has is not a dead end. It is the
    reviewer saying these two are one thing, so it becomes a merge into the node
    that holds the name - which keeps the folded-in node's name as an alias."""

    @pytest.fixture
    def merged(self, monkeypatch):
        """Records what would be merged instead of running the assimilator."""
        calls = []

        def fake_apply(survivor_id, victim_ids, canonical_name, **kw):
            calls.append((survivor_id, victim_ids, canonical_name, kw))
            return {"ok": True}

        from backend import curation

        monkeypatch.setattr(curation, "apply_merge", fake_apply)
        return calls

    def test_same_type_merges_into_the_node_holding_the_name(
        self, graph_db, curation, monkeypatch, merged
    ):
        _add_node(graph_db, OTHER, "The Greys", "topic", claims=9)
        _stub_assimilator(monkeypatch, status="rejected")

        out = pages.propose_rename(NID, "Grey aliens", "The Greys", None, None)

        assert out["status"] == "merged"
        assert out["ok"] is True
        assert out["merged_into"]["id"] == OTHER
        # Survivor is the node that HOLDS the name, so its name needs no change.
        assert merged == [
            (
                OTHER,
                [NID],
                "The Greys",
                {"by": None, "confirmed_by": None, "confirmed_via": "workbench-rename"},
            )
        ]

    def test_a_different_kind_of_thing_is_asked_about_first(
        self, graph_db, curation, monkeypatch, merged
    ):
        """An exact name match between two topics is strong evidence of sameness.
        Between a topic and a person it is more likely two things that read
        alike - and the assimilator's merge does not check types at all."""
        _add_node(graph_db, OTHER, "The Greys", "person", claims=9)
        _stub_assimilator(monkeypatch, status="rejected")

        out = pages.propose_rename(NID, "Grey aliens", "The Greys", None, None)

        assert out["status"] == "clash"
        assert out["ok"] is False
        assert out["target"]["node_type"] == "person"
        assert out["source"]["node_type"] == "topic"
        assert merged == []

    def test_a_different_kind_merges_when_confirmed(
        self, graph_db, curation, monkeypatch, merged
    ):
        _add_node(graph_db, OTHER, "The Greys", "person", claims=9)
        _stub_assimilator(monkeypatch, status="rejected")

        out = pages.propose_rename(
            NID, "Grey aliens", "The Greys", None, None, confirm_merge=True
        )

        assert out["status"] == "merged"
        assert merged == [
            (
                OTHER,
                [NID],
                "The Greys",
                {"by": None, "confirmed_by": None, "confirmed_via": "workbench-rename"},
            )
        ]

    def test_a_retired_node_does_not_hold_a_name(
        self, graph_db, curation, monkeypatch, merged
    ):
        """The assimilator clashes only on LIVE nodes, so a merged-away one must
        not pull a rename into a merge with a node nobody can see."""
        _add_node(graph_db, OTHER, "The Greys", "topic", retired="2026-01-01")
        _stub_assimilator(monkeypatch, status="rejected")

        out = pages.propose_rename(NID, "Grey aliens", "The Greys", None, None)

        assert out["status"] == "rejected"
        assert merged == []

    def test_a_failed_merge_is_reported_as_such(self, graph_db, curation, monkeypatch):
        from backend import curation as curation_module

        _add_node(graph_db, OTHER, "The Greys", "topic", claims=9)
        _stub_assimilator(monkeypatch, status="rejected")
        monkeypatch.setattr(
            curation_module,
            "apply_merge",
            lambda *a, **k: {"ok": False, "error": "db locked"},
        )

        out = pages.propose_rename(NID, "Grey aliens", "The Greys", None, None)
        assert out["ok"] is False
        assert out["note"] == "db locked"
        assert out["name"] == "Grey aliens"


class TestNameSuggestions:
    """What makes the rename usable: the name being reached for usually exists
    already, spelled a little differently."""

    def test_the_best_match_comes_first(self, graph_db):
        _add_node(graph_db, OTHER, "The Greys", claims=9)
        _add_node(graph_db, "n3", "Greys of Zeta Reticuli", claims=40)
        _add_node(graph_db, "n4", "Tall whites and the greys compared", claims=2)

        names = [s["name"] for s in pages.name_suggestions("greys")]
        # Nobody types the leading article, so "The Greys" has to rank with the
        # names that start with the word, not below them - and the shorter name
        # wins that tie. Ordered by name instead, the thing being looked for
        # would sit last of the three.
        assert names == [
            "The Greys",
            "Greys of Zeta Reticuli",
            "Tall whites and the greys compared",
        ]

    def test_an_exact_name_beats_a_shorter_one(self, graph_db):
        _add_node(graph_db, OTHER, "Greys", claims=1)
        _add_node(graph_db, "n3", "Grey", claims=99)
        assert pages.name_suggestions("greys")[0]["name"] == "Greys"

    def test_an_alias_finds_it_and_says_so(self, graph_db):
        _add_node(graph_db, OTHER, "The Greys", claims=9)
        con = sqlite3.connect(graph_db)
        con.execute("CREATE TABLE IF NOT EXISTS aliases (alias TEXT, node_id TEXT)")
        con.execute(
            "INSERT INTO aliases (alias, node_id) VALUES ('Zeta Reticulans', ?)",
            (OTHER,),
        )
        con.commit()
        con.close()

        hit = pages.name_suggestions("Zeta")[0]
        assert hit["name"] == "The Greys"
        assert hit["via"] == "Zeta Reticulans"

    def test_the_node_being_renamed_is_not_offered(self, graph_db):
        assert pages.name_suggestions("Unidentified", exclude=NID) == []

    def test_a_retired_node_is_not_offered(self, graph_db):
        _add_node(graph_db, OTHER, "The Greys", retired="2026-01-01")
        assert pages.name_suggestions("Greys") == []

    def test_one_letter_asks_nothing(self, graph_db):
        assert pages.name_suggestions("G") == []


def test_a_merge_from_a_rename_carries_the_confirmation(
    graph_db, curation, monkeypatch
):
    """Mark's rule: no session merges anything he has not confirmed here. The
    confirmation is the person who typed a name that already existed and pressed
    a button that said Merge into it - so it travels with the merge, naming the
    control it came from."""
    from backend import curation as curation_module

    _add_node(graph_db, OTHER, "The Greys", "topic", claims=9)
    _stub_assimilator(monkeypatch, status="rejected")
    seen: dict = {}
    monkeypatch.setattr(
        curation_module,
        "apply_merge",
        lambda *a, **kw: (seen.update(kw), {"ok": True})[1],
    )

    pages.propose_rename(NID, "Grey aliens", "The Greys", None, "workbench/mark")

    assert seen["confirmed_by"] == "workbench/mark"
    assert seen["confirmed_via"] == "workbench-rename"
