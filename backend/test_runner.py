#!/usr/bin/env python3
"""The dual-trend gate is the spend-pacing safety core - a bug here would burn
the shared weekly rate-limit. Test it exhaustively: the trend line, dispatch
only when below BOTH windows by the margin, the session cap, and safe defaults."""

from datetime import datetime, timedelta, timezone

from backend.runner import (
    FIVE_HOUR_S,
    SEVEN_DAY_S,
    evaluate_gate,
    window_ideal_pct,
)

NOW = datetime(2026, 6, 20, 12, 0, 0, tzinfo=timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _usage(fh_util, fh_frac_elapsed, sd_util, sd_frac_elapsed):
    """Build a usage record where each window is `frac_elapsed` through (so its
    ideal trend line = frac*100), at the given utilisation."""
    return {
        "five_hour": {
            "utilization": fh_util,
            "resets_at": _iso(
                NOW + timedelta(seconds=FIVE_HOUR_S * (1 - fh_frac_elapsed))
            ),
        },
        "seven_day": {
            "utilization": sd_util,
            "resets_at": _iso(
                NOW + timedelta(seconds=SEVEN_DAY_S * (1 - sd_frac_elapsed))
            ),
        },
    }


def test_window_ideal_line():
    start = _iso(NOW + timedelta(seconds=FIVE_HOUR_S))  # reset 5h out -> 0% elapsed
    assert window_ideal_pct(start, FIVE_HOUR_S, NOW) == 0.0
    half = _iso(NOW + timedelta(seconds=FIVE_HOUR_S / 2))  # 50% elapsed
    assert round(window_ideal_pct(half, FIVE_HOUR_S, NOW)) == 50
    at_reset = _iso(NOW)
    assert window_ideal_pct(at_reset, FIVE_HOUR_S, NOW) == 100.0
    past = _iso(NOW - timedelta(hours=1))  # reset already passed -> treat as full
    assert window_ideal_pct(past, FIVE_HOUR_S, NOW) == 100.0


def test_dispatch_when_below_both_lines():
    # both windows 50% elapsed (ideal 50), utilisation well under -> dispatch
    g = evaluate_gate(_usage(40, 0.5, 26, 0.5), NOW)
    assert g["dispatch"] is True
    assert g["windows"]["five_hour"]["below"] and g["windows"]["seven_day"]["below"]


def test_no_dispatch_when_five_hour_at_line():
    # 5h utilisation above its line (49 vs ideal 50, margin 3) -> blocked
    g = evaluate_gate(_usage(49, 0.5, 26, 0.5), NOW)
    assert g["dispatch"] is False
    assert "5-hour" in g["reason"]


def test_no_dispatch_when_seven_day_at_line():
    g = evaluate_gate(_usage(10, 0.5, 49, 0.5), NOW)
    assert g["dispatch"] is False
    assert "7-day" in g["reason"]


def test_margin_keeps_it_off_the_line():
    # exactly on the line (util == ideal) is NOT below by the margin
    g = evaluate_gate(_usage(50, 0.5, 50, 0.5), NOW)
    assert g["dispatch"] is False


def test_session_cap_blocks_even_below_line():
    # late in the 5h window the line is ~99, util 95 is "below" it, but the
    # session cap (90) must still block - never let the session approach 100.
    g = evaluate_gate(_usage(95, 0.99, 10, 0.5), NOW)
    assert g["dispatch"] is False
    assert "cap" in g["reason"]


def test_malformed_usage_never_dispatches():
    assert evaluate_gate({}, NOW)["dispatch"] is False
    assert evaluate_gate({"five_hour": {}, "seven_day": {}}, NOW)["dispatch"] is False
    assert (
        evaluate_gate({"five_hour": {"utilization": "x", "resets_at": "?"}}, NOW)[
            "dispatch"
        ]
        is False
    )


def test_live_scenario_from_master():
    # Master's testing reading: ~44% of the 5h window, 26% of 7-day, ~3 under
    # the line. Model 5h ~47% elapsed (44 is 3 under) and 7d ~30% elapsed.
    g = evaluate_gate(_usage(44, 0.47, 26, 0.30), NOW)
    assert g["dispatch"] is True
