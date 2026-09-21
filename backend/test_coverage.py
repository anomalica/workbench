#!/usr/bin/env python3
"""Tests for review-coverage sidecar handling and the coverage endpoint."""

import hashlib
import json
import subprocess

import pytest
from fastapi.testclient import TestClient

import backend.server as server
from backend.server import COVERAGE_SCHEMA, COVERAGE_SCHEMA_V1, LocalIngestSource

CONTENT_HASH = "a" * 64

RECORD = f"""---
schema: anomalica/record/1
content_hash: {CONTENT_HASH}
title: Test Record
---
First line.

Second line.
"""


@pytest.fixture
def ingests_repo(tmp_path):
    repo = tmp_path / "ingests"
    store = repo / "store"
    store.mkdir(parents=True)
    (store / "test-record.md").write_text(RECORD)
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
    return repo


def test_append_coverage_creates_sidecar(ingests_repo):
    src = LocalIngestSource(ingests_repo)
    ok = src.append_coverage(
        CONTENT_HASH,
        email="reviewer@example.invalid",
        spans=[{"from": 0, "to": 2}],
        notes="looked, all fine",
    )
    assert ok

    sidecar = json.loads(
        (ingests_repo / "store" / f"{CONTENT_HASH}.review.json").read_text()
    )
    assert sidecar["schema"] == COVERAGE_SCHEMA
    assert len(sidecar["reviews"]) == 1
    entry = sidecar["reviews"][0]
    assert entry["by"] == "reviewer@example.invalid"
    assert entry["spans"] == [{"from": 0, "to": 2, "kind": "observed"}]
    assert entry["notes"] == "looked, all fine"
    assert entry["at"].endswith("Z")
    assert len(entry["parent_commit"]) == 40


def test_append_coverage_stores_verdict_at_v1(ingests_repo):
    src = LocalIngestSource(ingests_repo)
    ok = src.append_coverage(
        CONTENT_HASH,
        "a@example.invalid",
        [{"from": 0, "to": 9, "kind": "observed"}],
        "",
        observed_coverage=1.0,
        digestible=True,
        total_units=10,
    )
    assert ok
    sidecar = src.load_coverage(CONTENT_HASH)
    assert sidecar["schema"] == COVERAGE_SCHEMA_V1
    assert sidecar["observed_coverage"] == 1.0
    assert sidecar["digestible"] is True
    assert sidecar["total_units"] == 10
    body = server.parse_frontmatter(RECORD)[1]
    assert sidecar["reviewed_body_sha256"] == (
        "sha256:" + hashlib.sha256(body.encode("utf-8")).hexdigest()
    )


def test_append_coverage_without_verdict_stays_v0(ingests_repo):
    src = LocalIngestSource(ingests_repo)
    src.append_coverage(CONTENT_HASH, "a@example.invalid", [{"from": 0, "to": 1}], "")
    sidecar = src._load_coverage_file(CONTENT_HASH)
    assert sidecar["schema"] == COVERAGE_SCHEMA
    assert "observed_coverage" not in sidecar
    body = server.parse_frontmatter(RECORD)[1]
    assert sidecar["reviewed_body_sha256"] == (
        "sha256:" + hashlib.sha256(body.encode("utf-8")).hexdigest()
    )


@pytest.mark.parametrize("newline", ["\r\n", "\r"])
def test_append_coverage_hashes_exact_non_lf_body_bytes(ingests_repo, newline):
    record = ingests_repo / "store" / "test-record.md"
    exact_record = RECORD.replace("\n", newline)
    record.write_bytes(exact_record.encode("utf-8"))
    subprocess.run(["git", "add", str(record)], cwd=ingests_repo, check=True)
    subprocess.run(
        ["git", "commit", "-q", "-m", "change line endings"],
        cwd=ingests_repo,
        check=True,
    )
    src = LocalIngestSource(ingests_repo)

    src.append_coverage(CONTENT_HASH, "a@example.invalid", [{"from": 0, "to": 1}], "")

    sidecar = src._load_coverage_file(CONTENT_HASH)
    exact_body = server.parse_frontmatter(exact_record)[1]
    assert sidecar["reviewed_body_sha256"] == (
        "sha256:" + hashlib.sha256(exact_body.encode("utf-8")).hexdigest()
    )
    assert src.load_coverage(CONTENT_HASH) is not None


def test_append_coverage_is_append_only(ingests_repo):
    src = LocalIngestSource(ingests_repo)
    src.append_coverage(CONTENT_HASH, "a@example.invalid", [{"from": 0, "to": 1}], "")
    src.append_coverage(CONTENT_HASH, "b@example.invalid", [{"from": 3, "to": 5}], "")

    sidecar = src._load_coverage_file(CONTENT_HASH)
    assert [r["by"] for r in sidecar["reviews"]] == [
        "a@example.invalid",
        "b@example.invalid",
    ]
    # Empty notes are omitted entirely.
    assert "notes" not in sidecar["reviews"][0]


def test_append_coverage_unknown_hash(ingests_repo):
    src = LocalIngestSource(ingests_repo)
    assert not src.append_coverage("b" * 64, "a@example.invalid", [], "")


