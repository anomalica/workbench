#!/usr/bin/env python3
"""Tests for pushing local review commits to origin (the sync half that
keeps localhost work from silently drifting away from the live site)."""

import subprocess

import pytest

from backend.server import LocalIngestSource

CONTENT_HASH = "e" * 64

RECORD = f"""---
schema: anomalica/record/1
content_hash: {CONTENT_HASH}
title: Sync Record
---
Line one.
"""


def _git(repo, *args, **kwargs):
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True, **kwargs
    )


@pytest.fixture
def repos(tmp_path):
    """A local ingests clone tracking a bare origin."""
    origin = tmp_path / "origin.git"
    subprocess.run(
        ["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True
    )

    seed = tmp_path / "seed"
    seed.mkdir()
    _git(seed, "init", "-q", "-b", "main")
    _git(seed, "config", "user.name", "Test")
    _git(seed, "config", "user.email", "test@example.invalid")
    (seed / "store").mkdir()
    (seed / "store" / f"{CONTENT_HASH}.md").write_text(RECORD)
    _git(seed, "add", "-A")
    _git(seed, "commit", "-q", "-m", "initial")
    _git(seed, "push", "-q", str(origin), "main")

    local = tmp_path / "ingests"
    subprocess.run(["git", "clone", "-q", str(origin), str(local)], check=True)
    _git(local, "config", "user.name", "Local")
    _git(local, "config", "user.email", "local@example.invalid")
    return origin, local


def origin_head_subject(origin) -> str:
    return subprocess.run(
        ["git", "log", "-1", "--format=%s", "main"],
        cwd=origin,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def test_commit_review_pushes_to_origin(repos):
    origin, local = repos
    src = LocalIngestSource(local)
    src.save_ingest(CONTENT_HASH, RECORD.replace("Line one.", "Line edited."))
    synced, detail = src.commit_review(
        full_hash=CONTENT_HASH,
        author_name="Reviewer",
        author_email="reviewer@example.invalid",
        notes="",
    )
    assert synced, detail
    assert origin_head_subject(origin) == "review: Sync Record"


def test_push_rebases_when_origin_advanced(repos):
    origin, local = repos
    # Origin advances independently (an edge review from the live site).
    other = origin.parent / "other"
    subprocess.run(["git", "clone", "-q", str(origin), str(other)], check=True)
    _git(other, "config", "user.name", "Edge")
    _git(other, "config", "user.email", "edge@example.invalid")
    (other / "elsewhere.md").write_text("edge write\n")
    _git(other, "add", "-A")
    _git(other, "commit", "-q", "-m", "review: from the edge")
    _git(other, "push", "-q", "origin", "main")

    src = LocalIngestSource(local)
    src.save_ingest(CONTENT_HASH, RECORD.replace("Line one.", "Local edit."))
    synced, detail = src.commit_review(
        full_hash=CONTENT_HASH,
        author_name="Reviewer",
        author_email="reviewer@example.invalid",
        notes="",
    )
    assert synced, detail
    # Both commits are on origin: the local one rebased on top of the edge one.
    log = subprocess.run(
        ["git", "log", "--format=%s", "main"],
        cwd=origin,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.splitlines()
    assert log[0] == "review: Sync Record"
    assert "review: from the edge" in log


def test_sync_once_pulls_when_behind_and_clean(repos):
    origin, local = repos
    other = origin.parent / "advance"
    subprocess.run(["git", "clone", "-q", str(origin), str(other)], check=True)
    _git(other, "config", "user.name", "Edge")
    _git(other, "config", "user.email", "edge@example.invalid")
    (other / "new.md").write_text("from origin\n")
    _git(other, "add", "-A")
    _git(other, "commit", "-q", "-m", "review: origin advance")
    _git(other, "push", "-q", "origin", "main")

    from backend.sync import SyncManager

    mgr = SyncManager(local)
    status = mgr.sync_once()
    assert status["behind"] == 0
    assert status["ahead"] == 0
    assert not status["offline"]
    assert (local / "new.md").exists()


def test_sync_once_never_pulls_over_dirty_tree(repos):
    origin, local = repos
    other = origin.parent / "advance2"
    subprocess.run(["git", "clone", "-q", str(origin), str(other)], check=True)
    _git(other, "config", "user.name", "Edge")
    _git(other, "config", "user.email", "edge@example.invalid")
    (other / "new.md").write_text("from origin\n")
    _git(other, "add", "-A")
    _git(other, "commit", "-q", "-m", "review: origin advance")
    _git(other, "push", "-q", "origin", "main")

    # Local tracked modification (a review being edited right now).
    (local / "store" / f"{CONTENT_HASH}.md").write_text(
        RECORD.replace("Line one.", "Mid-edit.")
    )

    from backend.sync import SyncManager

    mgr = SyncManager(local)
    status = mgr.sync_once()
    assert status["dirty"] is True
    assert status["behind"] == 1  # fetched, but never pulled over the dirt
    content = (local / "store" / f"{CONTENT_HASH}.md").read_text()
    assert "Mid-edit." in content  # the edit is untouched


def test_untracked_files_never_pause_sync(repos):
    """The scheduler intake writes an untracked incoming/ dir into the
    ingests clone - untracked files must not read as dirty or block pulls."""
    origin, local = repos
    (local / "incoming").mkdir()
    (local / "incoming" / "queued-source.bin").write_text("raw bytes")

    other = origin.parent / "advance3"
    subprocess.run(["git", "clone", "-q", str(origin), str(other)], check=True)
    _git(other, "config", "user.name", "Edge")
    _git(other, "config", "user.email", "edge@example.invalid")
    (other / "new.md").write_text("from origin\n")
    _git(other, "add", "-A")
    _git(other, "commit", "-q", "-m", "review: origin advance")
    _git(other, "push", "-q", "origin", "main")

    from backend.sync import SyncManager

    mgr = SyncManager(local)
    status = mgr.sync_once()
    assert status["dirty"] is False
    assert status["behind"] == 0  # pulled despite the untracked files
    assert (local / "incoming" / "queued-source.bin").exists()


def test_sync_once_reports_offline(repos, tmp_path):
    origin, local = repos
    _git(local, "remote", "set-url", "origin", str(tmp_path / "gone.git"))

    from backend.sync import SyncManager

    mgr = SyncManager(local)
    status = mgr.sync_once()
    assert status["offline"] is True
    assert status["last_error"]


def test_sync_once_pushes_ahead_commits(repos):
    origin, local = repos
    (local / "store" / f"{CONTENT_HASH}.md").write_text(
        RECORD.replace("Line one.", "Offline review.")
    )
    _git(local, "add", "-A")
    _git(local, "commit", "-q", "-m", "review: made while offline")

    from backend.sync import SyncManager

    mgr = SyncManager(local)
    status = mgr.sync_once()
    assert status["ahead"] == 0
    assert origin_head_subject(origin) == "review: made while offline"


def test_push_failure_is_reported_not_silent(repos, tmp_path):
    origin, local = repos
    # Point origin at a URL that cannot exist so the push fails.
    _git(local, "remote", "set-url", "origin", str(tmp_path / "gone.git"))
    src = LocalIngestSource(local)
    src.save_ingest(CONTENT_HASH, RECORD.replace("Line one.", "Offline edit."))
    synced, detail = src.commit_review(
        full_hash=CONTENT_HASH,
        author_name="Reviewer",
        author_email="reviewer@example.invalid",
        notes="",
    )
    assert not synced
    assert detail  # a reason is surfaced
    # The review commit itself is safe locally.
    subject = subprocess.run(
        ["git", "log", "-1", "--format=%s"],
        cwd=local,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert subject == "review: Sync Record"
