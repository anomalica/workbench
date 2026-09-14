#!/usr/bin/env python3
"""list_ingests surfaces the digestibility flag, using the shared review_gate.

The pure digestibility rule lives in anomalica_common.review_gate (tested there);
this covers the workbench integration: reading the sidecar, reading the body only
for the legacy recompute path, and exposing digestible + observed_coverage.
"""

import json
import subprocess

import pytest

from backend.server import LocalIngestSource

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
    (store / f"{VERDICT_FULL}.review.json").write_text(
        json.dumps(
            {
                "schema": "anomalica/review-coverage/1",
                "reviews": [
                    {"by": "x", "spans": [{"from": 5, "to": 5, "kind": "observed"}]}
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
                "reviews": [{"by": "x", "spans": []}],
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
                    {"by": "x", "spans": [{"from": 6, "to": 7, "kind": "observed"}]}
                ],
            }
        )
    )

    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
    subprocess.run(
        ["git", "config", "user.email", "t@example.invalid"], cwd=repo, check=True
    )
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "initial"], cwd=repo, check=True)
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
    sidecar["reviews"].append({"by": "x", "at": "2026-01-03T00:00:00Z", "spans": []})
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
