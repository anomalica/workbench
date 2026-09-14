"""Manifest-bound, report-only account chronology review endpoints."""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest
import yaml
from fastapi import HTTPException
from fastapi.testclient import TestClient

from backend import account_chronology, server


HASH = "a" * 64


@pytest.fixture
def account_client(tmp_path: Path, monkeypatch):
    root = tmp_path
    benchmarks = root / "digester" / "workspace" / "benchmarks"
    reports = root / "digester" / "reports" / "accounts"
    digests = root / "digests"
    benchmarks.mkdir(parents=True)
    reports.mkdir(parents=True)
    digests.mkdir()

    digest_path = digests / "record.yaml"
    pre_digest_sha = "b" * 64
    digest = {
        "schema": "anomalica/digest/1",
        "record": {"content_hash": f"sha256:{HASH}"},
        "pre_digest": {"sha256": pre_digest_sha},
        "domain_claims": [
            {
                "id": "c1",
                "location": "00:00:01.000-00:00:02.000",
                "text": "First event",
                "quote": "first",
            },
            {
                "id": "c2",
                "location": "00:00:02.000-00:00:03.000",
                "text": "Second event",
                "quote": "second",
            },
            {"id": "lost", "text": "No usable location"},
        ],
        "infrastructure_claims": [],
    }
    digest_path.write_text(yaml.safe_dump(digest, sort_keys=False))
    digest_sha = hashlib.sha256(digest_path.read_bytes()).hexdigest()
    (reports / "legacy-gold.yaml").write_text(
        yaml.safe_dump(
            {
                "accounts": [
                    {
                        "title": "A reviewed account",
                        "summary": "A useful starting description.",
                        "approx_line_start": 10,
                        "approx_line_end": 20,
                    }
                ]
            }
        )
    )
    (reports / "legacy-prediction.yaml").write_text("accounts: []\n")
    binding = {
        "record_content_hash": f"sha256:{HASH}",
        "pre_digest_sha256": pre_digest_sha,
        "digest_sha256": digest_sha,
    }
    manifest = benchmarks / "account-chronology-evaluation.yaml"
    manifest.write_text(
        yaml.safe_dump(
            {
                "schema": "anomalica/account-chronology-evaluation-manifest/1",
                "canonical_activation": "forbidden",
                "gold_contract": {
                    "schema": "anomalica/account-chronology-evaluation/1"
                },
                "records": [
                    {
                        "record_content_hash": f"sha256:{HASH}",
                        "name": "Test account record",
                        "status": "legacy-evidence-not-scoreable",
                        "claim_digest": {
                            "path": "../../../digests/record.yaml",
                            "coordinate_system": "media_time_ms",
                            "claim_materialiser": "account_chronology_eval.materialise_claims_from_digest",
                            **binding,
                        },
                        "authenticated_gold": {
                            "status": "awaiting-human-review",
                            "path": "private/account-chronology/test/gold.yaml",
                            "coordinate_system": "media_time_ms",
                            **binding,
                        },
                        "scoreable_prediction": {
                            "status": "blocked",
                            "path": None,
                            "coordinate_system": "media_time_ms",
                            "reason": "No exact prediction yet.",
                            **binding,
                        },
                        "legacy_gold_path": "../../reports/accounts/legacy-gold.yaml",
                        "legacy_prediction_path": "../../reports/accounts/legacy-prediction.yaml",
                    }
                ],
            },
            sort_keys=False,
        )
    )

    real_manifest = (
        Path(__file__).resolve().parents[2]
        / "digester"
        / "workspace"
        / "benchmarks"
        / "account-chronology-evaluation.yaml"
    )
    evaluator = account_chronology._evaluator(real_manifest)
    monkeypatch.setattr(account_chronology, "_evaluator", lambda _path: evaluator)
    monkeypatch.setattr(server, "account_chronology_manifest", manifest)
    monkeypatch.setattr(
        server,
        "_require_role",
        lambda _request, _role: {
            "login": "reviewer",
            "name": "Reviewer",
            "email": "reviewer@example.invalid",
        },
    )
    return TestClient(
        server.app
    ), benchmarks / "private/account-chronology/test/gold.yaml"


