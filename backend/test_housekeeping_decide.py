"""The decide route: per-item approval, applied by the server, body untouched."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from anomalica_common import housekeeping as hk

RECORD = """---
title: 'Eyewitnesses Talk to Dr. James E. McDonald (1967)'
publisher: 'Eyes On Cinema'
date_published: '2026-08-11'
source_type: 'video'
content_hash: 'sha256:abc123'
---

<!-- speaker: Speaker 1 -->
It's called Cydonia, a complex region.
"""


def _sidecar() -> hk.Sidecar:
    ev = hk.Evidence(reasoning="channel republishes work it did not produce")
    return hk.Sidecar(
        content_hash="sha256:abc123",
        checked_at="2026-08-19T20:00:00Z",
        checker_version=hk.CHECKER_VERSION,
        items=[
            hk.Item(
                "i-move",
                "redistributor",
                "publisher",
                "move",
                "Eyes On Cinema",
                "Eyes On Cinema",
                "high",
                ev,
                to_field="posted_by",
            ),
            hk.Item(
                "i-year",
                "work-date",
                "date_published",
                "set",
                None,
                "1967",
                "medium",
                ev,
            ),
        ],
    )


@pytest.fixture
def record(tmp_path: Path) -> Path:
    p = tmp_path / "abc123.md"
    p.write_text(RECORD)
    return p


def test_approving_one_item_leaves_the_other_proposed(record):
    sc = _sidecar()
    sc.items[0].status = "approved"
    approved = [i for i in sc.items if i.status == "approved"]
    out = hk.apply_items(record, approved)

    assert "posted_by: " in out
    assert "publisher:" not in out
    # The unapproved item did NOT land.
    assert "date_published: '2026-08-11'" in out
    assert sc.items[1].status == "proposed"


def test_the_body_is_untouched_by_an_approval(record):
    sc = _sidecar()
    for i in sc.items:
        i.status = "approved"
    out = hk.apply_items(record, sc.items)
    assert hk.body_digest(out) == hk.body_digest(RECORD)
    assert "It's called Cydonia" in out


def test_untouched_frontmatter_keeps_its_bytes(record):
    sc = _sidecar()
    sc.items[0].status = "approved"
    out = hk.apply_items(record, [sc.items[0]])
    assert "title: 'Eyewitnesses Talk to Dr. James E. McDonald (1967)'" in out
    assert "source_type: 'video'" in out
    assert "content_hash: 'sha256:abc123'" in out


def test_a_rejected_item_changes_nothing_but_is_recorded(record, tmp_path):
    sc = _sidecar()
    sc.items[0].status = "rejected"
    out = hk.apply_items(record, [i for i in sc.items if i.status == "approved"])
    assert out == RECORD

    p = tmp_path / "abc123.housekeeping.json"
    hk.write_sidecar_file(p, sc)
    back = hk.load_sidecar_file(p)
    assert back is not None
    assert back.items[0].status == "rejected", (
        "a rejection must persist, or the next run re-proposes it forever"
    )


def test_the_sidecar_round_trips_through_the_wire_shape(tmp_path):
    p = tmp_path / "s.housekeeping.json"
    hk.write_sidecar_file(p, _sidecar())
    d = json.loads(p.read_text())
    assert d["schema"] == hk.SCHEMA
    assert {i["id"] for i in d["items"]} == {"i-move", "i-year"}
    assert d["items"][0]["to_field"] == "posted_by"
