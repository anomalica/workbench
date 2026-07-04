#!/usr/bin/env python3
"""Tests for the commit-only sync model: the workbench commits, the
operations auto-push watcher is the single pusher, and this code only
OBSERVES (fetch, fast-forward when purely behind, report divergence).
It must never rebase - two processes rebasing one clone corrupted
FETCH_HEAD ("cannot rebase onto multiple branches")."""

import subprocess

import pytest

from backend.server import LocalIngestSource
from backend.sync import SyncManager

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


def advance_origin(origin, name: str) -> None:
    other = origin.parent / f"advance-{name}"
    subprocess.run(["git", "clone", "-q", str(origin), str(other)], check=True)
    _git(other, "config", "user.name", "Edge")
    _git(other, "config", "user.email", "edge@example.invalid")
    (other / f"{name}.md").write_text("from origin\n")
    _git(other, "add", "-A")
    _git(other, "commit", "-q", "-m", f"review: origin advance {name}")
    _git(other, "push", "-q", "origin", "main")


def test_commit_review_is_commit_only(repos):
    """The review commit lands locally and origin is untouched - pushing
    belongs to the auto-push watcher, never this process."""
    origin, local = repos
    src = LocalIngestSource(local)
    src.save_ingest(CONTENT_HASH, RECORD.replace("Line one.", "Line edited."))
    src.commit_review(
        full_hash=CONTENT_HASH,
        author_name="Reviewer",
        author_email="reviewer@example.invalid",
        notes="",
    )
    local_subject = subprocess.run(
        ["git", "log", "-1", "--format=%s"],
        cwd=local,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert local_subject == "review: Sync Record"
    assert origin_head_subject(origin) == "initial"


def test_sync_once_fast_forwards_when_purely_behind(repos):
    origin, local = repos
    advance_origin(origin, "ff")
    mgr = SyncManager(local)
    status = mgr.sync_once()
    assert status["behind"] == 0
    assert status["ahead"] == 0
    assert not status["offline"]
    assert (local / "ff.md").exists()


def test_sync_once_never_pulls_over_dirty_tree(repos):
    origin, local = repos
    advance_origin(origin, "dirty")
    (local / "store" / f"{CONTENT_HASH}.md").write_text(
        RECORD.replace("Line one.", "Mid-edit.")
    )
    mgr = SyncManager(local)
    status = mgr.sync_once()
    assert status["dirty"] is True
    assert status["behind"] == 1  # fetched, but never pulled over the dirt
    assert "Mid-edit." in (local / "store" / f"{CONTENT_HASH}.md").read_text()


def test_untracked_files_never_pause_sync(repos):
    """The scheduler intake writes an untracked incoming/ dir into the
    ingests clone - untracked files must not read as dirty or block pulls."""
    origin, local = repos
    (local / "incoming").mkdir()
    (local / "incoming" / "queued-source.bin").write_text("raw bytes")
    advance_origin(origin, "untracked")
    mgr = SyncManager(local)
    status = mgr.sync_once()
    assert status["dirty"] is False
    assert status["behind"] == 0
    assert (local / "incoming" / "queued-source.bin").exists()


def test_sync_once_reports_offline(repos, tmp_path):
    origin, local = repos
    _git(local, "remote", "set-url", "origin", str(tmp_path / "gone.git"))
    mgr = SyncManager(local)
    status = mgr.sync_once()
    assert status["offline"] is True
    assert status["last_error"]


def test_sync_once_never_pushes_ahead_commits(repos):
    """Origin writes belong to the watcher alone - purely-ahead commits
    are reported, not pushed (the watcher's safety-net timer flushes
    offline commits once connectivity returns)."""
    origin, local = repos
    (local / "store" / f"{CONTENT_HASH}.md").write_text(
        RECORD.replace("Line one.", "Offline review.")
    )
    _git(local, "add", "-A")
    _git(local, "commit", "-q", "-m", "review: made while offline")
    mgr = SyncManager(local)
    status = mgr.sync_once()
    assert status["ahead"] == 1
    assert origin_head_subject(origin) == "initial"


def test_sync_once_leaves_divergence_to_the_watcher(repos):
    """Ahead AND behind: no pull, no push, no rebase - just honest counts.
    The watcher integrates on its next push."""
    origin, local = repos
    (local / "store" / f"{CONTENT_HASH}.md").write_text(
        RECORD.replace("Line one.", "Local edit.")
    )
    _git(local, "add", "-A")
    _git(local, "commit", "-q", "-m", "review: local")
    advance_origin(origin, "diverge")

    mgr = SyncManager(local)
    status = mgr.sync_once()
    assert status["ahead"] == 1
    assert status["behind"] == 1
    # Origin untouched by us; local history not rewritten.
    assert origin_head_subject(origin) == "review: origin advance diverge"
    local_subject = subprocess.run(
        ["git", "log", "-1", "--format=%s"],
        cwd=local,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert local_subject == "review: local"


def test_wait_for_push_confirms_when_watcher_lands_it(repos):
    origin, local = repos
    mgr = SyncManager(local)
    # Nothing ahead: confirmed immediately.
    synced, detail = mgr.wait_for_push(timeout_seconds=0.5)
    assert synced, detail

    # Ahead with no watcher: times out with an honest message.
    (local / "store" / f"{CONTENT_HASH}.md").write_text(
        RECORD.replace("Line one.", "Waiting.")
    )
    _git(local, "add", "-A")
    _git(local, "commit", "-q", "-m", "review: waiting")
    synced, detail = mgr.wait_for_push(timeout_seconds=1.0)
    assert not synced
    assert "auto-push watcher" in detail

    # The "watcher" pushes (simulated); the next wait confirms without
    # this process ever pushing.
    _git(local, "push", "-q", "origin", "HEAD")
    synced, detail = mgr.wait_for_push(timeout_seconds=0.5)
    assert synced, detail
