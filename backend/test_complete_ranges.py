#!/usr/bin/env python3
"""complete_ranges: which parts of a record the reviewer actually swept.

An unhighlighted sentence is ambiguous - "read it, not claim-worthy" or "never
looked at it" - and those are opposite signals. The whole-record `complete` flag
can only say "all of it" or nothing. On the 3.5-hour Jon Stewart video a reviewer
sweeping two bounded sections (which is what ADR 0042 prescribes) must set
complete=false, because true would be a lie about the other three hours - and eval
must then score recall only, discarding the over-extraction signal, which is the
noise question Mark is actually asking.

Nobody can reconstruct afterwards which parts he read, so this had to exist
before his session, not after.
"""

import pytest

from backend.tuning import build_sidecar, validate_ranges

BODY = "x" * 1000


def test_absent_ranges_leave_the_sidecar_exactly_as_before():
    doc = build_sidecar("h", BODY, False, [], [], "me", "now")
    assert "complete_ranges" not in doc, (
        "additive: existing sidecars stay byte-identical"
    )


def test_ranges_round_trip():
    doc = build_sidecar(
        "h",
        BODY,
        False,
        [],
        [],
        "me",
        "now",
        complete_ranges=[{"start": 10, "end": 50, "note": "the DIA email passage"}],
    )
    assert doc["complete_ranges"] == [
        {"start": 10, "end": 50, "note": "the DIA email passage"}
    ]


def test_touching_and_overlapping_ranges_merge():
    """Two adjacent sweeps are one swept region. Left separate, the same gap
    could be scored twice."""
    got = validate_ranges(
        BODY, [{"start": 100, "end": 200}, {"start": 200, "end": 300}]
    )
    assert got == [{"start": 100, "end": 300}]
    got = validate_ranges(
        BODY, [{"start": 100, "end": 250}, {"start": 200, "end": 300}]
    )
    assert got == [{"start": 100, "end": 300}]


def test_merging_keeps_both_notes():
    got = validate_ranges(
        BODY,
        [
            {"start": 10, "end": 40, "note": "first"},
            {"start": 30, "end": 60, "note": "second"},
        ],
    )
    assert got[0]["note"] == "first; second"


def test_ranges_are_sorted():
    got = validate_ranges(BODY, [{"start": 500, "end": 600}, {"start": 10, "end": 20}])
    assert [r["start"] for r in got] == [10, 500]


def test_a_range_outside_the_body_is_refused():
    # A range must be checkable against the same body the spans are, or it claims
    # coverage of text that does not exist.
    with pytest.raises(ValueError):
        validate_ranges(BODY, [{"start": 0, "end": 1001}])
    with pytest.raises(ValueError):
        validate_ranges(BODY, [{"start": -1, "end": 10}])


def test_an_inverted_or_empty_range_is_refused():
    with pytest.raises(ValueError):
        validate_ranges(BODY, [{"start": 50, "end": 50}])
    with pytest.raises(ValueError):
        validate_ranges(BODY, [{"start": 60, "end": 50}])


def test_a_malformed_range_is_refused_not_guessed():
    with pytest.raises(ValueError):
        validate_ranges(BODY, [{"start": "ten", "end": 50}])
    with pytest.raises(ValueError):
        validate_ranges(BODY, [{"end": 50}])


def test_none_and_empty_are_simply_no_ranges():
    assert validate_ranges(BODY, None) == []
    assert validate_ranges(BODY, []) == []
