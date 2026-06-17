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
