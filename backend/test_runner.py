#!/usr/bin/env python3
"""The dual-trend gate is the spend-pacing safety core - a bug here would burn
the shared weekly rate-limit. Test it exhaustively: the trend line, dispatch
only when below BOTH windows by the margin, the session cap, safe defaults, and
the credit-safety guards (fail-closed freshness, flat output paths, the
version-aware on-disk re-spend guard, the failed-attempt cap, and the
fail-closed reschedule)."""

import json
import os
from datetime import datetime, timedelta, timezone

import backend.runner as r
from backend.runner import (
    FIVE_HOUR_S,
    MARGIN_PCT,
    MAX_DIGEST_ATTEMPTS,
    SEVEN_DAY_S,
    _classify_usage,
    _execute_enabled,
    _parse_usage,
    current_digest_exists,
    digest_out_path,
    evaluate_gate,
    pick_top_digest_job,
    resolve_body_path,
    safe_margin,
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


# --- The pure dual-trend gate -----------------------------------------------


def test_window_ideal_line():
    start = _iso(NOW + timedelta(seconds=FIVE_HOUR_S))  # reset 5h out -> 0% elapsed
    assert window_ideal_pct(start, FIVE_HOUR_S, NOW) == 0.0
    half = _iso(NOW + timedelta(seconds=FIVE_HOUR_S / 2))  # 50% elapsed
    assert round(window_ideal_pct(half, FIVE_HOUR_S, NOW)) == 50
    at_reset = _iso(NOW)
    assert window_ideal_pct(at_reset, FIVE_HOUR_S, NOW) == 100.0
    past = _iso(NOW - timedelta(hours=1))  # reset already passed -> treat as full
    assert window_ideal_pct(past, FIVE_HOUR_S, NOW) == 100.0


# These assert specific below-line decisions, so they pass an explicit margin (3)
# to stay independent of the configurable default (now 15).


def test_dispatch_when_below_both_lines():
    g = evaluate_gate(_usage(40, 0.5, 26, 0.5), NOW, margin=3)
    assert g["dispatch"] is True
    assert g["windows"]["five_hour"]["below"] and g["windows"]["seven_day"]["below"]


def test_no_dispatch_when_five_hour_at_line():
    g = evaluate_gate(_usage(49, 0.5, 26, 0.5), NOW, margin=3)
    assert g["dispatch"] is False
    assert "5-hour" in g["reason"]


def test_no_dispatch_when_seven_day_at_line():
    g = evaluate_gate(_usage(10, 0.5, 49, 0.5), NOW, margin=3)
    assert g["dispatch"] is False
    assert "7-day" in g["reason"]


def test_margin_keeps_it_off_the_line():
    g = evaluate_gate(_usage(50, 0.5, 50, 0.5), NOW, margin=3)
    assert g["dispatch"] is False


def test_bigger_margin_holds_where_a_small_one_would_dispatch():
    # 5h util 44 at ideal 50: dispatches at margin 3 (44 <= 47), holds at 15 (44 > 35)
    assert evaluate_gate(_usage(44, 0.5, 20, 0.5), NOW, margin=3)["dispatch"] is True
    assert evaluate_gate(_usage(44, 0.5, 20, 0.5), NOW, margin=15)["dispatch"] is False


def test_default_margin_is_15():
    assert MARGIN_PCT == 15.0
    # default applies when margin isn't passed
    assert evaluate_gate(_usage(44, 0.5, 20, 0.5), NOW)["dispatch"] is False


def test_session_cap_blocks_even_below_line():
    # late in the 5h window the line is ~99, util 95 is "below" it, but the
    # session cap (90) must still block - never let the session approach 100.
    g = evaluate_gate(_usage(95, 0.99, 10, 0.5), NOW, margin=3)
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


def test_negative_util_on_both_does_not_dispatch():
    # negative util would read as huge headroom; must fail closed.
    g = evaluate_gate(_usage(-5, 0.5, -5, 0.5), NOW)
    assert g["dispatch"] is False
    assert "out of range" in g["reason"]


def test_over_100_and_nan_util_do_not_dispatch():
    assert evaluate_gate(_usage(150, 0.5, 10, 0.5), NOW)["dispatch"] is False
    assert evaluate_gate(_usage(float("nan"), 0.5, 10, 0.5), NOW)["dispatch"] is False


def test_live_scenario_from_master():
    # Master's testing reading: ~44% of the 5h window, 26% of 7-day, ~3 under
    # the line. Model 5h ~47% elapsed (44 is 3 under) and 7d ~30% elapsed.
    g = evaluate_gate(_usage(44, 0.47, 26, 0.30), NOW, margin=3)
    assert g["dispatch"] is True


def test_safe_margin_fails_closed():
    assert safe_margin(20) == 20.0
    assert safe_margin("12.5") == 12.5
    # invalid -> safe default (15), never 0
    assert safe_margin(0) == MARGIN_PCT  # never let it be 0
    assert safe_margin(-5) == MARGIN_PCT
    assert safe_margin(100) == MARGIN_PCT
    assert safe_margin(float("nan")) == MARGIN_PCT
    assert safe_margin(None) == MARGIN_PCT
    assert safe_margin("not a number") == MARGIN_PCT


def test_set_margin_persists_and_validates(monkeypatch, tmp_path):
    monkeypatch.setenv("RUNNER_STATE_DIR", str(tmp_path / "state"))
    run = r.Runner()
    assert run.status()["margin"] == MARGIN_PCT  # default
    assert run.set_margin(25)["margin"] == 25.0
    # a fresh Runner reads the persisted value back
    assert r.Runner().status()["margin"] == 25.0
    # invalid input fails closed to the default, never 0
    assert run.set_margin(0)["margin"] == MARGIN_PCT
    assert run.set_margin("garbage")["margin"] == MARGIN_PCT


# --- Fail-closed freshness (_classify_usage) --------------------------------


def _line(d) -> str:
    return json.dumps(d)


def test_classify_usage_fresh_in_window():
    rec, st = _classify_usage(
        _line({"t": _iso(NOW - timedelta(minutes=5)), "x": 1}), NOW
    )
    assert st == "fresh" and rec["x"] == 1


def test_classify_usage_stale_when_old_or_future():
    assert (
        _classify_usage(_line({"t": _iso(NOW - timedelta(hours=2))}), NOW)[1] == "stale"
    )
    assert (
        _classify_usage(_line({"t": _iso(NOW + timedelta(hours=2))}), NOW)[1] == "stale"
    )


def test_classify_usage_fails_closed_on_bad_timestamp():
    # missing / empty / garbage / non-tz timestamp -> stale, NEVER fresh
    assert _classify_usage(_line({"no_t": 1}), NOW)[1] == "stale"
    assert _classify_usage(_line({"t": ""}), NOW)[1] == "stale"
    assert _classify_usage(_line({"t": "not-a-date"}), NOW)[1] == "stale"
    assert _classify_usage(_line({"t": 12345}), NOW)[1] == "stale"


def test_classify_usage_unavailable_on_garbage():
    assert _classify_usage("", NOW) == (None, "unavailable")
    assert _classify_usage("   ", NOW) == (None, "unavailable")
    assert _classify_usage("not json at all", NOW) == (None, "unavailable")
    assert _classify_usage("42", NOW) == (None, "unavailable")  # non-dict JSON
    assert _classify_usage("[1, 2, 3]", NOW) == (None, "unavailable")  # non-dict JSON


def test_classify_usage_takes_last_line():
    two = _line({"t": _iso(NOW - timedelta(hours=3))}) + "\n" + _line({"t": _iso(NOW)})
    assert _classify_usage(two, NOW)[1] == "fresh"


# --- Output-path keying (flat, never a free-text title) ---------------------


def test_execution_disabled_by_default(monkeypatch):
    monkeypatch.delenv("RUNNER_EXECUTE", raising=False)
    assert _execute_enabled() is False
    monkeypatch.setenv("RUNNER_EXECUTE", "1")
    assert _execute_enabled() is True
    for off in ("", "0", "false", "no"):
        monkeypatch.setenv("RUNNER_EXECUTE", off)
        assert _execute_enabled() is False


def test_digest_out_path_flat_from_records_slug(monkeypatch, tmp_path):
    monkeypatch.setenv("INGESTS_PATH", str(tmp_path / "ingests"))
    monkeypatch.setenv("DIGESTS_PATH", str(tmp_path / "digests"))
    records = tmp_path / "ingests" / "records"
    records.mkdir(parents=True)
    h = "b" * 64
    # the ingester already sanitises '/' out of titles; the slug is flat
    slug = (
        "2023-09-07-video-the-20m-cia-psychic-spy-program-w-nelsondellis-debriefed-ep"
    )
    os.symlink(f"../store/{h}.v2.md", records / f"{slug}.v2.md")
    out = digest_out_path(h)
    assert out == tmp_path / "digests" / "records" / f"{slug}.yaml"
    assert "/" not in out.name  # never nested into a subdirectory
    # an unknown hash has no records/ symlink -> None (don't write blindly)
    assert digest_out_path("c" * 64) is None


def test_parse_usage_reads_last_usage_json_line():
    stdout = 'noise\nUSAGE_JSON: {"output_tokens": 4200, "total_tokens": 9001}\ndone\n'
    assert _parse_usage(stdout) == {"output_tokens": 4200, "total_tokens": 9001}
    assert _parse_usage("no usage line here") is None
    assert _parse_usage("USAGE_JSON: not-json") is None


def test_resolve_body_path_prefers_v2_never_slug(monkeypatch, tmp_path):
    monkeypatch.setenv("INGESTS_PATH", str(tmp_path))
    store = tmp_path / "store"
    store.mkdir()
    h = "a" * 64
    assert resolve_body_path(h) is None  # nothing in the store yet
    (store / f"{h}.md").write_text("v1 body")
    assert resolve_body_path(h) == store / f"{h}.md"
    (store / f"{h}.v2.md").write_text("v2 reviewed body")
    assert resolve_body_path(h) == store / f"{h}.v2.md"  # v2 wins


def test_pick_top_digest_job_honours_exclude(monkeypatch, tmp_path):
    queue = {
        "jobs": [
            {
                "id": "j1",
                "lane": "claude",
                "type": "digest",
                "status": "eligible",
                "value": 9,
                "target": {"hash": "h1"},
            },
            {
                "id": "j2",
                "lane": "claude",
                "type": "digest",
                "status": "eligible",
                "value": 5,
                "target": {"hash": "h2"},
            },
        ]
    }
    qf = tmp_path / "queue.json"
    qf.write_text(json.dumps(queue))
    monkeypatch.setenv("SCHEDULER_QUEUE_PATH", str(qf))
    assert pick_top_digest_job()["id"] == "j1"  # highest value
    assert pick_top_digest_job({"h1"})["id"] == "j2"  # h1 excluded
    assert pick_top_digest_job({"h1", "h2"}) is None  # both excluded


# --- Version-aware on-disk re-spend guard -----------------------------------


def _wire_record(monkeypatch, tmp_path, h, slug, record_version):
    """Lay down a store body (with processing.version) + a records/ symlink so
    resolve_body_path / slug_for_hash / digest_out_path all resolve."""
    monkeypatch.setenv("INGESTS_PATH", str(tmp_path / "ingests"))
    monkeypatch.setenv("DIGESTS_PATH", str(tmp_path / "digests"))
    store = tmp_path / "ingests" / "store"
    records = tmp_path / "ingests" / "records"
    (tmp_path / "digests" / "records").mkdir(parents=True, exist_ok=True)
    store.mkdir(parents=True, exist_ok=True)
    records.mkdir(parents=True, exist_ok=True)
    (store / f"{h}.v2.md").write_text(
        f"---\ncontent_hash: sha256:{h}\nprocessing:\n  version: {record_version}\n---\nbody\n"
    )
    os.symlink(f"../store/{h}.v2.md", records / f"{slug}.v2.md")
    return tmp_path / "digests" / "records" / f"{slug}.yaml"


def test_current_digest_exists_version_aware(monkeypatch, tmp_path):
    h = "d" * 64
    digest = _wire_record(monkeypatch, tmp_path, h, "2026-01-01-video-example", "ABC")
    assert current_digest_exists(h) is False  # no digest yet
    digest.write_text(
        f"record:\n  content_hash: sha256:{h}\n  processing_version: ABC\n"
    )
    assert current_digest_exists(h) is True  # versions match -> current
    digest.write_text(
        f"record:\n  content_hash: sha256:{h}\n  processing_version: OLD\n"
    )
    assert current_digest_exists(h) is False  # stale -> needs re-digest, NOT skipped
    digest.write_text(f"record:\n  content_hash: sha256:{h}\n")  # version absent
    assert current_digest_exists(h) is True  # missing-safe -> treated as current
    digest.write_text(
        "record:\n  content_hash: sha256:0000\n  processing_version: ABC\n"
    )
    assert current_digest_exists(h) is False  # different content_hash -> not ours


# --- The executor's safety decisions (no thread, no real sleep) -------------


def _runner(monkeypatch, tmp_path):
    monkeypatch.setenv("RUNNER_STATE_DIR", str(tmp_path / "state"))
    run = r.Runner()
    monkeypatch.setattr(run, "_sleep", lambda secs: None)  # never really sleep in tests
    return run


def test_execute_skips_content_hash_less(monkeypatch, tmp_path):
    run = _runner(monkeypatch, tmp_path)
    run._execute_digest({"target": {"hash": "short", "label": "X"}}, {}, "fresh")
    st = run.status()
    assert st["state"] == "waiting" and "content_hash" in st["reason"]
    assert "short" in run._done  # won't be re-picked this run


def test_execute_skips_when_current_digest_exists(monkeypatch, tmp_path):
    run = _runner(monkeypatch, tmp_path)
    monkeypatch.setenv("RUNNER_EXECUTE", "1")
    monkeypatch.setattr(r, "current_digest_exists", lambda h: True)
    run._execute_digest({"target": {"hash": "e" * 64, "label": "Done"}}, {}, "fresh")
    assert run.status()["state"] == "idle"
    assert "already digested" in run.status()["reason"]


def test_execute_disabled_reports_would_digest(monkeypatch, tmp_path):
    run = _runner(monkeypatch, tmp_path)
    monkeypatch.delenv("RUNNER_EXECUTE", raising=False)
    monkeypatch.setattr(r, "current_digest_exists", lambda h: False)
    run._execute_digest({"target": {"hash": "f" * 64, "label": "Pending"}}, {}, "fresh")
    st = run.status()
    assert st["state"] == "ready" and "would digest" in st["reason"]


def test_failed_attempt_cap_skips(monkeypatch, tmp_path):
    run = _runner(monkeypatch, tmp_path)
    h = "a" * 64
    run._failed[h] = MAX_DIGEST_ATTEMPTS
    run._execute_digest({"target": {"hash": h, "label": "Flaky"}}, {}, "fresh")
    assert "cap" in run.status()["reason"]


def _wire_successful_digest(monkeypatch, tmp_path, returncode=0, write_out=True):
    h = "a" * 64
    monkeypatch.setenv("RUNNER_EXECUTE", "1")
    monkeypatch.setattr(r, "current_digest_exists", lambda x: False)
    monkeypatch.setattr(r, "resolve_body_path", lambda x: tmp_path / "body.md")
    out = tmp_path / "out.yaml"
    monkeypatch.setattr(r, "digest_out_path", lambda x: out)
    if write_out:
        out.write_text("digest")

    class _Proc:
        pass

    proc = _Proc()
    proc.returncode = returncode
    proc.stdout = 'USAGE_JSON: {"output_tokens": 5}'
    monkeypatch.setattr(r, "run_digest", lambda b, o: proc)
    return h


def test_successful_digest_fails_closed_when_reschedule_unconfirmed(
    monkeypatch, tmp_path
):
    run = _runner(monkeypatch, tmp_path)
    h = _wire_successful_digest(monkeypatch, tmp_path)
    monkeypatch.setattr(r, "rerun_scheduler", lambda: False)  # can't confirm
    run._execute_digest({"target": {"hash": h, "label": "Nordic"}}, {}, "fresh")
    st = run.status()
    assert st["halted"] is True and "stale queue" in st["reason"]


def test_successful_digest_halts_if_still_eligible(monkeypatch, tmp_path):
    run = _runner(monkeypatch, tmp_path)
    h = _wire_successful_digest(monkeypatch, tmp_path)
    monkeypatch.setattr(r, "rerun_scheduler", lambda: True)
    monkeypatch.setattr(
        r, "is_eligible_digest", lambda x: True
    )  # completion not registered
    run._execute_digest({"target": {"hash": h, "label": "Nordic"}}, {}, "fresh")
    st = run.status()
    assert st["halted"] is True and "completion not registered" in st["reason"]


def test_successful_digest_clean_path(monkeypatch, tmp_path):
    run = _runner(monkeypatch, tmp_path)
    h = _wire_successful_digest(monkeypatch, tmp_path)
    run._failed[h] = 1  # a prior failure that should clear on success
    monkeypatch.setattr(r, "rerun_scheduler", lambda: True)
    monkeypatch.setattr(
        r, "is_eligible_digest", lambda x: False
    )  # dropped, as expected
    run._execute_digest({"target": {"hash": h, "label": "Nordic"}}, {}, "fresh")
    st = run.status()
    assert st["halted"] is False
    assert st["completed"][0]["ok"] is True and st["completed"][0]["tokens"] == 5
    assert h not in run._failed  # cleared on success


def test_failed_digest_increments_and_does_not_reschedule(monkeypatch, tmp_path):
    run = _runner(monkeypatch, tmp_path)
    # returncode 1 -> ok False -> no reschedule, failed count rises
    h = _wire_successful_digest(monkeypatch, tmp_path, returncode=1)
    called = {"reschedule": False}
    monkeypatch.setattr(
        r, "rerun_scheduler", lambda: called.__setitem__("reschedule", True) or True
    )
    run._execute_digest({"target": {"hash": h, "label": "Nordic"}}, {}, "fresh")
    assert called["reschedule"] is False  # reschedule fires only on success
    assert run._failed[h] == 1
    assert run.status()["completed"][0]["ok"] is False


def test_off_does_not_spawn_a_worker(monkeypatch, tmp_path):
    run = _runner(monkeypatch, tmp_path)
    run.resume_if_on()  # _on is False -> must not start a thread
    assert run._thread is None