def test_commit_review_includes_sidecar(ingests_repo):
    src = LocalIngestSource(ingests_repo)
    src.append_coverage(
        CONTENT_HASH, "reviewer@example.invalid", [{"from": 0, "to": 1}], ""
    )
    src.commit_review(
        full_hash=CONTENT_HASH,
        author_name="Reviewer",
        author_email="reviewer@example.invalid",
        notes="",
    )
    files = subprocess.run(
        ["git", "show", "--name-only", "--format=", "HEAD"],
        cwd=ingests_repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()
    assert f"store/{CONTENT_HASH}.review.json" in files


@pytest.fixture
def client(ingests_repo, monkeypatch):
    monkeypatch.setattr(server, "source", LocalIngestSource(ingests_repo))
    return TestClient(server.app)


def test_coverage_endpoint_empty(client):
    res = client.get(f"/api/ingests/{CONTENT_HASH}/coverage")
    assert res.status_code == 200
    assert res.json() == {"reviews": []}


def test_coverage_endpoint_returns_all_reviewers(client, ingests_repo):
    src = LocalIngestSource(ingests_repo)
    src.append_coverage(CONTENT_HASH, "a@example.invalid", [{"from": 0, "to": 1}], "")
    src.append_coverage(CONTENT_HASH, "b@example.invalid", [{"from": 2, "to": 4}], "n")
    src.commit_review(
        full_hash=CONTENT_HASH,
        author_name="Reviewer",
        author_email="reviewer@example.invalid",
        notes="",
    )

    res = client.get(f"/api/ingests/{CONTENT_HASH}/coverage")
    assert res.status_code == 200
    reviews = res.json()["reviews"]
    assert [r["by"] for r in reviews] == ["a@example.invalid", "b@example.invalid"]
    assert reviews[1]["spans"] == [{"from": 2, "to": 4, "kind": "observed"}]


def test_coverage_endpoint_bad_hash(client):
    assert client.get("/api/ingests/nothex/coverage").status_code == 404


def test_validate_spans():
    from fastapi import HTTPException

    assert server._validate_spans(None) == []
    assert server._validate_spans([{"from": 0, "to": 0}]) == [
        {"from": 0, "to": 0, "kind": "observed"}
    ]
    for bad in [
        "x",
        [{"from": -1, "to": 2}],
        [{"from": 3, "to": 1}],
        [{"from": True, "to": 2}],
        [[0, 1]],
    ]:
        with pytest.raises(HTTPException):
            server._validate_spans(bad)


def test_validate_spans_kind():
    from fastapi import HTTPException

    # Explicit kinds pass through; missing kind defaults to observed.
    assert server._validate_spans([{"from": 0, "to": 1, "kind": "played"}]) == [
        {"from": 0, "to": 1, "kind": "played"}
    ]
    assert server._validate_spans([{"from": 0, "to": 1, "kind": "observed"}]) == [
        {"from": 0, "to": 1, "kind": "observed"}
    ]
    assert server._validate_spans([{"from": 0, "to": 1}]) == [
        {"from": 0, "to": 1, "kind": "observed"}
    ]
    for bad_kind in ["watched", "", 1, None]:
        with pytest.raises(HTTPException):
            server._validate_spans([{"from": 0, "to": 1, "kind": bad_kind}])


def test_append_coverage_stores_kind(ingests_repo):
    src = LocalIngestSource(ingests_repo)
    src.append_coverage(
        CONTENT_HASH,
        email="reviewer@example.invalid",
        spans=[
            {"from": 0, "to": 1, "kind": "played"},
            {"from": 3, "to": 5},  # legacy caller without kind
        ],
        notes="",
    )
    spans = src._load_coverage_file(CONTENT_HASH)["reviews"][0]["spans"]
    assert spans == [
        {"from": 0, "to": 1, "kind": "played"},
        {"from": 3, "to": 5, "kind": "observed"},
    ]


def test_coverage_revisions_by_path_matches_per_path_lookup(ingests_repo):
    """The batched revision walk returns each path's newest-touching commit,
    agreeing with the per-path git log it replaces in list_ingests."""
    p1 = "store/first.review.json"
    p2 = "store/second.review.json"
    for p in (p1, p2):
        f = ingests_repo / p
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text("{}")
    subprocess.run(["git", "add", "-A"], cwd=ingests_repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "both"], cwd=ingests_repo, check=True)
    c1 = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=ingests_repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    (ingests_repo / p2).write_text("{} touched")
    subprocess.run(["git", "add", "-A"], cwd=ingests_repo, check=True)
    subprocess.run(
        ["git", "commit", "-q", "-m", "p2 only"], cwd=ingests_repo, check=True
    )
    c2 = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=ingests_repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()

    src = LocalIngestSource(ingests_repo)
    batch = src._coverage_revisions_by_path(ingests_repo, [p1, p2])
    assert batch[p1] == c1
    assert batch[p2] == c2
    assert batch[p1] == src._latest_coverage_revision(ingests_repo, p1)
    assert batch[p2] == src._latest_coverage_revision(ingests_repo, p2)
    assert src._coverage_revisions_by_path(ingests_repo, []) == {}
    assert "store/absent.review.json" not in src._coverage_revisions_by_path(
        ingests_repo, ["store/absent.review.json"]
    )
