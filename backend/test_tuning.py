#!/usr/bin/env python3
"""Tests for the relevance-tuning highlights sidecar and its endpoints."""

import hashlib
import json
import subprocess

import pytest
from fastapi.testclient import TestClient

import backend.server as server
from backend.server import LocalIngestSource, parse_frontmatter
from backend.tuning import (
    HIGHLIGHTS_SCHEMA,
    SpanError,
    body_sha256,
    validate_spans,
)

CONTENT_HASH = "b" * 64

RECORD = f"""---
schema: anomalica/record/1
content_hash: {CONTENT_HASH}
title: Tuning Record
---

<!-- speaker: Speaker 1 -->
00:00:01.0 The tic-tac moved erratically.
00:00:05.0 Weather was clear that day.
"""

BODY = parse_frontmatter(RECORD)[1]


@pytest.fixture
def ingests_repo(tmp_path):
    repo = tmp_path / "ingests"
    store = repo / "store"
    store.mkdir(parents=True)
    (store / f"{CONTENT_HASH}.md").write_text(RECORD)
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.invalid"], cwd=repo, check=True
    )
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "initial"], cwd=repo, check=True)
    return repo


@pytest.fixture
def client(ingests_repo, tmp_path, monkeypatch):
    monkeypatch.setattr(server, "source", LocalIngestSource(ingests_repo))
    monkeypatch.setattr(server, "grading_path", tmp_path / "grading")
    monkeypatch.setattr(
        server,
        "_require_user",
        lambda request: {"email": "reviewer@example.invalid", "name": "Reviewer"},
    )
    return TestClient(server.app)


def span_for(text: str, note: str | None = None) -> dict:
    start = BODY.index(text)
    span = {"start": start, "end": start + len(text), "text": text}
    if note:
        span["note"] = note
    return span


# --- validate_spans ---


def test_validate_spans_accepts_matching_span():
    spans = validate_spans([span_for("tic-tac moved erratically")], BODY)
    assert spans[0]["text"] == "tic-tac moved erratically"


def test_validate_spans_sorts_by_start():
    a = span_for("Weather was clear")
    b = span_for("tic-tac")
    assert [s["text"] for s in validate_spans([a, b], BODY)] == [
        "tic-tac",
        "Weather was clear",
    ]


def test_validate_spans_rejects_text_mismatch():
    span = span_for("tic-tac")
    span["text"] = "tick-tock"
    with pytest.raises(SpanError, match="does not match"):
        validate_spans([span], BODY)


def test_validate_spans_rejects_out_of_range():
    with pytest.raises(SpanError, match="out of range"):
        validate_spans([{"start": 0, "end": len(BODY) + 5, "text": "x"}], BODY)


def test_validate_spans_rejects_overlap():
    a = span_for("tic-tac moved")
    b = span_for("moved erratically")
    with pytest.raises(SpanError, match="non-overlapping"):
        validate_spans([a, b], BODY)


def test_validate_spans_allows_overlap_for_rejected():
    a = span_for("tic-tac moved")
    b = span_for("moved erratically")
    assert len(validate_spans([a, b], BODY, allow_overlap=True)) == 2


def test_validate_spans_offsets_are_code_points():
    body = "café \U0001f6f8 sighting"
    text = "\U0001f6f8 sighting"
    start = body.index(text)  # Python str.index counts code points
    spans = validate_spans(
        [{"start": start, "end": start + len(text), "text": text}], body
    )
    assert spans[0]["start"] == 5


def test_body_sha256_is_utf8_hash():
    assert body_sha256("abc") == hashlib.sha256(b"abc").hexdigest()


# --- endpoints ---


def test_get_raw_body_serves_verbatim_post_frontmatter_text(client):
    res = client.get(f"/api/ingests/{CONTENT_HASH}/body")
    assert res.status_code == 200
    data = res.json()
    assert data["body"] == BODY
    assert data["body_sha256"] == body_sha256(BODY)


def test_get_highlights_when_none_exist(client):
    res = client.get(f"/api/ingests/{CONTENT_HASH}/highlights")
    assert res.status_code == 200
    data = res.json()
    assert data["highlights"] is None
    assert data["body_sha256"] == body_sha256(BODY)


def test_put_highlights_writes_sidecar_and_commits(client, ingests_repo):
    res = client.put(
        f"/api/ingests/{CONTENT_HASH}/highlights",
        json={
            "complete": True,
            "spans": [span_for("tic-tac moved erratically", note="core claim")],
            "rejected": [span_for("Weather was clear")],
        },
    )
    assert res.status_code == 200
    assert res.json() == {"saved": True, "body_sha256": body_sha256(BODY)}

    sidecar_path = ingests_repo / "store" / f"{CONTENT_HASH}.highlights.json"
    sidecar = json.loads(sidecar_path.read_text())
    assert sidecar["schema"] == HIGHLIGHTS_SCHEMA
    assert sidecar["record_hash"] == CONTENT_HASH
    assert sidecar["body_sha256"] == body_sha256(BODY)
    assert sidecar["complete"] is True
    assert sidecar["reviewed_by"] == "reviewer@example.invalid"
    assert sidecar["reviewed_at"].endswith("Z")
    assert sidecar["spans"][0]["note"] == "core claim"
    assert sidecar["rejected"][0]["text"] == "Weather was clear"

    log = subprocess.run(
        ["git", "log", "-1", "--format=%s|%an"],
        cwd=ingests_repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert log == "highlights: Tuning Record|Reviewer"


def test_put_highlights_rejects_bad_span(client):
    res = client.put(
        f"/api/ingests/{CONTENT_HASH}/highlights",
        json={"spans": [{"start": 0, "end": 4, "text": "nope"}]},
    )
    assert res.status_code == 400
    assert "does not match" in res.json()["detail"]


def test_get_highlights_roundtrip(client):
    span = span_for("tic-tac")
    client.put(
        f"/api/ingests/{CONTENT_HASH}/highlights",
        json={"complete": False, "spans": [span]},
    )
    data = client.get(f"/api/ingests/{CONTENT_HASH}/highlights").json()
    assert data["highlights"]["spans"] == [span]
    assert data["highlights"]["complete"] is False
    assert data["highlights"]["rejected"] == []


def test_get_grading_unavailable(client):
    res = client.get(f"/api/ingests/{CONTENT_HASH}/grading")
    assert res.status_code == 200
    assert res.json() == {"available": False, "body_sha256": body_sha256(BODY)}


def test_get_grading_serves_results_keyed_by_body_hash(client, tmp_path):
    grading_dir = tmp_path / "grading"
    grading_dir.mkdir()
    results = {
        "schema": "anomalica/grading/1",
        "record_hash": CONTENT_HASH,
        "body_sha256": body_sha256(BODY),
        "models": [{"model": "test", "recall": 0.5, "precision": 1.0, "f1": 0.67}],
    }
    (grading_dir / f"{body_sha256(BODY)}.grading.json").write_text(json.dumps(results))

    res = client.get(f"/api/ingests/{CONTENT_HASH}/grading")
    assert res.status_code == 200
    data = res.json()
    assert data["available"] is True
    assert data["grading"]["models"][0]["model"] == "test"


def test_endpoints_reject_malformed_hash(client):
    for path in ("body", "highlights", "grading"):
        assert client.get(f"/api/ingests/nothex/{path}").status_code == 404
