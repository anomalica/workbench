"""Optimistic local writes and isolated housekeeping commits."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest
from anomalica_common import housekeeping as hk
from fastapi.testclient import TestClient

from backend import server

HASH = "a" * 64
RECORD = f"""---
schema: anomalica/record/1
content_hash: sha256:{HASH}
title: Test record
publisher: Old publisher
copyright:
  status: restricted
---
Body.
"""


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def _sidecar(record: str = RECORD, *, content_hash: str = HASH) -> hk.Sidecar:
    return hk.Sidecar(
        content_hash=f"sha256:{content_hash}",
        input_sha256=hk.input_sha256(record.encode()),
        checked_at="2026-09-11T00:00:00Z",
        algorithm_version=hk.ALGORITHM_VERSION,
        outcome="completed",
        items=[
            hk.Item(
                id="publisher",
                check="publisher",
                field="publisher",
                operation="set",
                current="Old publisher",
                proposed="New publisher",
                confidence="high",
                evidence=hk.Evidence(reasoning="The source identifies it."),
            )
        ],
    )


@pytest.fixture
def local_api(tmp_path: Path, monkeypatch):
    repo = tmp_path / "ingests"
    store = repo / "store"
    store.mkdir(parents=True)
    record = store / f"{HASH}.md"
    sidecar = store / f"{HASH}.housekeeping.json"
    record.write_text(RECORD)
    hk.write_sidecar_file(sidecar, _sidecar())
    (repo / "housekeeping-algorithm.json").write_text(
        f'{{ "algorithm_version": "{hk.ALGORITHM_VERSION}", '
        '"schema": "anomalica/housekeeping-algorithm/1" }\n'
    )
    (repo / "roles.yaml").write_text("rev: reviewer\n")
    _git(repo, "init", "-q")
    _git(repo, "config", "user.name", "Test")
    _git(repo, "config", "user.email", "test@example.invalid")
    _git(repo, "config", "core.hooksPath", "/dev/null")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "initial")

    monkeypatch.setattr(server, "ingests_path", repo)
    monkeypatch.setattr(server, "source", server.LocalIngestSource(repo))
    user = {"login": "rev", "name": "Reviewer", "email": "reviewer@example.invalid"}
    monkeypatch.setattr(server, "_require_user", lambda _request: user)
    monkeypatch.setattr(server, "_require_role", lambda _request, _role: user)
    return TestClient(server.app), repo, record, sidecar


def _housekeeping_view(client: TestClient) -> dict:
    response = client.get(f"/api/ingests/{HASH}/housekeeping")
    assert response.status_code == 200
    return response.json()


def _decide(
    client: TestClient,
    view: dict,
    status: str = "rejected",
    item_id: str = "publisher",
):
    return client.post(
        f"/api/ingests/{HASH}/housekeeping/decide",
        json={
            "schema": "anomalica/housekeeping-decision/1",
            **{key: value for key, value in view.items() if key.startswith("viewed_")},
            "decisions": [{"item_id": item_id, "status": status}],
        },
    )


def test_reads_return_canonical_git_identities(local_api):
    client, repo, record, sidecar = local_api
    ingest = client.get(f"/api/ingests/{HASH}").json()
    view = _housekeeping_view(client)

    assert ingest["base_ref"] == _git(repo, "rev-parse", "HEAD")
    assert ingest["base_record_sha"] == _git(
        repo, "rev-parse", f"HEAD:{record.relative_to(repo)}"
    )
    assert set(view) == {
        "schema",
        "access",
        "viewed_sidecar_sha",
        "viewed_ref",
        "viewed_content_hash",
        "viewed_input_sha256",
        "viewed_algorithm_version",
        "state",
        "due_reason",
        "outstanding_count",
        "scopes",
        "deep_link",
        "sidecar",
        "previews",
    }
    assert view["schema"] == "anomalica/housekeeping-view/1"
    assert view["access"] == "full"
    assert view["viewed_sidecar_sha"] == _git(
        repo, "rev-parse", f"HEAD:{sidecar.relative_to(repo)}"
    )
    assert view["state"] == "current"
    assert view["outstanding_count"] == 1
    assert view["scopes"] == ["frontmatter"]


def test_replace_token_view_has_preview_and_body_scope(local_api):
    client, repo, _record, sidecar = local_api
    start = RECORD.encode().index(b"Body")
    replacement = hk.Item(
        id="body-token",
        check="canonical-token",
        field=None,
        operation="replace-token",
        current=None,
        proposed=None,
        confidence="high",
        evidence=hk.Evidence(reasoning="Canonical spelling."),
        scope="body",
        old_token="Body",
        new_token="Text",
        case_sensitive=True,
        token_boundary="ascii-word",
        occurrences=[{"start_byte": start, "end_byte": start + 4}],
        expected_count=1,
    )
    sc = _sidecar()
    sc.items = [replacement]
    hk.write_sidecar_file(sidecar, sc)
    _git(repo, "add", "--", str(sidecar.relative_to(repo)))
    _git(repo, "commit", "-q", "-m", "token proposal")

    view = _housekeeping_view(client)
    assert view["scopes"] == ["body"]
    assert "preview" not in view["sidecar"]["items"][0]
    assert view["previews"]["body-token"] == {
        "removed": ["Body"],
        "added": ["Text"],
    }


def test_possession_success_includes_the_full_housekeeping_envelope(local_api):
    client, _repo, _record, _sidecar = local_api
    verification = _repo / "store" / f"{HASH}.verification.json"
    verification.write_text(
        json.dumps({"sha256": "source-possession-hash", "challenges": []})
    )

    response = client.post(
        f"/api/ingests/{HASH}/verification/submit",
        json={"sha256": "source-possession-hash"},
    )

    assert response.status_code == 200
    housekeeping = response.json()["housekeeping"]
    assert housekeeping["access"] == "full"
    assert housekeeping["sidecar"]["items"][0]["id"] == "publisher"
    assert "preview" not in housekeeping["sidecar"]["items"][0]
    assert housekeeping["previews"]["publisher"]["added"] == [
        'publisher: "New publisher"'
    ]


@pytest.mark.parametrize(
    "manifest",
    [
        '{"algorithm_version":"1","schema":"anomalica/housekeeping-algorithm/1"}\n',
        '{ "algorithm_version": "1", "schema": "anomalica/housekeeping-algorithm/1" }\n\n',
        '{ "algorithm_version": "bad version", "schema": "anomalica/housekeeping-algorithm/1" }\n',
        '{ "algorithm_version": "1", "extra": true, "schema": "anomalica/housekeeping-algorithm/1" }\n',
    ],
)
def test_housekeeping_get_fails_closed_on_noncanonical_manifest(local_api, manifest):
    client, repo, _record, _sidecar = local_api
    path = repo / "housekeeping-algorithm.json"
    path.write_text(manifest)
    _git(repo, "add", "--", path.name)
    _git(repo, "commit", "-q", "-m", "invalid manifest")

    assert client.get(f"/api/ingests/{HASH}/housekeeping").status_code == 503


def test_housekeeping_queue_uses_one_ref_wide_snapshot(local_api, monkeypatch):
    client, _repo, _record, _sidecar = local_api
    current_ref = server.source.current_ref
    calls = 0

    def counted_ref():
        nonlocal calls
        calls += 1
        return current_ref()

    monkeypatch.setattr(server.source, "current_ref", counted_ref)
    monkeypatch.setattr(
        server.source,
        "record_at_ref",
        lambda *_args: pytest.fail("queue fell back to per-record Git reads"),
    )
    server._housekeeping_queue_cache.clear()

    response = client.get("/api/housekeeping")

    assert response.status_code == 200
    assert response.json()["queue"][0]["content_hash"] == HASH
    assert calls == 1


def test_ordinary_save_requires_the_exact_viewed_record(local_api):
    client, _repo, record, _sidecar = local_api
    viewed = client.get(f"/api/ingests/{HASH}").json()

    response = client.put(
        f"/api/ingests/{HASH}",
        json={
            "content": RECORD.replace("Body.", "Editor body."),
            "notes": "",
            "base_record_sha": "b" * 40,
            "base_ref": viewed["base_ref"],
        },
    )

    assert response.status_code == 409
    assert record.read_text() == RECORD


def test_ordinary_save_requires_a_viewed_base_identity(local_api):
    client, _repo, record, _sidecar = local_api

    response = client.put(
        f"/api/ingests/{HASH}",
        json={"content": RECORD.replace("Body.", "Editor body."), "notes": ""},
    )

    assert response.status_code == 400
    assert record.read_text() == RECORD


def test_ordinary_save_rejects_the_superseded_nested_alias(local_api):
    client, _repo, record, _sidecar = local_api
    response = client.put(
        f"/api/ingests/{HASH}",
        json={
            "content": RECORD.replace("Body.", "Editor body."),
            "notes": "",
            "base": {"record_sha": "alias", "ref": "alias"},
        },
    )
    assert response.status_code == 400
    assert record.read_text() == RECORD


def test_ordinary_save_with_exact_blob_and_ref_commits(local_api):
    client, repo, record, _sidecar = local_api
    viewed = client.get(f"/api/ingests/{HASH}").json()
    response = client.put(
        f"/api/ingests/{HASH}",
        json={
            "content": RECORD.replace("Body.", "Editor body."),
            "notes": "",
            "base_record_sha": viewed["base_record_sha"],
            "base_ref": viewed["base_ref"],
        },
    )
    assert response.status_code == 200
    assert record.read_text().endswith("Editor body.\n")
    assert _git(repo, "show", "--name-only", "--format=", "HEAD").splitlines() == [
        str(record.relative_to(repo))
    ]
    assert _git(repo, "diff", "--cached", "--name-only", "HEAD") == ""


def test_successive_ordinary_saves_do_not_leave_reverse_staged_changes(local_api):
    client, repo, record, _sidecar = local_api

    for body in ("First editor body.", "Second editor body."):
        viewed = client.get(f"/api/ingests/{HASH}").json()
        response = client.put(
            f"/api/ingests/{HASH}",
            json={
                "content": RECORD.replace("Body.", body),
                "notes": "",
                "base_record_sha": viewed["base_record_sha"],
                "base_ref": viewed["base_ref"],
            },
        )

        assert response.status_code == 200
        assert _git(repo, "diff", "--cached", "--name-only", "HEAD") == ""

    assert record.read_text().endswith("Second editor body.\n")


def test_housekeeping_commit_makes_an_open_ordinary_editor_stale(local_api):
    client, _repo, record, _sidecar = local_api
    editor_view = client.get(f"/api/ingests/{HASH}").json()
    housekeeping_view = _housekeeping_view(client)
    assert _decide(client, housekeeping_view, "approved").status_code == 200

    response = client.put(
        f"/api/ingests/{HASH}",
        json={
            "content": RECORD.replace("Body.", "Older editor body."),
            "notes": "",
            "base_record_sha": editor_view["base_record_sha"],
            "base_ref": editor_view["base_ref"],
        },
    )

    assert response.status_code == 409
    assert 'publisher: "New publisher"' in record.read_text()
    assert "Older editor body" not in record.read_text()


def test_successive_housekeeping_commits_do_not_leave_reverse_staged_changes(
    local_api,
):
    client, repo, _record, sidecar = local_api
    sc = _sidecar()
    sc.items.append(
        hk.Item(
            id="publisher-two",
            check="publisher",
            field="publisher",
            operation="set",
            current="Old publisher",
            proposed="Other publisher",
            confidence="high",
            evidence=hk.Evidence(reasoning="A second proposal for the test."),
        )
    )
    hk.write_sidecar_file(sidecar, sc)
    _git(repo, "add", "--", str(sidecar.relative_to(repo)))
    _git(repo, "commit", "-q", "-m", "second proposal")

    assert _decide(client, _housekeeping_view(client)).status_code == 200
    assert _git(repo, "diff", "--cached", "--name-only", "HEAD") == ""
    assert (
        _decide(
            client,
            _housekeeping_view(client),
            item_id="publisher-two",
        ).status_code
        == 200
    )
    assert _git(repo, "diff", "--cached", "--name-only", "HEAD") == ""


def test_housekeeping_ref_cas_failure_leaves_both_files_unchanged(
    local_api, monkeypatch
):
    client, repo, record, sidecar = local_api
    view = _housekeeping_view(client)
    before_ref = _git(repo, "rev-parse", "HEAD")
    before_record = record.read_bytes()
    before_sidecar = sidecar.read_bytes()
    original_run = subprocess.run

    def fail_update_ref(command, **kwargs):
        if command[:2] == ["git", "update-ref"]:
            raise subprocess.CalledProcessError(1, command)
        return original_run(command, **kwargs)

    monkeypatch.setattr(subprocess, "run", fail_update_ref)
    response = _decide(client, view, "approved")

    assert response.status_code == 409
    head = original_run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert head == before_ref
    assert record.read_bytes() == before_record
    assert sidecar.read_bytes() == before_sidecar


def test_index_refresh_failure_happens_before_ref_cas_and_releases_lock(
    local_api, monkeypatch
):
    client, repo, record, sidecar = local_api
    view = _housekeeping_view(client)
    before_ref = _git(repo, "rev-parse", "HEAD")
    before_record = record.read_bytes()
    before_sidecar = sidecar.read_bytes()
    original_run = subprocess.run

    def fail_ordinary_index_refresh(command, **kwargs):
        index_file = kwargs.get("env", {}).get("GIT_INDEX_FILE", "")
        if command[:2] == ["git", "update-index"] and index_file.endswith("index.lock"):
            raise subprocess.CalledProcessError(1, command)
        return original_run(command, **kwargs)

    monkeypatch.setattr(subprocess, "run", fail_ordinary_index_refresh)
    response = _decide(client, view)

    assert response.status_code == 409
    assert _git(repo, "rev-parse", "HEAD") == before_ref
    assert record.read_bytes() == before_record
    assert sidecar.read_bytes() == before_sidecar
    assert not (repo / ".git" / "index.lock").exists()


def test_index_publish_failure_rolls_back_ref_and_releases_lock(local_api, monkeypatch):
    client, repo, record, sidecar = local_api
    view = _housekeeping_view(client)
    before_ref = _git(repo, "rev-parse", "HEAD")
    before_record = record.read_bytes()
    before_sidecar = sidecar.read_bytes()
    original_replace = os.replace

    def fail_index_publish(source, destination):
        if str(source).endswith("index.lock"):
            raise OSError("index publish failed")
        return original_replace(source, destination)

    monkeypatch.setattr(os, "replace", fail_index_publish)
    response = _decide(client, view)

    assert response.status_code == 409
    assert _git(repo, "rev-parse", "HEAD") == before_ref
    assert record.read_bytes() == before_record
    assert sidecar.read_bytes() == before_sidecar
    assert not (repo / ".git" / "index.lock").exists()


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("viewed_content_hash", f"sha256:{'b' * 64}"),
        ("viewed_input_sha256", f"sha256:{'b' * 64}"),
        ("viewed_algorithm_version", "old-algorithm"),
        ("viewed_sidecar_sha", "f" * 40),
        ("viewed_ref", "f" * 40),
    ],
)
def test_rejection_refuses_every_wrong_viewed_identity(local_api, field, value):
    client, repo, _record, sidecar = local_api
    before_ref = _git(repo, "rev-parse", "HEAD")
    before = sidecar.read_bytes()
    view = {**_housekeeping_view(client), field: value}

    response = _decide(client, view)

    assert response.status_code == 409
    assert _git(repo, "rev-parse", "HEAD") == before_ref
    assert sidecar.read_bytes() == before


def test_rejection_refuses_stale_record_and_uncommitted_sidecar(local_api):
    client, repo, record, sidecar = local_api
    view = _housekeeping_view(client)
    record.write_text(RECORD + "Changed after the pass.\n")
    assert _decide(client, view).status_code == 409

    record.write_text(RECORD)
    changed = json.loads(sidecar.read_text())
    changed["items"][0]["proposed"] = "Uncommitted operation"
    sidecar.write_text(json.dumps(changed, indent=2) + "\n")
    assert _decide(client, view).status_code == 409
    assert _git(repo, "rev-parse", "HEAD") == view["viewed_ref"]


def test_decision_rejects_aliases_and_duplicate_item_ids(local_api):
    client, _repo, _record, _sidecar = local_api
    view = _housekeeping_view(client)
    aliases = client.post(
        f"/api/ingests/{HASH}/housekeeping/decide",
        json={
            "schema": "anomalica/housekeeping-decision/1",
            "base": view,
            "decisions": [],
        },
    )
    assert aliases.status_code == 400

    payload = {
        "schema": "anomalica/housekeeping-decision/1",
        **{key: value for key, value in view.items() if key.startswith("viewed_")},
        "decisions": [
            {"item_id": "publisher", "status": "rejected"},
            {"item_id": "publisher", "status": "approved"},
        ],
    }
    assert (
        client.post(
            f"/api/ingests/{HASH}/housekeeping/decide", json=payload
        ).status_code
        == 400
    )


def test_repository_lock_uses_git_common_directory(local_api):
    _client, repo, _record, _sidecar = local_api
    from backend.sync import repository_write_lock

    with repository_write_lock(repo):
        assert (repo / ".git" / "anomalica-write.lock").is_file()


def test_v1_and_wrong_sidecar_content_hash_are_never_current_or_decidable(local_api):
    client, repo, _record, sidecar = local_api
    wrong = _sidecar(content_hash="b" * 64)
    hk.write_sidecar_file(sidecar, wrong)
    _git(repo, "add", "--", str(sidecar.relative_to(repo)))
    _git(repo, "commit", "-q", "-m", "wrong identity")
    viewed = _housekeeping_view(client)
    assert viewed["state"] == "due"
    assert _decide(client, viewed).status_code == 409

    legacy = json.loads(sidecar.read_text())
    legacy = {
        "schema": "anomalica/housekeeping/1",
        "content_hash": f"sha256:{HASH}",
        "checked_at": legacy["checked_at"],
        "checker_version": 1,
        "items": legacy["items"],
    }
    sidecar.write_text(json.dumps(legacy, indent=2) + "\n")
    _git(repo, "add", "--", str(sidecar.relative_to(repo)))
    _git(repo, "commit", "-q", "-m", "legacy")
    viewed = _housekeeping_view(client)
    assert viewed["state"] == "due"
    assert viewed["due_reason"] == "unsupported-schema"
    assert _decide(client, viewed).status_code == 409


def test_rejection_commit_contains_only_sidecar_and_preserves_other_changes(local_api):
    client, repo, record, sidecar = local_api
    staged = repo / "staged.txt"
    staged.write_text("staged\n")
    _git(repo, "add", "--", "staged.txt")
    unstaged = repo / "unstaged.txt"
    unstaged.write_text("unstaged\n")
    staged_blob = _git(repo, "rev-parse", ":staged.txt")
    view = _housekeeping_view(client)

    response = _decide(client, view)

    assert response.status_code == 200
    assert _git(repo, "show", "--name-only", "--format=", "HEAD").splitlines() == [
        str(sidecar.relative_to(repo))
    ]
    assert _git(repo, "rev-parse", ":staged.txt") == staged_blob
    assert _git(repo, "diff", "--cached", "--name-only", "HEAD") == "staged.txt"
    assert unstaged.read_text() == "unstaged\n"
    assert record.read_text() == RECORD


def test_commit_preserves_a_staged_edit_to_its_target_path(local_api):
    _client, repo, record, _sidecar = local_api
    staged_content = RECORD.replace("Body.", "User-staged body.")
    committed_content = RECORD.replace("Body.", "Workbench body.")
    record.write_text(staged_content)
    _git(repo, "add", "--", str(record.relative_to(repo)))

    server.source._commit_bytes_locked(
        {record: committed_content.encode()},
        "Workbench edit\n",
        "Reviewer",
        "reviewer@example.invalid",
        server.source.current_ref(),
    )

    assert record.read_text() == committed_content
    assert _git(repo, "show", f":{record.relative_to(repo)}") == staged_content.rstrip()
    assert (
        _git(repo, "show", f"HEAD:{record.relative_to(repo)}")
        == committed_content.rstrip()
    )
