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


def test_rejected_keys_missing_ledger(monkeypatch, tmp_path):
    monkeypatch.setenv("ANOMALICA_MERGE_REJECTIONS", str(tmp_path / "absent.json"))
    assert curation.rejected_keys() == set()


def test_rejected_keys_reads_ledger(monkeypatch, tmp_path):
    f = tmp_path / "rej.json"
    # tolerate both {node_ids:[...]} entries and bare id-arrays
    f.write_text(json.dumps([{"node_ids": ["a", "b"]}, ["c", "d"]]))
    monkeypatch.setenv("ANOMALICA_MERGE_REJECTIONS", str(f))
    assert curation.rejected_keys() == {"a,b", "c,d"}


def test_reject_validates_before_shelling():
    assert curation.reject([])["ok"] is False
    assert curation.reject(["only-one"])["ok"] is False
