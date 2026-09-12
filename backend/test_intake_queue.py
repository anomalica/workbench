from pathlib import Path
import subprocess

from backend.server import LocalIngestSource


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)


def _stub(
    title: str,
    source_id: str,
    source_url: str,
    extra: str = "",
) -> str:
    return (
        "---\n"
        f"intake_date: '2026-09-12T12:00:00Z'\n"
        f"source_id: {source_id}\n"
        "source_type: video\n"
        f"source_url: {source_url}\n"
        f"title: {title}\n"
        f"{extra}"
        "---\n"
    )


def _record(content_hash: str, source_id: str, source_url: str) -> str:
    return (
        "---\n"
        f"content_hash: sha256:{content_hash}\n"
        f"source_id: {source_id}\n"
        "source_type: video\n"
        f"source_url: {source_url}\n"
        "title: Live record\n"
        "---\n"
        "Body.\n"
    )


def _repo(tmp_path: Path) -> Path:
    repo = tmp_path / "ingests"
    (repo / "queue").mkdir(parents=True)
    (repo / "store").mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.name", "Test")
    _git(repo, "config", "user.email", "test@example.invalid")
    return repo


def test_queue_projects_only_valid_untracked_pending_stubs(tmp_path):
    repo = _repo(tmp_path)
    queue = repo / "queue"
    (queue / "legacy.md").write_text(
        _stub("Tracked legacy", "youtube:AAAAAAAAAAA", "https://youtu.be/AAAAAAAAAAA")
    )
    _git(repo, "add", "queue/legacy.md")
    _git(repo, "commit", "-q", "-m", "legacy")
    (queue / "pending.md").write_text(
        _stub("Pending", "youtube:BBBBBBBBBBB", "https://youtu.be/BBBBBBBBBBB")
    )
    (queue / "completed.md").write_text(
        _stub(
            "Completed",
            "youtube:CCCCCCCCCCC",
            "https://youtu.be/CCCCCCCCCCC",
            "ingested_at: '2026-09-12T13:00:00Z'\n",
        )
    )

    result = LocalIngestSource(repo).intake_queue()

    assert result == {
        "pending": [
            {
                "path": "queue/pending.md",
                "title": "Pending",
                "source_id": "youtube:BBBBBBBBBBB",
            }
        ],
        "errors": [],
    }


def test_queue_excludes_an_unambiguous_live_source_duplicate(tmp_path):
    repo = _repo(tmp_path)
    source_url = "https://www.youtube.com/watch?v=DDDDDDDDDDD"
    (repo / "store" / f"{'a' * 64}.md").write_text(
        _record("a" * 64, "youtube:DDDDDDDDDDD", source_url)
    )
    (repo / "queue" / "duplicate.md").write_text(
        _stub("Already live", "youtube:DDDDDDDDDDD", source_url + "&t=90s")
    )

    assert LocalIngestSource(repo).intake_queue() == {"pending": [], "errors": []}


def test_queue_reports_duplicate_transient_candidates(tmp_path):
    repo = _repo(tmp_path)
    for name in ("one", "two"):
        (repo / "queue" / f"{name}.md").write_text(
            _stub(name.title(), "youtube:EEEEEEEEEEE", "https://youtu.be/EEEEEEEEEEE")
        )

    result = LocalIngestSource(repo).intake_queue()

    assert result["pending"] == []
    assert [item["path"] for item in result["errors"]] == [
        "queue/one.md",
        "queue/two.md",
    ]
    assert all("Duplicate transient" in item["reason"] for item in result["errors"])


def test_queue_reports_an_ambiguous_live_source_match(tmp_path):
    repo = _repo(tmp_path)
    source_url = "https://youtu.be/FFFFFFFFFFF"
    for content_hash in ("a" * 64, "b" * 64):
        (repo / "store" / f"{content_hash}.md").write_text(
            _record(content_hash, "youtube:FFFFFFFFFFF", source_url)
        )
    (repo / "queue" / "ambiguous.md").write_text(
        _stub("Ambiguous", "youtube:FFFFFFFFFFF", source_url)
    )

    result = LocalIngestSource(repo).intake_queue()

    assert result["pending"] == []
    assert result["errors"][0]["path"] == "queue/ambiguous.md"
    assert "ambiguously matches" in result["errors"][0]["reason"]
