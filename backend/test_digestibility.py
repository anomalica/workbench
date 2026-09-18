#!/usr/bin/env python3
"""list_ingests surfaces the digestibility flag, using the shared review_gate.

The pure digestibility rule lives in anomalica_common.review_gate (tested there);
this covers the workbench integration: reading the sidecar, reading the body only
for the legacy recompute path, and exposing digestible + observed_coverage.
"""

import hashlib
import json
import subprocess

import pytest

from backend.server import LocalIngestSource, parse_frontmatter

VERDICT_FULL = "a" * 64
VERDICT_PARTIAL = "b" * 64
LEGACY_TRANSCRIPT = "c" * 64
NO_SIDECAR = "d" * 64


def _record(content_hash: str, body: str) -> str:
    return f"---\nschema: anomalica/record/1\ncontent_hash: {content_hash}\ntitle: T\n---\n{body}"


def _carried_record(content_hash: str, body: str) -> str:
    return (
        f"---\nschema: anomalica/record/1\ncontent_hash: {content_hash}\ntitle: T\n"
        f"review_carryover:\n  at: 2026-01-02T00:00:00Z\n  from: {content_hash}\n"
        f"  had_text_edits: true\n---\n{body}"
    )


def _git(repo, *args: str) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def _commit(repo, message: str, *paths) -> str:
    subprocess.run(["git", "add", *map(str, paths)], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", message], cwd=repo, check=True)
    return _git(repo, "rev-parse", "HEAD")


def _commit_atomic_review(
    repo,
    *,
    parent_commit: str,
    body: str = "Reviewed body.\n",
    reviewed_body_sha256: str | None = None,
) -> str:
    record = repo / "store" / "full.md"
    sidecar_path = repo / "store" / f"{VERDICT_FULL}.review.json"
    record.write_text(_record(VERDICT_FULL, body))
    sidecar = json.loads(sidecar_path.read_text())
    sidecar["reviews"].append(
        {
            "by": "reviewer@example.invalid",
            "at": "2026-01-03T00:00:00Z",
            "spans": [{"from": 0, "to": 0, "kind": "observed"}],
            "parent_commit": parent_commit,
        }
    )
    if reviewed_body_sha256 is not None:
        sidecar["reviewed_body_sha256"] = reviewed_body_sha256
    sidecar_path.write_text(json.dumps(sidecar))
    return _commit(repo, "review edited record", record, sidecar_path)


def _assert_coverage_current(repo) -> None:
    source = LocalIngestSource(repo)
    assert source.load_coverage(VERDICT_FULL) is not None
    detail = source.get_ingest(VERDICT_FULL)
    assert detail is not None
    assert detail["observed_coverage"] == 1.0
    assert detail["digestible"] is True
    summary = next(
        item for item in source.list_ingests() if item["content_hash"] == VERDICT_FULL
    )
    assert summary["observed_coverage"] == 1.0
    assert summary["digestible"] is True


@pytest.fixture
def ingests_repo(tmp_path):
    repo = tmp_path / "ingests"
    store = repo / "store"
    store.mkdir(parents=True)

    (store / "full.md").write_text(_record(VERDICT_FULL, "Body.\n"))
    (store / "partial.md").write_text(_record(VERDICT_PARTIAL, "Body.\n"))
    (store / "legacy.md").write_text(
        _record(LEGACY_TRANSCRIPT, "00:00:01 One.\n00:00:05 Two.\n")
    )
    (store / "none.md").write_text(_record(NO_SIDECAR, "Body.\n"))

    # /1 verdict sidecars: the fraction is authoritative.
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
    subprocess.run(
        ["git", "config", "user.email", "t@example.invalid"], cwd=repo, check=True
    )
    subprocess.run(
        ["git", "config", "core.hooksPath", "/dev/null"], cwd=repo, check=True
    )
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "records"], cwd=repo, check=True)
    parent_commit = _git(repo, "rev-parse", "HEAD")

    (store / f"{VERDICT_FULL}.review.json").write_text(
        json.dumps(
            {
                "schema": "anomalica/review-coverage/1",
                "reviews": [
                    {
                        "by": "x",
                        "spans": [{"from": 5, "to": 5, "kind": "observed"}],
                        "parent_commit": parent_commit,
                    }
                ],
                "observed_coverage": 1.0,
                "digestible": True,
                "total_units": 1,
            }
        )
    )
    (store / f"{VERDICT_PARTIAL}.review.json").write_text(
        json.dumps(
            {
                "schema": "anomalica/review-coverage/1",
                "reviews": [{"by": "x", "spans": [], "parent_commit": parent_commit}],
                "observed_coverage": 0.5,
                "digestible": False,
                "total_units": 2,
            }
        )
    )
    # Legacy /0 sidecar: no verdict, so digestibility recomputes from spans over
    # the transcript's two content lines (1-indexed 6 and 7 in the full record).
    (store / f"{LEGACY_TRANSCRIPT}.review.json").write_text(
        json.dumps(
            {
                "schema": "anomalica/review-coverage/0",
                "reviews": [
                    {
                        "by": "x",
                        "spans": [{"from": 6, "to": 7, "kind": "observed"}],
                        "parent_commit": parent_commit,
                    }
                ],
            }
        )
    )

    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "coverage"], cwd=repo, check=True)
    return repo


