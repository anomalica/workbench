"""The housekeeping sidecar follows the same copyright and currentness rules."""

from __future__ import annotations

import json
import subprocess

from anomalica_common import housekeeping as hk
from backend.prerender import GATED_FRONTMATTER_ALLOW, _gate_housekeeping

SIDECAR = {
    "schema": "anomalica/housekeeping/1",
    "content_hash": "sha256:abc",
    "items": [
        {"id": "a", "field": "description", "proposed": "a publisher blurb"},
        {"id": "b", "field": "date_published", "proposed": "1967"},
        {"id": "c", "field": "title", "proposed": "A Title"},
        {"id": "d", "field": "word_timestamps", "proposed": True},
    ],
}
VIEW = {"schema": "anomalica/housekeeping-view/1", "sidecar": SIDECAR}


def test_gated_housekeeping_is_the_exact_summary_variant():
    full = {
        **VIEW,
        "access": "full",
        "viewed_ref": "secret-ref",
        "state": "current",
        "due_reason": None,
        "outstanding_count": 4,
        "scopes": ["body", "frontmatter"],
        "deep_link": "/housekeeping?record=abc",
        "previews": {"a": {"removed": ["secret"], "added": []}},
    }
    summary = _gate_housekeeping(full)
    assert summary == {
        "schema": "anomalica/housekeeping-view/1",
        "access": "summary",
        "state": "current",
        "due_reason": None,
        "outstanding_count": 4,
        "scopes": ["body", "frontmatter"],
        "deep_link": "/housekeeping?record=abc",
        "sidecar": None,
    }
    assert "secret" not in json.dumps(summary)


def test_the_allow_list_is_unchanged_by_housekeeping():
    """Housekeeping must not widen the copyright gate. posted_by/posted_date are
    deliberately absent: adding them is a widening and needs Mark's sign-off.
    Impact today is nil - all 19 gated records are books and papers, and the
    redistributor check only fires on YouTube channels."""
    assert "posted_by" not in GATED_FRONTMATTER_ALLOW
    assert "source_hash" not in GATED_FRONTMATTER_ALLOW


def test_prerender_marks_only_the_exact_current_v2_tuple_current(tmp_path, monkeypatch):
    from backend import prerender, server

    content_hash = "a" * 64
    repo = tmp_path / "ingests"
    store = repo / "store"
    store.mkdir(parents=True)
    record = store / f"{content_hash}.md"
    original = f"---\ncontent_hash: sha256:{content_hash}\ntitle: T\n---\nOSSAP\n"
    record.write_text(original)
    sidecar = store / f"{content_hash}.housekeeping.json"
    sidecar.write_text(
        json.dumps(
            {
                "schema": hk.SCHEMA,
                "content_hash": f"sha256:{content_hash}",
                "input_sha256": hk.input_sha256(record.read_bytes()),
                "checked_at": "2026-09-11T00:00:00Z",
                "algorithm_version": hk.ALGORITHM_VERSION,
                "outcome": "completed",
                "items": [],
            }
        )
    )
    (repo / "housekeeping-algorithm.json").write_text(
        '{ "algorithm_version": "1", "schema": "anomalica/housekeeping-algorithm/1" }\n'
    )
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.invalid"], cwd=repo, check=True
    )
    subprocess.run(
        ["git", "config", "core.hooksPath", "/dev/null"], cwd=repo, check=True
    )
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "initial"], cwd=repo, check=True)

    monkeypatch.setattr(server, "ingests_path", repo)
    monkeypatch.setattr(server, "source", server.LocalIngestSource(repo))
    assert prerender._housekeeping_for(content_hash)["state"] == "current"

    record.write_text(original.replace("OSSAP", "AAWSAP"))
    subprocess.run(
        ["git", "add", "--", str(record.relative_to(repo))], cwd=repo, check=True
    )
    subprocess.run(
        ["git", "commit", "-q", "-m", "record changed"], cwd=repo, check=True
    )
    view = prerender._housekeeping_for(content_hash)
    assert view["state"] == "due" and view["due_reason"] == "input-mismatch"

    record.write_text(original)
    payload = json.loads(sidecar.read_text())
    payload["content_hash"] = f"sha256:{'b' * 64}"
    sidecar.write_text(json.dumps(payload))
    subprocess.run(["git", "add", "--", "store"], cwd=repo, check=True)
    subprocess.run(
        ["git", "commit", "-q", "-m", "wrong identity"], cwd=repo, check=True
    )
    view = prerender._housekeeping_for(content_hash)
    assert view["state"] == "due" and view["due_reason"] == "invalid-sidecar"
