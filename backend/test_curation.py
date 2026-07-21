#!/usr/bin/env python3
"""Graph-curation write side (backend/curation.py).

The reads (candidates file) and the apply/undo validation - the shelled command
itself (python -m assimilator.merge) is the assimilator's and writes the live
DB, so it isn't invoked here; we test the file read + the guards that run BEFORE
shelling."""

import json

from backend import curation


def test_read_candidates_missing_file(monkeypatch, tmp_path):
    monkeypatch.setenv("ANOMALICA_MERGE_CANDIDATES", str(tmp_path / "absent.json"))
    assert curation.read_candidates() == []


def test_read_candidates_valid(monkeypatch, tmp_path):
    f = tmp_path / "merge-candidates.json"
    f.write_text(
        json.dumps(
            [
                {
                    "node_ids": ["a", "b"],
                    "suggested_canonical": "Thing",
                    "score": 0.9,
                    "node_type": "event",
                    "reason": "embedding",
                }
            ]
        )
    )
    monkeypatch.setenv("ANOMALICA_MERGE_CANDIDATES", str(f))
    c = curation.read_candidates()
    assert len(c) == 1 and c[0]["suggested_canonical"] == "Thing"


def test_read_candidates_garbage(monkeypatch, tmp_path):
    f = tmp_path / "merge-candidates.json"
    f.write_text("not json")
    monkeypatch.setenv("ANOMALICA_MERGE_CANDIDATES", str(f))
    assert curation.read_candidates() == []
    f.write_text('{"not": "a list"}')  # valid JSON, wrong shape
    assert curation.read_candidates() == []


def _cand(ids, reason="r"):
    return {
        "node_ids": ids,
        "suggested_canonical": ids[0],
        "score": 0.9,
        "node_type": "document",
        "reason": reason,
    }


def test_manual_candidates_merge_in_and_are_tagged(monkeypatch, tmp_path):
    (tmp_path / "merge-candidates.json").write_text(json.dumps([_cand(["a", "b"])]))
    (tmp_path / "merge-candidates-manual.json").write_text(
        json.dumps([_cand(["c", "d"])])
    )
    monkeypatch.setenv(
        "ANOMALICA_MERGE_CANDIDATES", str(tmp_path / "merge-candidates.json")
    )
    c = curation.read_candidates()
    assert [x["node_ids"] for x in c] == [["c", "d"], ["a", "b"]]  # manual first
    assert c[0]["source"] == "manual" and "source" not in c[1]


def test_manual_candidate_outranks_the_machines_duplicate(monkeypatch, tmp_path):
    # Same cluster in both files (propose_merges re-proposing a manually-staged
    # one): the manual entry wins - its reason carries the human verification -
    # and the cluster appears ONCE.
    (tmp_path / "merge-candidates.json").write_text(
        json.dumps([_cand(["b", "a"], reason="embedding")])
    )
    (tmp_path / "merge-candidates-manual.json").write_text(
        json.dumps([_cand(["a", "b"], reason="manual: verified via claims")])
    )
    monkeypatch.setenv(
        "ANOMALICA_MERGE_CANDIDATES", str(tmp_path / "merge-candidates.json")
    )
    c = curation.read_candidates()
    assert len(c) == 1
    assert c[0]["reason"] == "manual: verified via claims"


def test_manual_file_absent_changes_nothing(monkeypatch, tmp_path):
    (tmp_path / "merge-candidates.json").write_text(json.dumps([_cand(["a", "b"])]))
    monkeypatch.setenv(
        "ANOMALICA_MERGE_CANDIDATES", str(tmp_path / "merge-candidates.json")
    )
    assert [x["node_ids"] for x in curation.read_candidates()] == [["a", "b"]]


def test_malformed_manual_entries_are_dropped_not_queued(monkeypatch, tmp_path):
    # A one-node "merge", a non-dict, and a missing node_ids must never reach
    # the review queue - only the well-formed candidate does.
    (tmp_path / "merge-candidates.json").write_text("[]")
    (tmp_path / "merge-candidates-manual.json").write_text(
        json.dumps(
            [
                {"node_ids": ["only-one"]},
                "junk",
                {"reason": "no ids"},
                _cand(["a", "b"]),
            ]
        )
    )
    monkeypatch.setenv(
        "ANOMALICA_MERGE_CANDIDATES", str(tmp_path / "merge-candidates.json")
    )
    c = curation.read_candidates()
    assert [x["node_ids"] for x in c] == [["a", "b"]]


def test_apply_merge_validates_before_shelling():
    # Missing fields / survivor-as-victim must fail WITHOUT invoking the command.
    assert curation.apply_merge("", ["v"], "Name")["ok"] is False
    assert curation.apply_merge("s", [], "Name")["ok"] is False
    assert curation.apply_merge("s", ["v"], "")["ok"] is False
    r = curation.apply_merge("s", ["s", "v"], "Name")
    assert r["ok"] is False and "victim" in r["error"]


def test_undo_merge_requires_id():
    assert curation.undo_merge("")["ok"] is False


def test_candidate_key_is_order_independent():
    assert (
        curation.candidate_key(["b", "a"])
        == curation.candidate_key(["a", "b"])
        == "a,b"
    )
    assert curation.candidate_key([]) == ""


def _rejections_db(tmp_path, rows):
    import sqlite3

    db = tmp_path / "knowledge.db"
    con = sqlite3.connect(db)
    con.execute(
        "CREATE TABLE node_rejections (rejection_id TEXT, node_id TEXT, undone_at TEXT)"
    )
    con.executemany(
        "INSERT INTO node_rejections (rejection_id, node_id, undone_at) VALUES (?,?,?)",
        rows,
    )
    con.commit()
    con.close()
    return str(db)


def test_rejected_keys_reads_active_from_table(monkeypatch, tmp_path):
    db = _rejections_db(
        tmp_path,
        [
            ("r1", "a", None),
            ("r1", "b", None),
            ("r2", "c", "2026-06-21T00:00:00Z"),  # undone -> excluded
            ("r2", "d", "2026-06-21T00:00:00Z"),
        ],
    )
    monkeypatch.setenv("GRAPH_DB_PATH", db)
    assert curation.rejected_keys() == {"a,b"}


def test_rejected_keys_no_table(monkeypatch, tmp_path):
    import sqlite3

    db = tmp_path / "knowledge.db"
    sqlite3.connect(db).close()  # DB with no node_rejections table
    monkeypatch.setenv("GRAPH_DB_PATH", str(db))
    assert curation.rejected_keys() == set()


def test_reject_validates_before_shelling():
    assert curation.reject([])["ok"] is False
    assert curation.reject(["only-one"])["ok"] is False
