"""Admin-only evaluation registry and judgement endpoints."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
import yaml
from fastapi import HTTPException
from fastapi.testclient import TestClient

from backend import account_chronology, evaluations, server


@pytest.fixture
def evaluation_client(tmp_path: Path, monkeypatch):
    registry_path = tmp_path / "evaluations.yaml"
    registry_path.write_text(
        yaml.safe_dump(
            {
                "schema": "anomalica/evaluation-registry/2",
                "state_schema": "anomalica/evaluation-state/1",
                "statuses": [
                    "proposed",
                    "ready-for-human-review",
                    "reviewed",
                    "adopted",
                    "rejected",
                    "blocked",
                ],
                "gold_statuses": [
                    "unavailable",
                    "source-reviewed",
                    "provisional",
                    "ready-for-human-review",
                    "human-reviewed",
                    "reviewed-derived",
                ],
                "evaluations": [
                    {
                        "id": "search-reranker-minilm-vs-granite",
                        "title": "MiniLM versus Granite search reranking",
                        "purpose": "Compare identical candidate pools.",
                        "owner_repo": "anomalica/assimilator",
                        "evidence": {
                            "provider_id": "search-reranker-minilm-vs-granite-state",
                            "detail_capability": "search-reranker-human-judgements",
                        },
                        "limits": {
                            "rights": "CC0 project-authored claims only.",
                            "routes": "Local pinned models only.",
                        },
                        "artifacts": [
                            {
                                "id": "search-reranker-minilm-vs-granite-fixture",
                                "role": "fixture",
                                "visibility": "public",
                                "repository": "anomalica/assimilator",
                                "path": "fixture.json",
                            },
                            {
                                "id": "search-reranker-minilm-vs-granite-result",
                                "role": "result",
                                "visibility": "public",
                                "repository": "anomalica/assimilator",
                                "path": "controlled-run-2026-09-14/controlled-comparison-cuda.json",
                            },
                            {
                                "id": "search-reranker-minilm-vs-granite-state",
                                "role": "state",
                                "visibility": "public",
                                "repository": "anomalica/assimilator",
                                "path": "evaluation-state.json",
                            },
                            {
                                "id": "search-reranker-minilm-vs-granite-human-judgements",
                                "role": "gold",
                                "visibility": "private",
                            },
                        ],
                    },
                    {
                        "id": "account-chronology",
                        "title": "Account chronology extraction",
                        "purpose": "Review exact account boundaries.",
                        "owner_repo": "anomalica/digester",
                        "evidence": {
                            "provider_id": "account-chronology-state",
                            "detail_capability": "account-chronology-review",
                        },
                        "limits": {
                            "rights": "Controlled source text stays private.",
                            "routes": "Local report-only evaluation.",
                        },
                        "artifacts": [
                            {
                                "id": "account-chronology-gold",
                                "role": "gold",
                                "visibility": "private",
                            },
                            {
                                "id": "account-chronology-state",
                                "role": "state",
                                "visibility": "private",
                            },
                        ],
                    },
                ],
            },
            sort_keys=False,
        )
    )
    root = tmp_path / "search"
    controlled = root / "controlled-run-2026-09-14"
    controlled.mkdir(parents=True)
    fixture = {
        "schema": "anomalica/search-reranker-benchmark/1",
        "license": "CC0-1.0",
        "source": {"text_policy": "project-authored claims only"},
        "queries": [
            {
                "id": "q1",
                "query": "test query",
                "target": {"name": "Target", "node_type": "event"},
                "total_graph_relevant": 1,
                "candidates": [
                    {
                        "claim_id": "c1",
                        "text": "A project-authored claim.",
                        "relevance": 1,
                        "baseline_rank": 1,
                    }
                ],
            }
        ],
    }
    fixture_path = root / "fixture.json"
    fixture_path.write_text(json.dumps(fixture))
    fixture_sha = hashlib.sha256(fixture_path.read_bytes()).hexdigest()
    result = {
        "schema": "anomalica/search-reranker-controlled-result/1",
        "fixture": {"sha256": fixture_sha},
        "model": {
            "repo": "cross-encoder/ms-marco-MiniLM-L-6-v2",
            "revision": "c5ee24cb16019beea0893ab7796b1df96625c6b8",
            "snapshot": "/private/model/path",
        },
        "quality": {"ndcg_at_10": 1.0},
        "performance": {
            "query_latency_median_ms": 10,
            "cuda_peak_allocated_mib": 20,
        },
        "queries": [
            {
                "id": "q1",
                "top_10": [{"rank": 1, "claim_id": "c1", "relevance": 1, "score": 2.0}],
            }
        ],
    }
    (controlled / "controlled-minilm-cuda.json").write_text(json.dumps(result))
    granite = {
        **result,
        "model": {
            "repo": "ibm-granite/granite-embedding-english-r2",
            "revision": "47ea694b257b703fee9253d75c2b1f2985180498",
            "snapshot": "/private/granite/path",
        },
    }
    (controlled / "controlled-granite-cuda.json").write_text(json.dumps(granite))
    comparison_path = controlled / "controlled-comparison-cuda.json"
    comparison_path.write_text(
        json.dumps(
            {
                "schema": "anomalica/search-reranker-comparison/1",
                "fixture_sha256": fixture_sha,
                "quality_delta_granite_minus_minilm": {"ndcg_at_10": 0.0},
                "resource_ratios_granite_over_minilm": {"median_latency": 4.0},
                "criteria": {"median_latency_no_more_than_2x": False},
                "replace_minilm": False,
            }
        )
    )
    state_evidence = [
        {
            "artifact_id": "search-reranker-minilm-vs-granite-fixture",
            "sha256": f"sha256:{fixture_sha}",
        },
        {
            "artifact_id": "search-reranker-minilm-vs-granite-result",
            "sha256": f"sha256:{hashlib.sha256(comparison_path.read_bytes()).hexdigest()}",
        },
    ]
    evidence_sha = hashlib.sha256(
        json.dumps(
            state_evidence, ensure_ascii=False, separators=(",", ":"), sort_keys=True
        ).encode()
    ).hexdigest()
    (root / "evaluation-state.json").write_text(
        json.dumps(
            {
                "schema": "anomalica/evaluation-state/1",
                "evaluation_id": "search-reranker-minilm-vs-granite",
                "evidence": state_evidence,
                "evidence_sha256": f"sha256:{evidence_sha}",
                "status": "adopted",
                "gold": {
                    "status": "reviewed-derived",
                    "reviewed": 1,
                    "total": 1,
                    "unit": "queries",
                },
                "decision": {
                    "code": "retain-minilm",
                    "summary": "Retain MiniLM.",
                },
            }
        )
    )
    private_path = tmp_path / "private"
    account_manifest = tmp_path / "account.yaml"
    account_manifest.write_text(
        yaml.safe_dump(
            {
                "records": [
                    {
                        "record_content_hash": f"sha256:{'a' * 64}",
                        "authenticated_gold": {"status": "awaiting-human-review"},
                    }
                ]
            }
        )
    )

    monkeypatch.setattr(server, "evaluation_registry_path", registry_path)
    monkeypatch.setattr(server, "search_evaluation_root", root)
    monkeypatch.setattr(server, "assimilator_path", root)
    monkeypatch.setattr(server, "evaluation_private_path", private_path)
    monkeypatch.setattr(server, "account_chronology_manifest", account_manifest)
    monkeypatch.setattr(
        account_chronology,
        "load_review",
        lambda _path, full_hash: {
            "record_name": "Account record",
            "record_status": "legacy-evidence-not-scoreable",
            "prediction": {"status": "blocked", "reason": "No prediction."},
            "gold": None,
        },
    )
    monkeypatch.setattr(
        server.evaluations,
        "account_state",
        lambda _entry, _path, _views: {
            "schema": "anomalica/evaluation-state/1",
            "evaluation_id": "account-chronology",
            "evidence": [
                {
                    "artifact_id": "account-chronology-manifest",
                    "sha256": f"sha256:{'b' * 64}",
                }
            ],
            "evidence_sha256": f"sha256:{'c' * 64}",
            "status": "ready-for-human-review",
            "gold": {
                "status": "ready-for-human-review",
                "reviewed": 0,
                "total": 1,
                "unit": "claims",
            },
            "decision": {
                "code": "await-account-review",
                "summary": "Await account review.",
            },
        },
    )
    monkeypatch.setattr(
        server,
        "_require_role",
        lambda _request, _role: {
            "id": 123,
            "login": "admin",
            "name": "Admin",
            "email": "admin@example.invalid",
        },
    )
    return TestClient(server.app), private_path


def test_index_is_admin_only_and_omits_private_artifact_detail(evaluation_client):
    client, _private = evaluation_client

    response = client.get("/api/evaluations")

    assert response.status_code == 200
    row = response.json()["evaluations"][0]
    assert row["state"]["status"] == "adopted"
    assert row["state"]["gold"]["reviewed"] == 1
    assert "artifacts" not in row
    assert "items" not in row["state"]


def test_registry_rejects_non_admin(evaluation_client, monkeypatch):
    client, _private = evaluation_client

    def forbidden(_request, _role):
        raise HTTPException(status_code=403, detail="Requires admin role")

    monkeypatch.setattr(server, "_require_role", forbidden)
    assert client.get("/api/evaluations").status_code == 403


def test_search_detail_joins_authored_claim_text_without_private_model_paths(
    evaluation_client,
):
    client, _private = evaluation_client

    response = client.get("/api/evaluations/search-reranker-minilm-vs-granite")

    assert response.status_code == 200
    detail = response.json()
    assert detail["queries"][0]["rankings"]["minilm"][0]["text"] == (
        "A project-authored claim."
    )
    assert detail["queries"][0]["rankings"]["granite"][0]["relevance"] == 1
    assert "/private/model/path" not in response.text


def test_search_judgements_are_authenticated_and_compare_and_swap(evaluation_client):
    client, private = evaluation_client
    body = {
        "base_sha256": None,
        "fixture_sha256": hashlib.sha256(
            (server.search_evaluation_root / "fixture.json").read_bytes()
        ).hexdigest(),
        "judgements": {"q1": {"decision": "minilm", "note": "Clearer order."}},
    }

    saved = client.put(
        "/api/evaluations/search-reranker-minilm-vs-granite/judgements", json=body
    )
    stale = client.put(
        "/api/evaluations/search-reranker-minilm-vs-granite/judgements", json=body
    )

    assert saved.status_code == 200
    assert stale.status_code == 409
    stored = json.loads(
        (private / "search-reranker-minilm-vs-granite.json").read_text()
    )
    assert stored["reviewer"] == {
        "issuer": "github",
        "subject": "123",
        "name": "Admin",
    }


def test_account_detail_exposes_status_not_private_gold(evaluation_client):
    client, _private = evaluation_client

    response = client.get("/api/evaluations/account-chronology")

    assert response.status_code == 200
    assert response.json()["records"] == [
        {
            "record_hash": "a" * 64,
            "name": "Account record",
            "status": "legacy-evidence-not-scoreable",
            "prediction": {"status": "blocked", "reason": "No prediction."},
            "gold_status": "awaiting-human-review",
            "has_gold": False,
        }
    ]


def test_detail_and_write_routes_reject_non_admin(evaluation_client, monkeypatch):
    client, _private = evaluation_client

    def forbidden(_request, _role):
        raise HTTPException(status_code=403, detail="Requires admin role")

    monkeypatch.setattr(server, "_require_role", forbidden)
    assert (
        client.get("/api/evaluations/search-reranker-minilm-vs-granite").status_code
        == 403
    )
    assert (
        client.put(
            "/api/evaluations/search-reranker-minilm-vs-granite/judgements",
            json={},
        ).status_code
        == 403
    )


def test_state_validation_rejects_stale_public_evidence(tmp_path: Path):
    evidence_path = tmp_path / "result.json"
    evidence_path.write_text("before")
    evidence = [
        {
            "artifact_id": "result",
            "sha256": f"sha256:{hashlib.sha256(evidence_path.read_bytes()).hexdigest()}",
        }
    ]
    state = {
        "schema": "anomalica/evaluation-state/1",
        "evaluation_id": "test-evaluation",
        "evidence": evidence,
        "evidence_sha256": f"sha256:{hashlib.sha256(json.dumps(evidence, separators=(',', ':'), sort_keys=True).encode()).hexdigest()}",
        "status": "reviewed",
        "gold": {
            "status": "source-reviewed",
            "reviewed": 1,
            "total": 1,
            "unit": "records",
        },
    }
    evidence_path.write_text("after")

    with pytest.raises(evaluations.EvaluationError, match="stale"):
        evaluations.validate_state(
            {"id": "test-evaluation"}, state, {"result": evidence_path}
        )