def test_list_ingests_exposes_digestibility(ingests_repo):
    by_hash = {
        i["content_hash"]: i for i in LocalIngestSource(ingests_repo).list_ingests()
    }

    # /1 verdict at 100% -> digestible.
    assert by_hash[VERDICT_FULL]["digestible"] is True
    assert by_hash[VERDICT_FULL]["observed_coverage"] == 1.0

    # /1 verdict below threshold -> not digestible, fraction surfaced.
    assert by_hash[VERDICT_PARTIAL]["digestible"] is False
    assert by_hash[VERDICT_PARTIAL]["observed_coverage"] == 0.5

    # Legacy /0 recompute over the body (both transcript lines observed).
    assert by_hash[LEGACY_TRANSCRIPT]["digestible"] is True
    assert by_hash[LEGACY_TRANSCRIPT]["observed_coverage"] == 1.0

    # No sidecar -> unreviewed, not digestible.
    assert by_hash[NO_SIDECAR]["digestible"] is False
    assert by_hash[NO_SIDECAR]["observed_coverage"] == 0.0


def test_changed_body_without_review_carryover_invalidates_prior_review(ingests_repo):
    record = ingests_repo / "store" / "full.md"
    record.write_text(_record(VERDICT_FULL, "Re-extracted body.\n"))
    subprocess.run(["git", "add", str(record)], cwd=ingests_repo, check=True)
    subprocess.run(
        ["git", "commit", "-q", "-m", "refresh record"],
        cwd=ingests_repo,
        check=True,
    )

    source = LocalIngestSource(ingests_repo)
    assert source.load_coverage(VERDICT_FULL) is None

    sidecar_path = ingests_repo / "store" / f"{VERDICT_FULL}.review.json"
    sidecar = json.loads(sidecar_path.read_text())
    sidecar["reviews"][0]["notes"] = "uncommitted sidecar edit"
    sidecar_path.write_text(json.dumps(sidecar))
    assert source.load_coverage(VERDICT_FULL) is None

    detail = source.get_ingest(VERDICT_FULL)
    assert detail is not None
    assert detail["digestible"] is False
    assert detail["observed_coverage"] == 0.0
    summary = next(
        item for item in source.list_ingests() if item["content_hash"] == VERDICT_FULL
    )
    assert summary["digestible"] is False
    assert summary["observed_coverage"] == 0.0
    assert VERDICT_FULL not in source.reviewed_by_email("t@example.invalid")