def _review_body(base_gold_sha256=None):
    return {
        "base_gold_sha256": base_gold_sha256,
        "accounts": [{"id": "account-1", "spans": [{"start": 500, "end": 2500}]}],
        "before_pairs": [
            {
                "account_id": "account-1",
                "before_claim_id": "c1",
                "after_claim_id": "c2",
            }
        ],
        "unknown_pairs": [],
        "simultaneous_pairs": [],
    }


def test_get_materialises_exact_claim_universe_and_legacy_suggestions(account_client):
    client, _gold_path = account_client

    response = client.get(f"/api/ingests/{HASH}/account-chronology")

    assert response.status_code == 200
    view = response.json()
    assert view["report_only"] is True
    assert view["canonical_activation"] == "forbidden"
    assert view["coordinate_system"] == "media_time_ms"
    assert [(claim["id"], claim["position"]) for claim in view["claims"]] == [
        ("c1", 1000),
        ("c2", 2000),
        ("lost", None),
    ]
    assert view["suggestions"][0]["title"] == "A reviewed account"
    assert view["gold"] is None
    assert view["gold_sha256"] is None


def test_get_requires_reviewer_access(account_client, monkeypatch):
    client, _gold_path = account_client

    def forbidden(_request, _role):
        raise HTTPException(status_code=403, detail="Requires reviewer role")

    monkeypatch.setattr(server, "_require_role", forbidden)

    assert client.get(f"/api/ingests/{HASH}/account-chronology").status_code == 403


def test_get_returns_not_found_for_a_record_absent_from_the_manifest(account_client):
    client, _gold_path = account_client

    response = client.get(f"/api/ingests/{'f' * 64}/account-chronology")

    assert response.status_code == 404


def test_get_rejects_a_manifest_that_allows_canonical_activation(account_client):
    client, gold_path = account_client
    manifest_path = gold_path.parents[3] / "account-chronology-evaluation.yaml"
    manifest = yaml.safe_load(manifest_path.read_text())
    manifest["canonical_activation"] = "allowed"
    manifest_path.write_text(yaml.safe_dump(manifest, sort_keys=False))

    response = client.get(f"/api/ingests/{HASH}/account-chronology")

    assert response.status_code == 503
    assert response.json()["detail"] == "Account chronology must remain report-only"


def test_put_writes_complete_evaluator_valid_gold_atomically(account_client):
    client, gold_path = account_client

    response = client.put(
        f"/api/ingests/{HASH}/account-chronology", json=_review_body()
    )

    assert response.status_code == 200
    stored = yaml.safe_load(gold_path.read_text())
    assert stored["reviewed_by"] == "reviewer@example.invalid"
    assert [claim["id"] for claim in stored["claims"]] == ["c1", "c2", "lost"]
    assert stored["claim_assignments"] == [
        {"claim_id": "c1", "account_id": "account-1", "status": "bound"},
        {"claim_id": "c2", "account_id": "account-1", "status": "bound"},
        {"claim_id": "lost", "account_id": None, "status": "unlocatable"},
    ]
    assert (
        response.json()["gold_sha256"]
        == hashlib.sha256(gold_path.read_bytes()).hexdigest()
    )
    assert list(gold_path.parent.glob(".gold.yaml.*")) == []


def test_put_rejects_stale_gold_without_replacing_it(account_client):
    client, gold_path = account_client
    first = client.put(f"/api/ingests/{HASH}/account-chronology", json=_review_body())
    original = gold_path.read_bytes()

    stale = client.put(f"/api/ingests/{HASH}/account-chronology", json=_review_body())

    assert first.status_code == 200
    assert stale.status_code == 409
    assert gold_path.read_bytes() == original


def test_put_rejects_cross_account_chronology(account_client):
    client, gold_path = account_client
    body = _review_body()
    body["accounts"] = [
        {"id": "first", "spans": [{"start": 500, "end": 1500}]},
        {"id": "second", "spans": [{"start": 1500, "end": 2500}]},
    ]
    body["before_pairs"][0]["account_id"] = "first"

    response = client.put(f"/api/ingests/{HASH}/account-chronology", json=body)

    assert response.status_code == 400
    assert "crosses an account boundary" in response.json()["detail"]
    assert not gold_path.exists()
