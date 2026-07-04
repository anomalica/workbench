#!/usr/bin/env python3
"""Tests for the live pre-digest endpoint (ADR 0042)."""

import json
import subprocess

import pytest
from fastapi.testclient import TestClient

from anomalica_common.pre_digest import PREP_VERSION, materialise, pre_digest_hash

import backend.server as server
from backend.server import LocalIngestSource

CONTENT_HASH = "f" * 64

BODY = """
Keep this paragraph.

<!-- irrelevant: start -->

Publisher cross-sell advert.

<!-- irrelevant: end -->

Also keep this. {{t:12.00}}word
"""

RECORD = f"""---
schema: anomalica/record/1
content_hash: {CONTENT_HASH}
title: Predigest Record
---{BODY}"""

REGISTRY = """
prompts:
  nodes:
    active: v2
    versions:
      v2: {file: nodes.txt}
  claims:
    active: v2
    versions:
      v2: {file: claims.txt}
  retired:
    active: null
    versions:
      v1: {file: archive/old.txt}
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


def test_live_predigest_from_stored_body(client):
    data = client.post(f"/api/ingests/{CONTENT_HASH}/predigest", json={}).json()
    assert data["available"] is True
    assert "Keep this paragraph." in data["body"]
    assert "cross-sell" not in data["body"]  # irrelevant region stripped
    assert "{{t:" not in data["body"]  # word timestamps stripped
    assert data["prep_version"] == PREP_VERSION
    assert data["predigest_sha256"] == pre_digest_hash(data["body"])
    # No stored artefact yet - live preview still works, no comparison.
    assert data["stored"] is None
    assert data["stored_matches"] is None
    by_name = {p["name"]: p for p in data["prompts"]}
    assert set(by_name) == {"nodes", "claims"}  # retired + escaping ids dropped
    assert by_name["nodes"]["version"] == "v2"


def test_live_predigest_from_posted_working_body(client):
    working = "Only this line.\n\n<!-- irrelevant: start -->\n\nGone.\n\n<!-- irrelevant: end -->"
    data = client.post(
        f"/api/ingests/{CONTENT_HASH}/predigest", json={"body": working}
    ).json()
    assert "Only this line." in data["body"]
    assert "Gone." not in data["body"]


def test_live_predigest_reports_stored_match_and_divergence(client, digester_repo):
    # The body as parse_frontmatter serves it: the fence consumes its
    # trailing newline, so the body starts right after it.
    live = materialise(BODY[1:])
    pointer = digester_repo / "predigests" / "by-record" / f"{CONTENT_HASH}.json"
    pointer.write_text(
        json.dumps(
            {
                "predigest_sha256": pre_digest_hash(live),
                "prep_version": PREP_VERSION,
                "generated_at": "2026-07-04T06:00:00Z",
            }
        )
    )
    data = client.post(f"/api/ingests/{CONTENT_HASH}/predigest", json={}).json()
    assert data["stored_matches"] is True

    diverged = client.post(
        f"/api/ingests/{CONTENT_HASH}/predigest", json={"body": "Different body."}
    ).json()
    assert diverged["stored_matches"] is False


def test_live_predigest_rejects_non_string_body(client):
    res = client.post(f"/api/ingests/{CONTENT_HASH}/predigest", json={"body": 42})
    assert res.status_code == 400
