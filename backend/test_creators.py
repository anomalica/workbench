#!/usr/bin/env python3
"""The API exposes the spec field `creators`, falling back to legacy `authors`."""

import subprocess

import pytest

from backend.server import LocalIngestSource

CREATORS_HASH = "c" * 64
AUTHORS_HASH = "a" * 64

CREATORS_RECORD = f"""---
schema: anomalica/record/1
content_hash: {CREATORS_HASH}
title: Has Creators
publisher: The Debrief
creators:
  - "Ramsey, Chris"
  - "Doe, Jane"
---
Body.
"""

# A record that predates the rename still carries `authors:`.
AUTHORS_RECORD = f"""---
schema: anomalica/record/1
content_hash: {AUTHORS_HASH}
title: Has Legacy Authors
authors:
  - "Old, Author"
---
Body.
"""


@pytest.fixture
def ingests_repo(tmp_path):
    repo = tmp_path / "ingests"
    store = repo / "store"
    store.mkdir(parents=True)
    (store / "creators.md").write_text(CREATORS_RECORD)
    (store / "authors.md").write_text(AUTHORS_RECORD)
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.invalid"], cwd=repo, check=True
    )
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "initial"], cwd=repo, check=True)
    return repo


def test_list_ingests_exposes_creators(ingests_repo):
    by_hash = {
        i["content_hash"]: i for i in LocalIngestSource(ingests_repo).list_ingests()
    }
    assert by_hash[CREATORS_HASH]["creators"] == ["Ramsey, Chris", "Doe, Jane"]
    assert "authors" not in by_hash[CREATORS_HASH]


def test_list_ingests_falls_back_to_authors(ingests_repo):
    by_hash = {
        i["content_hash"]: i for i in LocalIngestSource(ingests_repo).list_ingests()
    }
    assert by_hash[AUTHORS_HASH]["creators"] == ["Old, Author"]


def test_get_ingest_exposes_creators_and_strips_keys(ingests_repo):
    detail = LocalIngestSource(ingests_repo).get_ingest(CREATORS_HASH)
    assert detail["creators"] == ["Ramsey, Chris", "Doe, Jane"]
    # Neither key should remain in the generic frontmatter panel.
    assert "creators" not in detail["frontmatter"]
    assert "authors" not in detail["frontmatter"]


def test_get_ingest_falls_back_to_authors(ingests_repo):
    detail = LocalIngestSource(ingests_repo).get_ingest(AUTHORS_HASH)
    assert detail["creators"] == ["Old, Author"]
    assert "authors" not in detail["frontmatter"]