def test_review_after_carryover_restores_current_coverage(ingests_repo):
    store = ingests_repo / "store"
    record = store / "full.md"
    sidecar_path = store / f"{VERDICT_FULL}.review.json"
    record.write_text(_carried_record(VERDICT_FULL, "Re-extracted body.\n"))
    subprocess.run(["git", "add", str(record)], cwd=ingests_repo, check=True)
    subprocess.run(
        ["git", "commit", "-q", "-m", "refresh record"],
        cwd=ingests_repo,
        check=True,
    )

    source = LocalIngestSource(ingests_repo)
    assert source.load_coverage(VERDICT_FULL) is None

    sidecar = json.loads(sidecar_path.read_text())
    sidecar["reviews"].append(
        {
            "by": "x",
            "at": "2026-01-03T00:00:00Z",
            "spans": [],
            "parent_commit": _git(ingests_repo, "rev-parse", "HEAD"),
        }
    )
    sidecar_path.write_text(json.dumps(sidecar))
    subprocess.run(
        ["git", "add", str(record), str(sidecar_path)], cwd=ingests_repo, check=True
    )
    subprocess.run(
        ["git", "commit", "-q", "-m", "review refreshed record"],
        cwd=ingests_repo,
        check=True,
    )
    assert source.load_coverage(VERDICT_FULL) is not None


def test_body_and_stale_sidecar_changed_together_remain_invalid(ingests_repo):
    store = ingests_repo / "store"
    record = store / "full.md"
    sidecar_path = store / f"{VERDICT_FULL}.review.json"
    reviewed_parent = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=ingests_repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    sidecar = json.loads(sidecar_path.read_text())
    sidecar["reviews"][0]["parent_commit"] = reviewed_parent
    sidecar_path.write_text(json.dumps(sidecar))
    subprocess.run(["git", "add", str(sidecar_path)], cwd=ingests_repo, check=True)
    subprocess.run(
        ["git", "commit", "-q", "-m", "bind review"],
        cwd=ingests_repo,
        check=True,
    )

    record.write_text(_record(VERDICT_FULL, "Re-extracted body.\n"))
    sidecar["reviews"][0]["notes"] = "reformatted during refresh"
    sidecar_path.write_text(json.dumps(sidecar))
    subprocess.run(
        ["git", "add", str(record), str(sidecar_path)], cwd=ingests_repo, check=True
    )
    subprocess.run(
        ["git", "commit", "-q", "-m", "refresh record and metadata"],
        cwd=ingests_repo,
        check=True,
    )

    assert LocalIngestSource(ingests_repo).load_coverage(VERDICT_FULL) is None


def test_atomic_body_and_sidecar_review_uses_the_committed_reviewed_body(ingests_repo):
    parent = _git(ingests_repo, "rev-parse", "HEAD")

    _commit_atomic_review(ingests_repo, parent_commit=parent)

    _assert_coverage_current(ingests_repo)


def test_body_edit_after_atomic_review_invalidates_coverage(ingests_repo):
    parent = _git(ingests_repo, "rev-parse", "HEAD")
    _commit_atomic_review(ingests_repo, parent_commit=parent)
    record = ingests_repo / "store" / "full.md"
    record.write_text(_record(VERDICT_FULL, "Edited after review.\n"))
    _commit(ingests_repo, "edit reviewed body", record)

    assert LocalIngestSource(ingests_repo).load_coverage(VERDICT_FULL) is None


def test_non_parent_parent_commit_cannot_bind_coverage(ingests_repo):
    non_parent = _git(ingests_repo, "rev-parse", "HEAD")
    metadata = ingests_repo / "metadata.txt"
    metadata.write_text("intervening commit\n")
    _commit(ingests_repo, "intervening metadata", metadata)

    _commit_atomic_review(ingests_repo, parent_commit=non_parent)

    assert LocalIngestSource(ingests_repo).load_coverage(VERDICT_FULL) is None


def test_unrelated_branch_parent_commit_cannot_bind_coverage(ingests_repo):
    main_branch = _git(ingests_repo, "branch", "--show-current")
    subprocess.run(
        ["git", "checkout", "-q", "-b", "unrelated"],
        cwd=ingests_repo,
        check=True,
    )
    metadata = ingests_repo / "unrelated.txt"
    metadata.write_text("sibling commit\n")
    unrelated = _commit(ingests_repo, "unrelated branch", metadata)
    subprocess.run(["git", "checkout", "-q", main_branch], cwd=ingests_repo, check=True)

    _commit_atomic_review(ingests_repo, parent_commit=unrelated)

    assert LocalIngestSource(ingests_repo).load_coverage(VERDICT_FULL) is None


