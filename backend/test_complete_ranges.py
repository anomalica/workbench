#!/usr/bin/env python3
"""Bounded human-gold ranges are exact, disjoint and reviewer-owned."""

import pytest

from backend.tuning import GoldError, empty_sidecar, select_range

HASH = "a" * 64
BODY = "x" * 1000
REVIEWER = {"issuer": "github", "subject": "42", "name": "Reviewer"}


def sidecar():
    return empty_sidecar(HASH, BODY)


def test_default_range_covers_the_whole_body():
    selected = select_range(sidecar(), REVIEWER, len(BODY))
    assert (selected["start"], selected["end"]) == (0, len(BODY))
    assert selected["complete"] is False


def test_an_exact_bounded_range_is_created():
    selected = select_range(sidecar(), REVIEWER, len(BODY), start=100, end=300)
    assert (selected["start"], selected["end"]) == (100, 300)
    assert len(selected["id"]) == 32


@pytest.mark.parametrize(("start", "end"), [(-1, 10), (10, 10), (20, 10), (0, 1001)])
def test_invalid_bounds_are_refused(start, end):
    with pytest.raises(GoldError, match="within"):
        select_range(sidecar(), REVIEWER, len(BODY), start=start, end=end)


def test_a_new_range_cannot_overlap_an_existing_pass():
    doc = sidecar()
    existing = select_range(doc, REVIEWER, len(BODY), start=100, end=300)
    doc["ranges"].append(existing)
    with pytest.raises(GoldError, match="must not overlap"):
        select_range(doc, REVIEWER, len(BODY), start=250, end=400)


def test_default_resume_uses_the_latest_incomplete_range_for_this_reviewer():
    doc = sidecar()
    first = select_range(doc, REVIEWER, len(BODY), start=0, end=100)
    first["updated_at"] = "2026-09-14T10:00:00Z"
    doc["ranges"].append(first)
    second = select_range(doc, REVIEWER, len(BODY), start=200, end=300)
    second["updated_at"] = "2026-09-14T11:00:00Z"
    doc["ranges"].append(second)
    assert select_range(doc, REVIEWER, len(BODY))["id"] == second["id"]
