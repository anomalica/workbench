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
        content_hash=f"sha256:{'a' * 64}",
        input_sha256=hk.input_sha256(RECORD.encode()),
        checked_at="2026-08-19T20:00:00Z",
        algorithm_version=hk.ALGORITHM_VERSION,
        outcome="completed",
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
                "2026-08-11",
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
    out = hk.apply_items(record, approved, sc.input_sha256)

    assert "posted_by: " in out
    assert "publisher:" not in out
    # The unapproved item did NOT land.
    assert "date_published: '2026-08-11'" in out
    assert sc.items[1].status == "proposed"


def test_the_body_is_untouched_by_an_approval(record):
    sc = _sidecar()
    for i in sc.items:
        i.status = "approved"
    out = hk.apply_items(record, sc.items, sc.input_sha256)
    assert hk.body_digest(out) == hk.body_digest(RECORD)
    assert "It's called Cydonia" in out


def test_untouched_frontmatter_keeps_its_bytes(record):
    sc = _sidecar()
    sc.items[0].status = "approved"
    out = hk.apply_items(record, [sc.items[0]], sc.input_sha256)
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
    assert d["schema"] == "anomalica/housekeeping/2"
    assert d["input_sha256"] == hk.input_sha256(RECORD.encode())
    assert {i["id"] for i in d["items"]} == {"i-move", "i-year"}
    assert d["items"][0]["to_field"] == "posted_by"


def test_replace_token_uses_exact_hash_and_complete_byte_occurrences(tmp_path):
    text = "---\ntitle: Programme\n---\nOSSAP met OSSAP_2, then OSSAP.\n"
    path = tmp_path / "record.md"
    path.write_text(text)
    raw = text.encode()
    starts = [i for i in range(len(raw)) if raw.startswith(b"OSSAP", i)]
    whole = [
        i
        for i in starts
        if i + 5 == len(raw)
        or raw[i + 5]
        not in b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_"
    ]
    item = hk.Item(
        id="canonical-programme",
        check="canonical-programme-name",
        field=None,
        operation="replace-token",
        current=None,
        proposed=None,
        confidence="high",
        evidence=hk.Evidence(reasoning="The canonical name is AAWSAP."),
        status="approved",
        scope="body",
        old_token="OSSAP",
        new_token="AAWSAP",
        case_sensitive=True,
        token_boundary="ascii-word",
        occurrences=[{"start_byte": i, "end_byte": i + 5} for i in whole],
        expected_count=len(whole),
    )

    result = hk.apply_patch(path, [item], expected_input_sha256=hk.input_sha256(raw))
    assert result.text.endswith("AAWSAP met OSSAP_2, then AAWSAP.\n")

    path.write_text(text.replace("then OSSAP", "then OSAP"))
    with pytest.raises(hk.StaleInput):
        hk.apply_patch(path, [item], expected_input_sha256=hk.input_sha256(raw))
