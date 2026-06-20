#!/usr/bin/env python3
"""/api/schedule serves the assimilator scheduler's queue JSON read-only, with
an empty queue when no run has emitted the file yet."""

import json

from backend.server import get_schedule

EMPTY = {"generatedAt": None, "jobs": [], "reviewQueue": [], "recordDemand": {}}


def test_empty_when_file_absent(tmp_path, monkeypatch):
    monkeypatch.setenv("SCHEDULER_QUEUE_PATH", str(tmp_path / "absent.json"))
    assert get_schedule() == EMPTY


def test_passes_the_queue_through_verbatim(tmp_path, monkeypatch):
    queue = {
        "schema": "anomalica/schedule/1",
        "generatedAt": "2026-06-20T20:32:00Z",
        "jobs": [{"id": "digest:abc", "type": "digest", "lane": "claude"}],
        "reviewQueue": [{"target": {"kind": "record", "label": "r"}, "demand": 4.0}],
        "recordDemand": {"abc": 3.5},
    }
    f = tmp_path / "scheduler-queue.json"
    f.write_text(json.dumps(queue))
    monkeypatch.setenv("SCHEDULER_QUEUE_PATH", str(f))
    assert get_schedule() == queue
