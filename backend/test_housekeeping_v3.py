"""Local FastAPI integration for the housekeeping v3 contract."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from anomalica_common import housekeeping as hk
from fastapi.testclient import TestClient

from backend import prerender, proposals, server

HASH = "a" * 64
RECORD = f"""---
schema: anomalica/record/1
content_hash: sha256:{HASH}
title: Test record
copyright:
  status: public_domain
---
Body.
"""
MANIFEST = (
    f'{{ "algorithm_version": "{hk.ALGORITHM_VERSION}", '
    '"schema": "anomalica/housekeeping-algorithm/1" }\n'
)


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def _item(*, current: str = "Test record") -> hk.Item:
    return hk.Item(
        id="title",
        check="title",
        field="title",
        operation="set",
        current=current,
        proposed="Corrected record",
        confidence="high",
        evidence=hk.Evidence(reasoning="The source identifies the corrected title."),
        category="metadata",
        pass_name="deterministic",
    )


def _sidecar(
    raw: bytes,
    state: str,
    *,
    item: hk.Item | None = None,
) -> hk.Sidecar:
    sidecar = hk.new_sidecar(
        content_hash=f"sha256:{HASH}",
        raw_bytes=raw,
        checked_at="2026-09-17T01:00:00Z",
    )
    if state == "pending-deterministic":
        return sidecar
    if state == "failed-deterministic":
        hk.record_pass(
            sidecar,
            "deterministic",
            hk.PassState(
                status="failed",
                finished_at="2026-09-17T01:01:00Z",
                error="failed",
            ),
            observed_input_sha256=sidecar.input_sha256,
        )
        return sidecar
    hk.record_pass(
        sidecar,
        "deterministic",
        hk.PassState(status="completed", finished_at="2026-09-17T01:01:00Z"),
        [item] if item else [],
        observed_input_sha256=sidecar.input_sha256,
    )
    if state == "pending-research":
        return sidecar
    if state == "failed-research":
        hk.record_pass(
            sidecar,
            "metadata-research",
            hk.PassState(
                status="failed",
                finished_at="2026-09-17T01:02:00Z",
                error="research failed",
            ),
            observed_input_sha256=sidecar.input_sha256,
        )
        return sidecar
    hk.record_pass(
        sidecar,
        "metadata-research",
        hk.PassState(
            status="completed",
            finished_at="2026-09-17T01:02:00Z",
            usage={"transport": "subscription"},
        ),
        observed_input_sha256=sidecar.input_sha256,
    )
    return sidecar


@pytest.fixture
def local_api(tmp_path: Path, monkeypatch):
    repo = tmp_path / "ingests"
    store = repo / "store"
    store.mkdir(parents=True)
    record = store / f"{HASH}.md"
    sidecar = store / f"{HASH}.housekeeping.json"
    record.write_text(RECORD)
    (repo / "housekeeping-algorithm.json").write_text(MANIFEST)
    (repo / "roles.yaml").write_text("rev: reviewer\n")
    _git(repo, "init", "-q")
    _git(repo, "config", "user.name", "Test")
    _git(repo, "config", "user.email", "test@example.invalid")
    _git(repo, "config", "core.hooksPath", "/dev/null")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "initial")

    current_user = {
        "login": "rev",
        "name": "Reviewer",
        "email": "reviewer@example.invalid",
    }
    monkeypatch.setattr(server, "ingests_path", repo)
    monkeypatch.setattr(server, "source", server.LocalIngestSource(repo))
    monkeypatch.setattr(server, "_require_user", lambda _request: current_user)
    monkeypatch.setattr(server, "_require_role", lambda _request, _role: current_user)
    server._housekeeping_queue_cache.clear()
    return TestClient(server.app), repo, record, sidecar, current_user


def _commit_sidecar(repo: Path, path: Path, sidecar: hk.Sidecar) -> None:
    hk.write_sidecar_file(path, sidecar)
    _git(repo, "add", "--", str(path.relative_to(repo)))
    _git(repo, "commit", "-q", "-m", "housekeeping state")


def _view(client: TestClient) -> dict:
    response = client.get(f"/api/ingests/{HASH}/housekeeping")
    assert response.status_code == 200
    return response.json()


def _viewed(view: dict) -> dict:
    return {key: value for key, value in view.items() if key.startswith("viewed_")}


@pytest.mark.parametrize(
    "lifecycle",
    [
        "pending-deterministic",
        "failed-deterministic",
        "pending-research",
        "failed-research",
        "needs-decisions",
        "ready",
    ],
)
def test_read_view_uses_common_v3_lifecycle(local_api, lifecycle):
    client, repo, record, sidecar_path, _user = local_api
    item = _item() if lifecycle == "needs-decisions" else None
    _commit_sidecar(
        repo, sidecar_path, _sidecar(record.read_bytes(), lifecycle, item=item)
    )

    view = _view(client)

    assert view["schema"] == "anomalica/housekeeping-view/2"
    assert view["review_state"] == lifecycle
    assert view["sidecar"]["schema"] == "anomalica/housekeeping/3"
    assert view["viewed_input_sha256"] == view["sidecar"]["input_sha256"]
    assert view["viewed_result_sha256"] == view["sidecar"]["result_sha256"]
    assert view["outstanding_count"] == (1 if lifecycle == "needs-decisions" else 0)


def test_missing_and_v2_sidecars_are_read_only_due(local_api):
    client, repo, record, sidecar_path, _user = local_api
    missing = _view(client)
    assert missing["review_state"] == "due"
    assert missing["due_reason"] == "missing-sidecar"
    assert missing["viewed_input_sha256"] is None
    assert missing["viewed_result_sha256"] is None

    legacy = {
        "schema": "anomalica/housekeeping/2",
        "content_hash": f"sha256:{HASH}",
        "input_sha256": hk.input_sha256(record.read_bytes()),
        "checked_at": "2026-09-17T10:00:00Z",
        "algorithm_version": "2",
        "outcome": "completed",
        "items": [],
    }
    sidecar_path.write_text(json.dumps(legacy) + "\n")
    _git(repo, "add", "--", str(sidecar_path.relative_to(repo)))
    _git(repo, "commit", "-q", "-m", "legacy sidecar")

    view = _view(client)
    assert view["review_state"] == "due"
    assert view["due_reason"] == "unsupported-schema"
    assert view["sidecar"] == legacy
    assert view["viewed_input_sha256"] is None
    assert view["viewed_result_sha256"] is None


def test_gated_summary_exposes_no_viewed_identity_or_raw_sidecar(local_api):
    client, repo, record, sidecar_path, _user = local_api
    _commit_sidecar(
        repo,
        sidecar_path,
        _sidecar(record.read_bytes(), "needs-decisions", item=_item()),
    )

    summary = prerender._gate_housekeeping(_view(client), HASH[:56])

    assert summary == {
        "schema": "anomalica/housekeeping-view/2",
        "access": "summary",
        "review_state": "needs-decisions",
        "due_reason": None,
        "outstanding_count": 1,
        "scopes": ["frontmatter"],
        "deep_link": f"/housekeeping?record={HASH[:56]}",
        "sidecar": None,
    }


def test_decision_is_atomic_and_records_audit_and_result_hash(local_api):
    client, repo, record, sidecar_path, _user = local_api
    _commit_sidecar(
        repo,
        sidecar_path,
        _sidecar(record.read_bytes(), "needs-decisions", item=_item()),
    )
    view = _view(client)
    payload = {
        "schema": "anomalica/housekeeping-decision/2",
        **_viewed(view),
        "decisions": [{"item_id": "title", "status": "approved"}],
    }

    response = client.post(f"/api/ingests/{HASH}/housekeeping/decide", json=payload)

    assert response.status_code == 200
    assert 'title: "Corrected record"' in record.read_text()
    saved = json.loads(sidecar_path.read_text())
    assert saved["items"][0]["status"] == "approved"
    assert saved["decisions"] == [
        {
            "item_id": "title",
            "status": "approved",
            "decided_at": saved["decisions"][0]["decided_at"],
            "decided_by": "reviewer@example.invalid",
        }
    ]
    assert saved["result_sha256"] == hk.input_sha256(record.read_bytes())
    assert set(_git(repo, "show", "--name-only", "--format=", "HEAD").splitlines()) == {
        str(record.relative_to(repo)),
        str(sidecar_path.relative_to(repo)),
    }

    before = (
        record.read_bytes(),
        sidecar_path.read_bytes(),
        _git(repo, "rev-parse", "HEAD"),
    )
    assert (
        client.post(
            f"/api/ingests/{HASH}/housekeeping/decide", json=payload
        ).status_code
        == 409
    )
    assert (
        record.read_bytes(),
        sidecar_path.read_bytes(),
        _git(repo, "rev-parse", "HEAD"),
    ) == before


def test_apply_guard_failure_leaves_record_and_sidecar_unchanged(local_api):
    client, repo, record, sidecar_path, _user = local_api
    _commit_sidecar(
        repo,
        sidecar_path,
        _sidecar(
            record.read_bytes(),
            "needs-decisions",
            item=_item(current="Different title"),
        ),
    )
    view = _view(client)
    before = (
        record.read_bytes(),
        sidecar_path.read_bytes(),
        _git(repo, "rev-parse", "HEAD"),
    )

    response = client.post(
        f"/api/ingests/{HASH}/housekeeping/decide",
        json={
            "schema": "anomalica/housekeeping-decision/2",
            **_viewed(view),
            "decisions": [{"item_id": "title", "status": "approved"}],
        },
    )

    assert response.status_code == 409
    assert (
        record.read_bytes(),
        sidecar_path.read_bytes(),
        _git(repo, "rev-parse", "HEAD"),
    ) == before


@pytest.mark.parametrize("starting_state", ["pending-research", "failed-research"])
def test_research_waiver_is_a_sidecar_only_shared_transition(local_api, starting_state):
    client, repo, record, sidecar_path, _user = local_api
    _commit_sidecar(repo, sidecar_path, _sidecar(record.read_bytes(), starting_state))
    view = _view(client)
    record_before = record.read_bytes()

    response = client.post(
        f"/api/ingests/{HASH}/housekeeping/waive-research",
        json={
            "schema": "anomalica/housekeeping-research-waiver/1",
            **_viewed(view),
            "reason": "Research is not required for this record.",
        },
    )

    assert response.status_code == 200
    saved = json.loads(sidecar_path.read_text())
    research = saved["passes"]["metadata-research"]
    assert research["status"] == "waived"
    assert research["waiver"]["by"] == "reviewer@example.invalid"
    assert research["waiver"]["reason"] == "Research is not required for this record."
    assert research["finished_at"] == research["waiver"]["at"]
    assert record.read_bytes() == record_before
    assert _git(repo, "show", "--name-only", "--format=", "HEAD").splitlines() == [
        str(sidecar_path.relative_to(repo))
    ]
    assert _view(client)["review_state"] == "ready"

    before = (sidecar_path.read_bytes(), _git(repo, "rev-parse", "HEAD"))
    assert (
        client.post(
            f"/api/ingests/{HASH}/housekeeping/waive-research",
            json={
                "schema": "anomalica/housekeeping-research-waiver/1",
                **_viewed(view),
                "reason": "Research is not required for this record.",
            },
        ).status_code
        == 409
    )
    assert (sidecar_path.read_bytes(), _git(repo, "rev-parse", "HEAD")) == before


def test_content_review_continues_independently_of_housekeeping(local_api):
    client, repo, record, sidecar_path, user = local_api
    _commit_sidecar(
        repo, sidecar_path, _sidecar(record.read_bytes(), "pending-research")
    )
    viewed = client.get(f"/api/ingests/{HASH}").json()
    request = {
        "content": RECORD.replace("Body.", "Edited body."),
        "notes": "",
        "base_record_sha": viewed["base_record_sha"],
        "base_ref": viewed["base_ref"],
    }

    user.update(
        login="contributor", name="Contributor", email="contrib@example.invalid"
    )
    assert client.put(f"/api/ingests/{HASH}", json=request).status_code == 202
    assert len(proposals.list_pending(repo)) == 1
    assert record.read_text() == RECORD

    review_path = repo / "store" / f"{HASH}.review.json"
    review_path.write_text(
        json.dumps(
            {
                "schema": "anomalica/review-coverage/0",
                "reviews": [
                    {
                        "by": "earlier@example.invalid",
                        "at": "2026-09-17T09:00:00Z",
                        "spans": [],
                    }
                ],
            }
        )
        + "\n"
    )
    _git(repo, "add", "--", str(review_path.relative_to(repo)))
    _git(repo, "commit", "-q", "-m", "existing review")
    user.update(login="rev", name="Reviewer", email="reviewer@example.invalid")
    viewed = client.get(f"/api/ingests/{HASH}").json()
    request.update(
        base_record_sha=viewed["base_record_sha"], base_ref=viewed["base_ref"]
    )

    assert _view(client)["review_state"] == "excluded-review-state"
    queue = client.get("/api/housekeeping")
    assert queue.status_code == 200
    assert queue.json()["queue"][0]["review_state"] == "excluded-review-state"

    manifest = repo / "housekeeping-algorithm.json"
    manifest.unlink()
    _git(repo, "add", "-u", "--", manifest.name)
    _git(repo, "commit", "-q", "-m", "manifest temporarily unavailable")
    viewed = client.get(f"/api/ingests/{HASH}").json()
    request.update(
        base_record_sha=viewed["base_record_sha"], base_ref=viewed["base_ref"]
    )
    assert client.put(f"/api/ingests/{HASH}", json=request).status_code == 200
    assert record.read_text().endswith("Edited body.\n")
