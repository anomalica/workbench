#!/usr/bin/env python3
"""Tests for detecting a record superseded/re-ingested while open."""

import subprocess

import pytest
from fastapi.testclient import TestClient

import backend.server as server
from backend.server import LocalIngestSource

OLD = "a" * 64
NEW = "b" * 64

OLD_RECORD = f"""---
schema: anomalica/record/1
content_hash: {OLD}
title: The Article
---
Body.
"""


@pytest.fixture
def ingests_repo(tmp_path):
    repo = tmp_path / "ingests"
    store = repo / "store"
    store.mkdir(parents=True)
    (store / f"{OLD}.md").write_text(OLD_RECORD)
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    return repo


@pytest.fixture
def client(ingests_repo, monkeypatch):
    monkeypatch.setattr(server, "source", LocalIngestSource(ingests_repo))
    return TestClient(server.app)


def test_not_superseded_when_current(client):
    data = client.get(f"/api/ingests/{OLD}/supersession").json()
    assert data == {"exists": True, "superseded_by": None, "public_supersedes": None}


def test_reports_supersession_after_reingest(client, ingests_repo):
    # Simulate the ingester's supersession: move the old record to store/v1/
    # with a superseded_by pointer, add the new record.
    store = ingests_repo / "store"
    v1 = store / "v1"
    v1.mkdir()
    (v1 / f"{OLD}.md").write_text(
        OLD_RECORD.replace("---\nBody.", f"superseded_by: {NEW}\n---\nBody.")
    )
    (store / f"{OLD}.md").unlink()
    (store / f"{NEW}.md").write_text(OLD_RECORD.replace(OLD, NEW))

    data = client.get(f"/api/ingests/{OLD}/supersession").json()
    assert data["exists"] is True
    assert data["superseded_by"] == NEW
    assert data["public_supersedes"] == NEW[:56]


def test_absent_record_reads_not_exists(client):
    data = client.get(f"/api/ingests/{'c' * 64}/supersession").json()
    assert data == {"exists": False, "superseded_by": None, "public_supersedes": None}


def test_rejects_malformed_hash(client):
    assert client.get("/api/ingests/nothex/supersession").status_code == 404
