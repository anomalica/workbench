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
    assert c[0]["source"] == "manual" and c[1]["source"] == "rules"


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


def test_an_import_written_entry_is_not_called_manual(monkeypatch, tmp_path):
    """The assimilator's import now appends to the manual file. Its entries
    carry a reason beginning "import:", and must not be tagged as a reviewer's
    own proposal - that tag is what puts an entry ahead of the machine's."""
    manual = tmp_path / "manual.json"
    manual.write_text(
        json.dumps(
            [
                {
                    "node_ids": ["a", "b"],
                    "suggested_canonical": "a",
                    "score": 1.0,
                    "node_type": "organisation",
                    "reason": "import: 'AARO' minted beside a live organisation of the same name",
                },
                {
                    "node_ids": ["c", "d"],
                    "suggested_canonical": "c",
                    "score": 1.0,
                    "node_type": "person",
                    "reason": "manual: same person, verified via claims",
                },
            ]
        )
    )
    monkeypatch.setenv("ANOMALICA_MERGE_CANDIDATES_MANUAL", str(manual))
    monkeypatch.setenv("ANOMALICA_MERGE_CANDIDATES", str(tmp_path / "absent.json"))
    by_first = {c["node_ids"][0]: c for c in curation.read_candidates()}
    assert by_first["a"]["source"] == "import"
    assert by_first["c"]["source"] == "manual"


def test_each_machine_pass_names_itself(monkeypatch, tmp_path):
    manual = tmp_path / "manual.json"
    manual.write_text(
        json.dumps(
            [
                {
                    "node_ids": ["v1", "v2"],
                    "suggested_canonical": "v1",
                    "score": 1.0,
                    "node_type": "person",
                    "reason": "verify: Haiku judged one entity; 'A' [person, 9 claims] and 'A.' [person, 2 claims]",
                },
                {
                    "node_ids": ["h1", "h2"],
                    "suggested_canonical": "h1",
                    "score": 1.0,
                    "node_type": "person",
                    "reason": "same person, seen in claims",
                },
            ]
        )
    )
    monkeypatch.setenv("ANOMALICA_MERGE_CANDIDATES_MANUAL", str(manual))
    monkeypatch.setenv("ANOMALICA_MERGE_CANDIDATES", str(tmp_path / "absent.json"))
    by_first = {c["node_ids"][0]: c for c in curation.read_candidates()}
    assert by_first["v1"]["source"] == "verify"
    # No tag at all is a reviewer's entry, as the file was originally.
    assert by_first["h1"]["source"] == "manual"


def _entry(ids, reason, score, node_type="person"):
    return {
        "node_ids": ids,
        "suggested_canonical": ids[0],
        "score": score,
        "node_type": node_type,
        "reason": reason,
    }


def test_only_a_reviewer_s_entry_leads_and_machine_entries_rank_by_score(
    monkeypatch, tmp_path
):
    manual = tmp_path / "manual.json"
    manual.write_text(
        json.dumps(
            [
                _entry(["v1", "v2"], "verify: Haiku judged one entity", 0.95),
                _entry(["h1", "h2"], "same person, verified via claims", 0.5),
                _entry(
                    ["i1", "i2"],
                    "import: minted beside a live node of the same name",
                    0.7,
                ),
            ]
        )
    )
    rules = tmp_path / "rules.json"
    rules.write_text(json.dumps([_entry(["r1", "r2"], "fuzzy", 0.8)]))
    monkeypatch.setenv("ANOMALICA_MERGE_CANDIDATES_MANUAL", str(manual))
    monkeypatch.setenv("ANOMALICA_MERGE_CANDIDATES", str(rules))
    order = [c["node_ids"][0] for c in curation.read_candidates()]
    # The human entry first regardless of score; then every machine entry,
    # whichever file it came from, by score.
    assert order == ["h1", "v1", "r1", "i1"]


def test_a_pair_both_passes_surfaced_keeps_the_judgement_and_the_rules_score(
    monkeypatch, tmp_path
):
    manual = tmp_path / "manual.json"
    manual.write_text(
        json.dumps([_entry(["a", "b"], "verify: one entity, seen in claims", 0.9)])
    )
    rules = tmp_path / "rules.json"
    rules.write_text(json.dumps([_entry(["b", "a"], "fuzzy", 0.62)]))
    monkeypatch.setenv("ANOMALICA_MERGE_CANDIDATES_MANUAL", str(manual))
    monkeypatch.setenv("ANOMALICA_MERGE_CANDIDATES", str(rules))
    [c] = curation.read_candidates()
    assert c["reason"].startswith("verify:")
    assert c["source"] == "verify"
    assert c["rule_score"] == 0.62
