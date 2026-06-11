#!/usr/bin/env python3
"""Tests for review-coverage sidecar handling and the coverage endpoint."""

import json
import subprocess

import pytest
from fastapi.testclient import TestClient

import backend.server as server
from backend.server import COVERAGE_SCHEMA, LocalIngestSource

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
    assert entry["spans"] == [{"from": 0, "to": 2}]
    assert entry["notes"] == "looked, all fine"
    assert entry["at"].endswith("Z")
    assert len(entry["parent_commit"]) == 40


def test_append_coverage_is_append_only(ingests_repo):
    src = LocalIngestSource(ingests_repo)
    src.append_coverage(CONTENT_HASH, "a@example.invalid", [{"from": 0, "to": 1}], "")
    src.append_coverage(CONTENT_HASH, "b@example.invalid", [{"from": 3, "to": 5}], "")

    sidecar = src.load_coverage(CONTENT_HASH)
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

    res = client.get(f"/api/ingests/{CONTENT_HASH}/coverage")
    assert res.status_code == 200
    reviews = res.json()["reviews"]
    assert [r["by"] for r in reviews] == ["a@example.invalid", "b@example.invalid"]
    assert reviews[1]["spans"] == [{"from": 2, "to": 4}]


def test_coverage_endpoint_bad_hash(client):
    assert client.get("/api/ingests/nothex/coverage").status_code == 404


def test_validate_spans():
    from fastapi import HTTPException

    assert server._validate_spans(None) == []
    assert server._validate_spans([{"from": 0, "to": 0}]) == [{"from": 0, "to": 0}]
    for bad in [
        "x",
        [{"from": -1, "to": 2}],
        [{"from": 3, "to": 1}],
        [{"from": True, "to": 2}],
        [[0, 1]],
    ]:
        with pytest.raises(HTTPException):
            server._validate_spans(bad)