def test_dirty_sidecar_cannot_change_current_coverage(ingests_repo):
    parent = _git(ingests_repo, "rev-parse", "HEAD")
    _commit_atomic_review(ingests_repo, parent_commit=parent)
    sidecar_path = ingests_repo / "store" / f"{VERDICT_FULL}.review.json"
    sidecar = json.loads(sidecar_path.read_text())
    sidecar["reviews"][-1]["notes"] = "uncommitted change"
    sidecar_path.write_text(json.dumps(sidecar))

    assert LocalIngestSource(ingests_repo).load_coverage(VERDICT_FULL) is None


def test_atomic_review_accepts_recorded_second_merge_parent(ingests_repo):
    main_branch = _git(ingests_repo, "branch", "--show-current")
    subprocess.run(
        ["git", "checkout", "-q", "-b", "review-parent"],
        cwd=ingests_repo,
        check=True,
    )
    branch_metadata = ingests_repo / "branch.txt"
    branch_metadata.write_text("second parent\n")
    second_parent = _commit(ingests_repo, "second parent", branch_metadata)
    subprocess.run(["git", "checkout", "-q", main_branch], cwd=ingests_repo, check=True)
    main_metadata = ingests_repo / "main.txt"
    main_metadata.write_text("first parent\n")
    _commit(ingests_repo, "first parent", main_metadata)
    subprocess.run(
        ["git", "merge", "--no-ff", "--no-commit", "review-parent"],
        cwd=ingests_repo,
        check=True,
    )

    _commit_atomic_review(ingests_repo, parent_commit=second_parent)

    _assert_coverage_current(ingests_repo)


def test_review_commit_merged_unchanged_remains_current(ingests_repo):
    main_branch = _git(ingests_repo, "branch", "--show-current")
    parent = _git(ingests_repo, "rev-parse", "HEAD")
    subprocess.run(
        ["git", "checkout", "-q", "-b", "review-branch"],
        cwd=ingests_repo,
        check=True,
    )
    review_commit = _commit_atomic_review(ingests_repo, parent_commit=parent)
    subprocess.run(["git", "checkout", "-q", main_branch], cwd=ingests_repo, check=True)
    metadata = ingests_repo / "main-only.txt"
    metadata.write_text("force a merge\n")
    _commit(ingests_repo, "main metadata", metadata)
    subprocess.run(
        ["git", "merge", "-q", "--no-ff", "review-branch", "-m", "merge review"],
        cwd=ingests_repo,
        check=True,
    )

    sidecar_rel = f"store/{VERDICT_FULL}.review.json"
    assert (
        _git(ingests_repo, "log", "-1", "--format=%H", "--", sidecar_rel)
        == review_commit
    )
    _assert_coverage_current(ingests_repo)


def test_metadata_only_commit_keeps_atomic_review_current(ingests_repo):
    parent = _git(ingests_repo, "rev-parse", "HEAD")
    _commit_atomic_review(ingests_repo, parent_commit=parent)
    record = ingests_repo / "store" / "full.md"
    record.write_text(record.read_text().replace("title: T", "title: Renamed"))
    _commit(ingests_repo, "rename record", record)

    _assert_coverage_current(ingests_repo)


def test_record_rename_after_review_preserves_body_binding(ingests_repo):
    parent = _git(ingests_repo, "rev-parse", "HEAD")
    _commit_atomic_review(ingests_repo, parent_commit=parent)
    old_path = ingests_repo / "store" / "full.md"
    new_path = ingests_repo / "store" / "renamed.md"
    old_path.rename(new_path)
    subprocess.run(["git", "add", "-A"], cwd=ingests_repo, check=True)
    subprocess.run(
        ["git", "commit", "-q", "-m", "rename record"],
        cwd=ingests_repo,
        check=True,
    )

    _assert_coverage_current(ingests_repo)


