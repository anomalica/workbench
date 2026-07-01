#!/usr/bin/env python3
"""list_ingests's sibling endpoint, review_history, surfaces reviewer notes.

The commit subject alone ("review: <title>") doesn't tell a reviewer where
they left off; the notes they typed ("Reviewed up to 20%") live in the commit
body and must be surfaced too, with the Reviewed-Record: identity trailers
(review-workbench.md) stripped since those aren't for humans.
"""

import subprocess

import pytest

from backend.server import LocalIngestSource

HASH = "a" * 64


def _git(repo, *args):
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path):
    repo_dir = tmp_path / "ingests"
    store = repo_dir / "store"
    store.mkdir(parents=True)
    _git(repo_dir, "init", "-q", "-b", "main")
    _git(repo_dir, "config", "user.email", "test@example.com")
    _git(repo_dir, "config", "user.name", "Test")
    _git(repo_dir, "config", "commit.gpgsign", "false")

    record = store / f"{HASH}.md"
    record.write_text(f"---\ncontent_hash: {HASH}\ntitle: T\n---\nBody.\n")
    _git(repo_dir, "add", "store")
    _git(repo_dir, "commit", "-q", "-m", "feat: add 1 record(s) from audio ingestion")

    record.write_text(f"---\ncontent_hash: {HASH}\ntitle: T\n---\nBody edited.\n")
    _git(repo_dir, "add", "store")
    message = (
        "review: T\n\n"
        "Reviewed up to 20%\n\n"
        "Reviewed-Record: url:https://example.com/video\n"
        f"Reviewed-Record: content:{HASH}"
    )
    _git(repo_dir, "commit", "-q", "-m", message)
    return repo_dir


def test_summary_includes_notes_and_strips_trailers(repo):
    history = LocalIngestSource(repo).review_history(HASH)
    assert history[0]["summary"] == "review: T - Reviewed up to 20%"
    assert "Reviewed-Record" not in history[0]["summary"]


def test_summary_falls_back_to_subject_when_no_notes(repo):
    history = LocalIngestSource(repo).review_history(HASH)
    assert history[1]["summary"] == "feat: add 1 record(s) from audio ingestion"


def test_newest_first(repo):
    history = LocalIngestSource(repo).review_history(HASH)
    assert [h["summary"] for h in history] == [
        "review: T - Reviewed up to 20%",
        "feat: add 1 record(s) from audio ingestion",
    ]


def test_no_email_in_result(repo):
    history = LocalIngestSource(repo).review_history(HASH)
    assert all("email" not in h and "test@example.com" not in str(h) for h in history)


def test_multiline_notes_preserved(tmp_path):
    repo_dir = tmp_path / "ingests"
    store = repo_dir / "store"
    store.mkdir(parents=True)
    _git(repo_dir, "init", "-q", "-b", "main")
    _git(repo_dir, "config", "user.email", "test@example.com")
    _git(repo_dir, "config", "user.name", "Test")
    _git(repo_dir, "config", "commit.gpgsign", "false")
    record = store / f"{HASH}.md"
    record.write_text(f"---\ncontent_hash: {HASH}\ntitle: T\n---\nBody.\n")
    _git(repo_dir, "add", "store")
    message = (
        "review: T\n\n"
        "Line one of notes.\nLine two of notes.\n\n"
        f"Reviewed-Record: content:{HASH}"
    )
    _git(repo_dir, "commit", "-q", "-m", message)
    history = LocalIngestSource(repo_dir).review_history(HASH)
    assert history[0]["summary"] == "review: T - Line one of notes.\nLine two of notes."


def test_unknown_hash_returns_empty(repo):
    assert LocalIngestSource(repo).review_history("f" * 64) == []
