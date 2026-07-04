#!/usr/bin/env python3
"""Tests for the pre-digest inspection endpoint (ADR 0042)."""

import hashlib
import json
import subprocess

import pytest
from fastapi.testclient import TestClient

import backend.server as server
from backend.server import LocalIngestSource

CONTENT_HASH = "f" * 64

RECORD = f"""---
schema: anomalica/record/1
content_hash: {CONTENT_HASH}
title: Predigest Record
---
Body text.
"""

PREDIGEST_BODY = "# Clean model input\n\nIrrelevant stripped, footnotes inlined.\n"
PREDIGEST_SHA = hashlib.sha256(PREDIGEST_BODY.encode()).hexdigest()

REGISTRY = """
prompts:
  nodes:
    active: v2
    versions:
      v2: {file: nodes.txt}
      v1: {file: archive/nodes-v1.txt}
  claims:
    active: v2
    versions:
      v2: {file: claims.txt}
  extraction:
    active: null
    versions:
      v1: {file: archive/extraction.txt}
  evil:
    active: v1
    versions:
      v1: {file: ../../../etc/passwd}
"""


@pytest.fixture
def ingests_repo(tmp_path):
    repo = tmp_path / "ingests"
    store = repo / "store"
    store.mkdir(parents=True)
    (store / f"{CONTENT_HASH}.md").write_text(RECORD)
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    return repo


@pytest.fixture
def digester_repo(tmp_path):
    repo = tmp_path / "digester"
    (repo / "predigests" / "by-record").mkdir(parents=True)
    (repo / "predigests" / f"{PREDIGEST_SHA}.md").write_text(PREDIGEST_BODY)
    prompts = repo / "workspace" / "digester" / "prompts"
    prompts.mkdir(parents=True)
    (prompts / "registry.yaml").write_text(REGISTRY)
    (prompts / "nodes.txt").write_text("Nodes pass prompt.")
    (prompts / "claims.txt").write_text("Claims pass prompt.")
    return repo


@pytest.fixture
def client(ingests_repo, digester_repo, monkeypatch):
    monkeypatch.setattr(server, "source", LocalIngestSource(ingests_repo))
    monkeypatch.setattr(server, "predigests_path", digester_repo / "predigests")
    monkeypatch.setattr(
        server, "prompts_path", digester_repo / "workspace" / "digester" / "prompts"
    )
    return TestClient(server.app)


def write_pointer(digester_repo, extra: dict | None = None) -> None:
    pointer = {
        "predigest_sha256": PREDIGEST_SHA,
        "prep_version": 1,
        "generated_at": "2026-07-04T06:00:00Z",
        **(extra or {}),
    }
    (digester_repo / "predigests" / "by-record" / f"{CONTENT_HASH}.json").write_text(
        json.dumps(pointer)
    )


def test_predigest_unavailable_without_pointer(client):
    res = client.get(f"/api/ingests/{CONTENT_HASH}/predigest")
    assert res.status_code == 200
    assert res.json() == {"available": False}


def test_predigest_serves_body_and_active_prompt_pair(client, digester_repo):
    write_pointer(digester_repo)
    data = client.get(f"/api/ingests/{CONTENT_HASH}/predigest").json()
    assert data["available"] is True
    assert data["body"] == PREDIGEST_BODY
    assert data["predigest_sha256"] == PREDIGEST_SHA
    assert data["prep_version"] == 1
    by_name = {p["name"]: p for p in data["prompts"]}
    # The two active passes, in registry order; retired ids skipped and the
    # repo-escaping path dropped.
    assert set(by_name) == {"nodes", "claims"}
    assert by_name["nodes"] == {
        "name": "nodes",
        "version": "v2",
        "text": "Nodes pass prompt.",
    }
    assert by_name["claims"]["text"] == "Claims pass prompt."


def test_predigest_missing_body_reads_unavailable(client, digester_repo):
    write_pointer(digester_repo, {"predigest_sha256": "a" * 64})
    data = client.get(f"/api/ingests/{CONTENT_HASH}/predigest").json()
    assert data == {"available": False}


def test_predigest_survives_missing_prompt_registry(client, digester_repo, monkeypatch):
    write_pointer(digester_repo)
    monkeypatch.setattr(server, "prompts_path", digester_repo / "nowhere")
    data = client.get(f"/api/ingests/{CONTENT_HASH}/predigest").json()
    assert data["available"] is True
    assert data["prompts"] == []
