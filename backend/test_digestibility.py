#!/usr/bin/env python3
"""compute_digestibility mirrors the digester gate at the 100%-observed rule."""

from backend.server import compute_digestibility

TRANSCRIPT = """---
title: T
---
00:00:01 Line one.
00:00:05 Line two.
00:00:10 Line three.
"""

TEXT = """---
title: T
---
First para.

<!-- comment -->
Second para.
"""


def test_no_sidecar_is_not_digestible():
    assert compute_digestibility(TEXT, None) == (False, 0.0)


def test_prefers_stored_verdict_fraction():
    # Schema /1 verdict: the fraction is authoritative; 100% -> digestible.
    assert compute_digestibility(None, {"observed_coverage": 1.0}) == (True, 1.0)
    assert compute_digestibility(None, {"observed_coverage": 0.5}) == (False, 0.5)


def test_uses_digestible_bool_when_no_fraction():
    assert compute_digestibility(None, {"digestible": True}) == (True, 1.0)
    assert compute_digestibility(None, {"digestible": False}) == (False, 0.0)


def test_legacy_recompute_over_transcript_lines():
    # Content units are the three timestamped lines (1-indexed 4..6).
    all_observed = {"reviews": [{"spans": [{"from": 4, "to": 6, "kind": "observed"}]}]}
    assert compute_digestibility(TRANSCRIPT, all_observed) == (True, 1.0)

    two_of_three = {"reviews": [{"spans": [{"from": 4, "to": 5, "kind": "observed"}]}]}
    digestible, cov = compute_digestibility(TRANSCRIPT, two_of_three)
    assert digestible is False
    assert round(cov, 2) == 0.67


def test_legacy_recompute_ignores_blank_and_comment_lines():
    # TEXT has two content lines (4 and 7); 5 is blank, 6 is a comment.
    both = {"reviews": [{"spans": [{"from": 4, "to": 7, "kind": "observed"}]}]}
    assert compute_digestibility(TEXT, both) == (True, 1.0)

    one = {"reviews": [{"spans": [{"from": 4, "to": 4, "kind": "observed"}]}]}
    assert compute_digestibility(TEXT, one) == (False, 0.5)


def test_played_spans_do_not_count_as_observed():
    # Only "observed" spans count toward the gate; "played" is weak coverage.
    played = {"reviews": [{"spans": [{"from": 4, "to": 6, "kind": "played"}]}]}
    assert compute_digestibility(TRANSCRIPT, played) == (False, 0.0)


def test_legacy_recompute_skipped_without_body():
    # Without the record text, a verdict-less /0 sidecar reads as 0%.
    spans_only = {"reviews": [{"spans": [{"from": 4, "to": 6, "kind": "observed"}]}]}
    assert compute_digestibility(None, spans_only) == (False, 0.0)
