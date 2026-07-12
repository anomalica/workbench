#!/usr/bin/env python3
"""Adjudication gold: persistence, immutable gold_id, upsert/remove, and matching
an entry back to its current cluster by member provenance."""

from backend import audit_gold


def _adj(gold_id=None, verdict="real", members=None, text="a fact"):
    return {
        "gold_id": gold_id,
        "verdict": verdict,
        "location": "00:00:00-00:00:30",
        "text": text,
        "members": members
        or [{"variant": "opus", "claim_id": "c1", "verdict": "correct"}],
    }


class TestPersistence:
    def test_read_empty_when_absent(self, tmp_path):
        g = audit_gold.read(tmp_path, "a" * 64)
        assert g["schema"] == audit_gold.SCHEMA
        assert g["adjudications"] == []

    def test_write_then_read_roundtrips(self, tmp_path):
        g = audit_gold.empty("a" * 64)
        audit_gold.upsert(g, _adj(text="round trips"))
        audit_gold.write(tmp_path, "a" * 64, g)
        back = audit_gold.read(tmp_path, "a" * 64)
        assert back["adjudications"][0]["text"] == "round trips"

    def test_malformed_file_reads_empty(self, tmp_path):
        (tmp_path / f"{'a' * 64}.audit.json").write_text("{ not json")
        assert audit_gold.read(tmp_path, "a" * 64)["adjudications"] == []


class TestUpsert:
    def test_mints_a_gold_id_when_absent(self):
        g = audit_gold.empty("a" * 64)
        audit_gold.upsert(g, _adj())
        gid = g["adjudications"][0]["gold_id"]
        assert gid and len(gid) == 32

    def test_gold_id_is_stable_across_a_text_edit(self):
        # The whole point: editing the adjudicated text keeps the same identity.
        g = audit_gold.empty("a" * 64)
        audit_gold.upsert(g, _adj(text="original"))
        gid = g["adjudications"][0]["gold_id"]
        audit_gold.upsert(g, _adj(gold_id=gid, text="corrected typo"))
        assert len(g["adjudications"]) == 1
        assert g["adjudications"][0]["gold_id"] == gid
        assert g["adjudications"][0]["text"] == "corrected typo"

    def test_distinct_entries_get_distinct_ids(self):
        g = audit_gold.empty("a" * 64)
        audit_gold.upsert(g, _adj(text="one"))
        audit_gold.upsert(
            g, _adj(text="two", members=[{"variant": "haiku", "claim_id": "h1"}])
        )
        ids = {e["gold_id"] for e in g["adjudications"]}
        assert len(g["adjudications"]) == 2 and len(ids) == 2

    def test_remove(self):
        g = audit_gold.empty("a" * 64)
        audit_gold.upsert(g, _adj())
        gid = g["adjudications"][0]["gold_id"]
        assert audit_gold.remove(g, gid) is True
        assert g["adjudications"] == []
        assert audit_gold.remove(g, gid) is False


class TestMatch:
    clusters = [
        {
            "id": "c0",
            "members": [
                {"variant": "opus", "claim_id": "c1"},
                {"variant": "haiku", "claim_id": "h1"},
            ],
        },
        {"id": "c1", "members": [{"variant": "opus", "claim_id": "c2"}]},
    ]

    def test_matches_by_shared_member(self):
        adj = _adj(members=[{"variant": "haiku", "claim_id": "h1"}])
        assert audit_gold.match_adjudication(adj, self.clusters)["id"] == "c0"

    def test_prefers_the_higher_overlap_cluster(self):
        adj = _adj(members=[{"variant": "opus", "claim_id": "c2"}])
        assert audit_gold.match_adjudication(adj, self.clusters)["id"] == "c1"

    def test_missed_has_no_members_so_matches_nothing(self):
        missed = {
            "gold_id": "x",
            "verdict": "missed",
            "location": "1:00-1:30",
            "text": "the source said X",
            "members": [],
        }
        assert audit_gold.match_adjudication(missed, self.clusters) is None

    def test_no_match_when_no_member_overlap(self):
        adj = _adj(members=[{"variant": "sonnet", "claim_id": "s9"}])
        assert audit_gold.match_adjudication(adj, self.clusters) is None


# --- verdict endpoints (thin wrappers over the gold core) ---

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
import backend.server as server  # noqa: E402

HASH = "a" * 64


class _StubSource:
    def __init__(self, store):
        self.store = store
        self.saved = None

    def audit_store_dir(self, full_hash):
        return self.store

    def save_audit(self, full_hash, gold, author_name, author_email):
        self.saved = gold
        audit_gold.write(self.store, full_hash, gold)
        return True


@pytest.fixture
def verdict_client(tmp_path, monkeypatch):
    (tmp_path / "roles.yaml").write_text("rev: reviewer\n")
    monkeypatch.setattr(server, "ingests_path", tmp_path)
    stub = _StubSource(tmp_path)
    monkeypatch.setattr(server, "source", stub)
    monkeypatch.setattr(
        server,
        "_require_user",
        lambda request: {"login": "rev", "name": "Rev", "email": "rev@x.invalid"},
    )
    return TestClient(server.app), stub, tmp_path


def test_put_verdict_writes_gold_and_mints_id(verdict_client):
    client, stub, store = verdict_client
    res = client.put(
        f"/api/ingests/{HASH}/audit/verdict",
        json={
            "verdict": "real",
            "location": "0:00-0:30",
            "text": "a fact",
            "members": [{"variant": "opus", "claim_id": "c1", "verdict": "correct"}],
        },
    )
    assert res.status_code == 200
    gid = res.json()["gold_id"]
    assert len(gid) == 32
    saved = audit_gold.read(store, HASH)
    assert saved["adjudications"][0]["gold_id"] == gid
    assert saved["adjudications"][0]["verdict"] == "real"


def test_put_verdict_rejects_bad_verdict(verdict_client):
    client, _, _ = verdict_client
    res = client.put(f"/api/ingests/{HASH}/audit/verdict", json={"verdict": "maybe"})
    assert res.status_code == 400


def test_put_verdict_updates_by_gold_id(verdict_client):
    client, _, store = verdict_client
    r1 = client.put(
        f"/api/ingests/{HASH}/audit/verdict",
        json={
            "verdict": "real",
            "text": "v1",
            "members": [{"variant": "o", "claim_id": "c1"}],
        },
    )
    gid = r1.json()["gold_id"]
    client.put(
        f"/api/ingests/{HASH}/audit/verdict",
        json={"gold_id": gid, "verdict": "hallucinated", "text": "v2", "members": []},
    )
    gold = audit_gold.read(store, HASH)
    assert len(gold["adjudications"]) == 1
    assert gold["adjudications"][0]["verdict"] == "hallucinated"


def test_delete_verdict(verdict_client):
    client, _, store = verdict_client
    gid = client.put(
        f"/api/ingests/{HASH}/audit/verdict",
        json={"verdict": "missed", "text": "x", "members": []},
    ).json()["gold_id"]
    assert client.delete(f"/api/ingests/{HASH}/audit/verdict/{gid}").status_code == 200
    assert audit_gold.read(store, HASH)["adjudications"] == []


def test_verdict_endpoints_require_reviewer(verdict_client, monkeypatch):
    client, _, _ = verdict_client
    monkeypatch.setattr(
        server,
        "_require_user",
        lambda request: {"login": "newbie", "name": "N", "email": "n@x.invalid"},
    )
    assert (
        client.put(
            f"/api/ingests/{HASH}/audit/verdict",
            json={"verdict": "real", "members": []},
        ).status_code
        == 403
    )
