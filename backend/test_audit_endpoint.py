#!/usr/bin/env python3
"""The /api/ingests/{hash}/audit endpoint: resolves a record's friendly name,
loads its variants, and returns the passage/cluster payload. Paths point at tmp
fixtures so nothing touches the real ingests/digests repos."""

import yaml
import pytest
from fastapi.testclient import TestClient

import backend.server as server

HASH = "a" * 64
NAME = "2026-01-02-video-example-record"


def _digest(model, claims):
    return {
        "schema": "anomalica/digest/1",
        "model": model,
        "ai_usage": [
            {
                "stage": "digest",
                "model": "claude-opus-4-8",
                "tokens": {"input": 200_000, "output": 10_000},
            }
        ],
        "prompts": [{"pass": "claims", "id": "claims", "version": "v3"}],
        "domain_claims": claims,
        "infrastructure_claims": [],
    }


@pytest.fixture
def audit_client(tmp_path, monkeypatch):
    ingests = tmp_path / "ingests"
    (ingests / "records").mkdir(parents=True)
    # A record file the friendly-name resolver reads (a plain file resolves to
    # itself; the v-suffix strip still applies to the stem).
    (ingests / "records" / f"{NAME}.v2.md").write_text(
        f"---\nschema: anomalica/record/1\ncontent_hash: {HASH}\ntitle: T\n---\nBody.\n"
    )
    digests = tmp_path / "digests"
    vdir = digests / "variants" / NAME
    vdir.mkdir(parents=True)
    (vdir / "opus.yaml").write_text(
        yaml.safe_dump(
            _digest(
                "opus",
                [
                    {
                        "id": "o1",
                        "location": "00:00:00-00:00:30",
                        "quote": "Q",
                        "text": "Jon ran for governor",
                    },
                    {
                        "id": "o2",
                        "location": "00:00:00-00:00:30",
                        "quote": "Q",
                        "text": "Only opus saw this",
                    },
                ],
            )
        )
    )
    (vdir / "haiku.yaml").write_text(
        yaml.safe_dump(
            _digest(
                "haiku",
                [
                    {
                        "id": "h1",
                        "location": "00:00:00-00:00:30",
                        "quote": "Q",
                        "text": "Jon ran for governor",
                    },
                ],
            )
        )
    )
    monkeypatch.setattr(server, "ingests_path", ingests)
    monkeypatch.setattr(server, "digests_path", digests)
    # The audit view is reviewer-gated; grant the test user that role.
    (ingests / "roles.yaml").write_text("rev: reviewer\n")
    monkeypatch.setattr(
        server,
        "_require_user",
        lambda request: {"login": "rev", "name": "Rev", "email": "rev@x.invalid"},
    )
    return TestClient(server.app)


def test_returns_variants_with_cost(audit_client):
    res = audit_client.get(f"/api/ingests/{HASH}/audit")
    assert res.status_code == 200
    body = res.json()
    assert body["record"]["friendly_name"] == NAME
    models = {v["model"]: v for v in body["variants"]}
    assert set(models) == {"opus", "haiku"}
    assert models["opus"]["cost_usd"] == 1.25  # (200k x $5 + 10k x $25) / 1M
    assert models["opus"]["claim_count"] == 2


def test_clusters_shared_and_singleton_claims(audit_client):
    body = audit_client.get(f"/api/ingests/{HASH}/audit").json()
    assert len(body["passages"]) == 1
    clusters = body["passages"][0]["clusters"]
    shared = [c for c in clusters if not c["singleton"]]
    singles = [c for c in clusters if c["singleton"]]
    assert len(shared) == 1
    assert set(shared[0]["variants"]) == {"opus", "haiku"}
    assert {m["model"] for m in shared[0]["members"]} == {"opus", "haiku"}
    assert len(singles) == 1
    assert singles[0]["members"][0]["text"] == "Only opus saw this"


def test_members_carry_source_text_and_location(audit_client):
    body = audit_client.get(f"/api/ingests/{HASH}/audit").json()
    member = body["passages"][0]["clusters"][0]["members"][0]
    assert member["location"] == "00:00:00-00:00:30"
    assert "quote" in member and "text" in member


def test_unknown_hash_404(audit_client):
    assert audit_client.get(f"/api/ingests/{'b' * 64}/audit").status_code == 404


def test_malformed_hash_404(audit_client):
    assert audit_client.get("/api/ingests/not-a-hash/audit").status_code == 404


def test_record_without_variants_404(audit_client, tmp_path, monkeypatch):
    # A record that resolves but has no digest/variants at all.
    other = "c" * 64
    (tmp_path / "ingests" / "records" / "2026-01-02-video-empty.v2.md").write_text(
        f"---\nschema: anomalica/record/1\ncontent_hash: {other}\ntitle: T\n---\nB\n"
    )
    assert audit_client.get(f"/api/ingests/{other}/audit").status_code == 404


def test_put_claim_verdict_writes_v2_gold(audit_client, tmp_path, monkeypatch):
    # The chips' save path end to end: validate, stamp reviewer + models set,
    # compute the fingerprint from the raw digest-shaped claim, upsert, save.
    # save_audit is faked - the REAL one commits to the ingests repo.
    store = tmp_path / "store"
    store.mkdir()
    written = {}
    monkeypatch.setattr(server.source, "audit_store_dir", lambda h: store)
    monkeypatch.setattr(
        server.source,
        "save_audit",
        lambda h, gold, name, email: written.update(gold=gold) or True,
    )
    entry = {
        "variant": "haiku.d161b1ed",
        "model": "haiku",
        "prompt_sha": "d161b1ed",
        "claim_id": "h1",
        "location": "00:00:00-00:00:30",
        "text": "Jon ran for governor",
        "quote": "Q",
        "claim_type": "domain",
        "quality": "good",
        "claim": {
            "text": "Jon ran for governor",
            "type": "domain",
            "quote": "Q",
            "location": "00:00:00-00:00:30",
        },
    }
    res = audit_client.put(f"/api/ingests/{HASH}/audit/claim", json=entry)
    assert res.status_code == 200, res.text
    gold = written["gold"]
    assert gold["schema"] == "anomalica/audit/2"
    [claim] = gold["claims"]
    assert claim["quality"] == "good"
    assert claim["reviewed_by"] == "rev@x.invalid"
    assert claim["gold_id"]
    # The raw claim is hashed then POPPED - never stored (anchors carry the text).
    assert "claim" not in claim
    assert len(claim.get("claim_fingerprint", "")) == 64
    # Spec-required models set, stamped from the variants on disk.
    assert {m["variant"] for m in gold["models"]} == {"opus", "haiku"}

    # Re-judging the same claim updates ONE entry (the press-3-then-2 path).
    entry["quality"] = "okay"
    res = audit_client.put(f"/api/ingests/{HASH}/audit/claim", json=entry)
    assert res.status_code == 200
    [claim] = written["gold"]["claims"]
    assert claim["quality"] == "okay"


def test_put_claim_rejects_bad_quality(audit_client, tmp_path, monkeypatch):
    monkeypatch.setattr(server.source, "audit_store_dir", lambda h: tmp_path)
    res = audit_client.put(
        f"/api/ingests/{HASH}/audit/claim",
        json={
            "variant": "v",
            "model": "m",
            "prompt_sha": "s",
            "claim_id": "c",
            "text": "t",
            "quality": "great",
        },
    )
    assert res.status_code == 400