def test_legacy_sidecar_only_later_commit_invalidates_parent_binding(ingests_repo):
    parent = _git(ingests_repo, "rev-parse", "HEAD")
    _commit_atomic_review(ingests_repo, parent_commit=parent)
    sidecar_path = ingests_repo / "store" / f"{VERDICT_FULL}.review.json"
    sidecar = json.loads(sidecar_path.read_text())
    sidecar["reviews"][-1]["notes"] = "committed without a new review"
    sidecar_path.write_text(json.dumps(sidecar))
    _commit(ingests_repo, "edit sidecar only", sidecar_path)

    assert LocalIngestSource(ingests_repo).load_coverage(VERDICT_FULL) is None


def test_deleted_and_readded_legacy_sidecar_does_not_reuse_old_binding(ingests_repo):
    parent = _git(ingests_repo, "rev-parse", "HEAD")
    _commit_atomic_review(ingests_repo, parent_commit=parent)
    sidecar_path = ingests_repo / "store" / f"{VERDICT_FULL}.review.json"
    saved = sidecar_path.read_bytes()
    sidecar_path.unlink()
    subprocess.run(["git", "add", "-A"], cwd=ingests_repo, check=True)
    subprocess.run(
        ["git", "commit", "-q", "-m", "delete sidecar"],
        cwd=ingests_repo,
        check=True,
    )
    sidecar_path.write_bytes(saved)
    _commit(ingests_repo, "re-add sidecar", sidecar_path)

    assert LocalIngestSource(ingests_repo).load_coverage(VERDICT_FULL) is None


@pytest.mark.parametrize("newline", ["\r\n", "\r"])
def test_direct_hash_distinguishes_exact_non_lf_body_bytes(ingests_repo, newline):
    parent = _git(ingests_repo, "rev-parse", "HEAD")
    body = f"Cafe\u0301{newline}Second line.{newline}"
    record_text = (
        f"---{newline}schema: anomalica/record/1{newline}"
        f"content_hash: {VERDICT_FULL}{newline}title: T{newline}---{newline}{body}"
    )
    record = ingests_repo / "store" / "full.md"
    sidecar_path = ingests_repo / "store" / f"{VERDICT_FULL}.review.json"
    record.write_bytes(record_text.encode("utf-8"))
    sidecar = json.loads(sidecar_path.read_text())
    sidecar["reviews"].append(
        {
            "by": "reviewer@example.invalid",
            "at": "2026-01-03T00:00:00Z",
            "spans": [],
            "parent_commit": parent,
        }
    )
    exact_body = parse_frontmatter(record_text)[1]
    sidecar["reviewed_body_sha256"] = (
        "sha256:" + hashlib.sha256(exact_body.encode("utf-8")).hexdigest()
    )
    sidecar_path.write_text(json.dumps(sidecar))
    _commit(ingests_repo, "review non-LF body", record, sidecar_path)

    _assert_coverage_current(ingests_repo)


def test_reviewed_body_sha256_is_the_primary_currentness_binding(ingests_repo):
    body = "Directly bound body.\n"
    _commit_atomic_review(
        ingests_repo,
        parent_commit="f" * 40,
        body=body,
        reviewed_body_sha256=(
            "sha256:" + hashlib.sha256(body.encode("utf-8")).hexdigest()
        ),
    )

    _assert_coverage_current(ingests_repo)


@pytest.mark.parametrize(
    "reviewed_body_sha256",
    ["not-a-hash", "sha256:" + "0" * 64],
)
def test_present_invalid_body_hash_does_not_use_valid_legacy_fallback(
    ingests_repo, reviewed_body_sha256
):
    parent = _git(ingests_repo, "rev-parse", "HEAD")
    _commit_atomic_review(
        ingests_repo,
        parent_commit=parent,
        reviewed_body_sha256=reviewed_body_sha256,
    )

    assert LocalIngestSource(ingests_repo).load_coverage(VERDICT_FULL) is None
