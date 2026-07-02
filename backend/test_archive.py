#!/usr/bin/env python3
"""Tests for archiving records to store/v1/ (and restoring them).

Regression focus: the archive commit must stage BOTH sides of the move.
Staging only the destination left the source tracked in git and its
deletion dangling unstaged in the work tree (seen on the live ingests
clone: five records present in both store/ and store/v1/ at HEAD).
"""

import subprocess

import pytest

from backend.server import LocalIngestSource

CONTENT_HASH = "c" * 64

RECORD = f"""---
schema: anomalica/record/1
content_hash: {CONTENT_HASH}
title: Archive Me
date_published: 2020-01-01
source_type: web
---
Body text.
"""

USER = {"name": "Reviewer", "email": "reviewer@example.invalid"}


def _git(repo, *args, **kwargs):
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True, **kwargs
    )


@pytest.fixture
def ingests_repo(tmp_path):
    repo = tmp_path / "ingests"
    store = repo / "store"
    records = repo / "records"
    store.mkdir(parents=True)
    records.mkdir()
    (store / f"{CONTENT_HASH}.md").write_text(RECORD)
    (records / "2020-01-01-web-archive-me.md").symlink_to(f"../store/{CONTENT_HASH}.md")
    _git(repo, "init", "-q")
    _git(repo, "config", "user.name", "Test")
    _git(repo, "config", "user.email", "test@example.invalid")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "initial")
    return repo


def test_archive_stages_both_sides_of_the_move(ingests_repo):
    src = LocalIngestSource(ingests_repo)
    assert src.archive_ingest(CONTENT_HASH, USER)

    status = _git(ingests_repo, "status", "--porcelain").stdout
    assert status == "", f"work tree not clean after archive:\n{status}"

    tracked = _git(ingests_repo, "ls-files").stdout.splitlines()
    assert f"store/v1/{CONTENT_HASH}.md" in tracked
    assert f"store/{CONTENT_HASH}.md" not in tracked
    assert "records/2020-01-01-web-archive-me.md" not in tracked


def test_unarchive_stages_both_sides_of_the_move(ingests_repo):
    src = LocalIngestSource(ingests_repo)
    assert src.archive_ingest(CONTENT_HASH, USER)
    assert src.unarchive_ingest(CONTENT_HASH, USER)

    status = _git(ingests_repo, "status", "--porcelain").stdout
    assert status == "", f"work tree not clean after unarchive:\n{status}"

    tracked = _git(ingests_repo, "ls-files").stdout.splitlines()
    assert f"store/{CONTENT_HASH}.md" in tracked
    assert f"store/v1/{CONTENT_HASH}.md" not in tracked
    assert "records/2020-01-01-web-archive-me.md" in tracked


def test_archive_round_trip_keeps_record_listed(ingests_repo):
    src = LocalIngestSource(ingests_repo)
    src.archive_ingest(CONTENT_HASH, USER)
    assert [i["content_hash"] for i in src.list_archived_ingests()] == [CONTENT_HASH]
    assert src.list_ingests() == []

    src.unarchive_ingest(CONTENT_HASH, USER)
    assert src.list_archived_ingests() == []
    assert [i["content_hash"] for i in src.list_ingests()] == [CONTENT_HASH]
