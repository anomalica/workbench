"""Runner / processing-mode service.

Works the scheduler queue while processing mode is ON, then idles. Subscription
ONLY - `claude -p`, never a metered/dollar path. The DUAL-TREND usage gate IS the
spend-pacing: a Claude job dispatches only when usage is below the trend line on
BOTH the 5-hour session and the 7-day all-models window. See
anomalica/master/.ai/specs/runner-design.md.

Phase 1: the Claude worker + the gate + the digest executor + recently-completed
stats. The credit-safety posture is fail-closed throughout - any uncertainty
(stale/unreadable usage, an unconfirmed scheduler re-run, an out-of-range gate
reading) HOLDS rather than dispatches, because the only real risk is burning the
shared rate-limit. The pure gate is exhaustively tested (backend/test_runner.py).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import yaml

FIVE_HOUR_S = 5 * 3600
SEVEN_DAY_S = 7 * 86400

# Gate tuning.
MARGIN_PCT = 3.0  # stay this many points below the line before dispatching
SESSION_CAP_PCT = 90.0  # never dispatch if the 5h session is already this high
FRESH_MAX_AGE_S = 20 * 60  # usage outside +/- this window is stale - never gate on it
POLL_INTERVAL_S = 90  # re-check cadence while waiting at/above the line
MAX_DIGEST_ATTEMPTS = 2  # stop re-spending on a record that keeps failing

DEFAULT_STATE_DIR = Path.home() / ".local" / "share" / "anomalica-workbench"
FOREST_USAGE_DIR = "/var/lib/forest/bronze/claude-usage"

# The Anomalica repos sit beside the workbench: .../anomalica/{workbench,ingests,
# digests,digester,assimilator,anomalica-common}. runner.py is
# .../workbench/backend/runner.py, so the parent-of-parent-of-parent is anomalica/.
_ANOMALICA = Path(__file__).resolve().parents[2]


def _path(env: str, default: Path) -> Path:
    return Path(os.environ.get(env, str(default)))


# Real digest execution is OFF by default: with it off the worker still runs the
# gate (master can verify it against live usage) and reports what it WOULD run,
# but spends nothing. Set RUNNER_EXECUTE=1 for a supervised real run.
def _execute_enabled() -> bool:
    return os.environ.get("RUNNER_EXECUTE", "") not in ("", "0", "false", "no")


def _state_dir() -> Path:
    return Path(os.environ.get("RUNNER_STATE_DIR", str(DEFAULT_STATE_DIR)))


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --- The dual-trend gate (pure) ---------------------------------------------


def window_ideal_pct(resets_at: str, duration_s: int, now: datetime) -> float:
    """The trend line: % of the window elapsed, 0 at the window start rising to
    100 at resets_at. A reset in the past returns 100 (treat as full until a
    fresh post-reset sample arrives - safe, blocks dispatch)."""
    reset = datetime.fromisoformat(resets_at)
    start = reset - timedelta(seconds=duration_s)
    if now <= start:
        return 0.0
    if now >= reset:
        return 100.0
    return 100.0 * (now - start).total_seconds() / duration_s


def evaluate_gate(
    usage: dict,
    now: datetime,
    margin: float = MARGIN_PCT,
    session_cap: float = SESSION_CAP_PCT,
) -> dict:
    """Decide whether a Claude job may dispatch. Dispatch ONLY when actual
    utilisation is at least `margin` points below the trend line on BOTH windows
    AND the 5h session isn't already near 100%. `utilization` is a PERCENTAGE
    (0-100). Malformed/missing/out-of-range usage -> no dispatch (fail closed)."""
    try:
        fh = usage["five_hour"]
        sd = usage["seven_day"]
        fh_util = float(fh["utilization"])
        sd_util = float(sd["utilization"])
        fh_ideal = window_ideal_pct(fh["resets_at"], FIVE_HOUR_S, now)
        sd_ideal = window_ideal_pct(sd["resets_at"], SEVEN_DAY_S, now)
    except (KeyError, TypeError, ValueError):
        return {"dispatch": False, "reason": "usage unreadable", "windows": {}}

    # Out-of-range utilisation is invalid data -> fail closed. This catches
    # negative-on-both (which would otherwise read as huge headroom and
    # dispatch), >100, and NaN (every comparison against NaN is False).
    if not (0.0 <= fh_util <= 100.0 and 0.0 <= sd_util <= 100.0):
        return {"dispatch": False, "reason": "utilisation out of range", "windows": {}}

    fh_below = fh_util <= fh_ideal - margin
    sd_below = sd_util <= sd_ideal - margin
    session_ok = fh_util < session_cap
    dispatch = fh_below and sd_below and session_ok

    if dispatch:
        reason = "below both lines"
    elif not session_ok:
        reason = f"session near cap ({fh_util:.0f}% >= {session_cap:.0f}%)"
    elif not sd_below:
        reason = f"7-day at/above line ({sd_util:.0f}% vs ideal {sd_ideal:.0f}%)"
    else:
        reason = f"5-hour at/above line ({fh_util:.0f}% vs ideal {fh_ideal:.0f}%)"

    return {
        "dispatch": dispatch,
        "reason": reason,
        "windows": {
            "five_hour": {
                "util": fh_util,
                "ideal": round(fh_ideal, 1),
                "below": fh_below,
            },
            "seven_day": {
                "util": sd_util,
                "ideal": round(sd_ideal, 1),
                "below": sd_below,
            },
        },
    }


# --- Forest usage reader (live, with a fail-closed freshness check) ---------


def _classify_usage(stdout: str, now: datetime) -> tuple[dict | None, str]:
    """Parse one usage JSONL sample and classify its freshness. Pure, so it's
    unit-testable without SSH. Fail CLOSED: any uncertainty about the age or the
    shape returns something other than "fresh", so the worker holds. Returns
    (record|None, "fresh"|"stale"|"unavailable")."""
    text = (stdout or "").strip()
    if not text:
        return None, "unavailable"
    try:
        rec = json.loads(text.splitlines()[-1])
    except json.JSONDecodeError:
        return None, "unavailable"
    if not isinstance(rec, dict):  # a bare number/list/string is not a usage record
        return None, "unavailable"

    sampled = rec.get("t")
    if not sampled:  # no timestamp -> can't prove freshness -> stale, never fresh
        return rec, "stale"
    try:
        age = (now - datetime.fromisoformat(sampled)).total_seconds()
    except (ValueError, TypeError):  # garbage timestamp -> stale
        return rec, "stale"
    if (
        age > FRESH_MAX_AGE_S or age < -FRESH_MAX_AGE_S
    ):  # too old, or implausibly future
        return rec, "stale"
    return rec, "fresh"


def read_forest_usage(now: datetime | None = None) -> tuple[dict | None, str]:
    """Read the freshest Claude-usage sample from Forest and classify it. Never
    gates on a stale (outside +/- FRESH_MAX_AGE_S) or unreadable sample - the
    caller holds."""
    now = now or _now()
    date = now.strftime("%Y-%m-%d")
    env = {**os.environ, "SSH_AUTH_SOCK": f"/run/user/{os.getuid()}/keyring/ssh"}
    cmd = [
        "ssh",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=10",
        "root@forest.local",
        f"tail -1 {FOREST_USAGE_DIR}/{date}.jsonl",
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=25, env=env)
    except (subprocess.SubprocessError, OSError):
        return None, "unavailable"
    if out.returncode != 0:
        return None, "unavailable"
    return _classify_usage(out.stdout, now)


# --- Queue access + path resolution -----------------------------------------


def _queue_path() -> Path:
    return Path(
        os.environ.get(
            "SCHEDULER_QUEUE_PATH",
            str(
                Path.home()
                / ".local"
                / "share"
                / "assimilator"
                / "scheduler-queue.json"
            ),
        )
    )


def _ingests_dir() -> Path:
    return _path("INGESTS_PATH", _ANOMALICA / "ingests")


def _digests_dir() -> Path:
    return _path("DIGESTS_PATH", _ANOMALICA / "digests")


def pick_top_digest_job(exclude: set[str] | None = None) -> dict | None:
    """The highest-value eligible Claude digest job from the live queue (skipping
    any hash in `exclude`), or None."""
    try:
        queue = json.loads(_queue_path().read_text())
    except (OSError, json.JSONDecodeError):
        return None
    exclude = exclude or set()
    digests = [
        j
        for j in queue.get("jobs", [])
        if j.get("lane") == "claude"
        and j.get("type") == "digest"
        and j.get("status") == "eligible"
        and (j.get("target") or {}).get("hash") not in exclude
    ]
    digests.sort(key=lambda j: j.get("value") or -1, reverse=True)
    return digests[0] if digests else None


def is_eligible_digest(record_hash: str) -> bool:
    """True if `record_hash` is currently an eligible Claude digest job. Used as
    the post-reschedule confirmation: if a just-digested record is STILL eligible
    after a successful re-run, completion wasn't registered and we must halt
    rather than re-spend. Fail closed: an unreadable queue counts as eligible."""
    try:
        queue = json.loads(_queue_path().read_text())
    except (OSError, json.JSONDecodeError):
        return True
    for j in queue.get("jobs", []):
        if (
            j.get("lane") == "claude"
            and j.get("type") == "digest"
            and j.get("status") == "eligible"
            and (j.get("target") or {}).get("hash") == record_hash
        ):
            return True
    return False


def rerun_scheduler() -> bool:
    """Regenerate scheduler-queue.json via the assimilator's host entry point so a
    completed job drops. anomalica/assimilator confirmed the invocation:
    `python -m assimilator.scheduler` with PYTHONPATH = its workspace; it imports
    only stdlib + pyyaml, opens the DB read-only, and exits 0 ONLY on success.
    Returns True only on a confirmed exit 0 - the caller fails closed otherwise."""
    ws = _path("ASSIMILATOR_WORKSPACE", _ANOMALICA / "assimilator" / "workspace")
    env = {
        **os.environ,
        "PYTHONPATH": str(ws) + os.pathsep + os.environ.get("PYTHONPATH", ""),
    }
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "assimilator.scheduler"],
            env=env,
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
    except (subprocess.SubprocessError, OSError):
        return False
    return proc.returncode == 0


def resolve_body_path(record_hash: str) -> Path | None:
    """The record body to digest, resolved NEXT TO the review sidecar in the
    store - `store/{H}.v2.md` if present else `store/{H}.md`. NEVER via the
    records/ slug symlinks: the digester found a slug pointing at OLD unreviewed
    v1 content, so trusting it would digest unreviewed material."""
    store = _ingests_dir() / "store"
    for name in (f"{record_hash}.v2.md", f"{record_hash}.md"):
        p = store / name
        if p.exists():
            return p
    return None


def slug_for_hash(record_hash: str) -> str | None:
    """The ingester's canonical FLAT slug for a content_hash, via its records/
    symlink (whose target basename is store/{hash}.v2.md or store/{hash}.md).
    The slug is already filesystem-safe (the ingester sanitises titles, so
    `w/@NelsonDellis` becomes `w-nelsondellis`). The digest output path is keyed
    on this, NEVER on a free-text title/label - a '/' in a title would nest the
    digest in a subdirectory the scheduler's completion scan can't find, leaving
    the job eligible forever and re-spending every restart."""
    records = _ingests_dir() / "records"
    if not records.exists():
        return None
    prefix = f"{record_hash}."
    for link in records.glob("*.md"):
        try:
            target = os.readlink(link)
        except OSError:
            continue
        if os.path.basename(target).startswith(prefix):
            return re.sub(r"\.v\d+$", "", link.stem)
    return None


def digest_out_path(record_hash: str) -> Path | None:
    """Canonical digest output for a record: digests/records/<slug>.yaml, where
    <slug> is the ingester's flat records/ slug (see slug_for_hash). None if the
    record has no records/ symlink (no safe flat path -> don't write blindly)."""
    slug = slug_for_hash(record_hash)
    if slug is None:
        return None
    return _digests_dir() / "records" / f"{slug}.yaml"


def _record_version(record_hash: str) -> str | None:
    """The record's current `processing.version` from its body frontmatter - the
    freshness key the assimilator's completion contract compares against."""
    body = resolve_body_path(record_hash)
    if body is None:
        return None
    try:
        text = body.read_text()
    except OSError:
        return None
    m = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
    if not m:
        return None
    try:
        fm = yaml.safe_load(m.group(1)) or {}
    except yaml.YAMLError:
        return None
    return (fm.get("processing") or {}).get("version") if isinstance(fm, dict) else None


def current_digest_exists(record_hash: str) -> bool:
    """True if a digest on disk already covers this record at its CURRENT
    processing version. Mirrors the assimilator's completion contract (they own
    it - anomalica/assimilator): content_hash match AND (processing_version equal
    OR either side missing -> treat as current). This is the restart-proof
    re-spend guard: even if the queue is stale, an already-current digest on disk
    means we must NOT re-dispatch."""
    out = digest_out_path(record_hash)
    if out is None or not out.exists():
        return False
    try:
        digest = yaml.safe_load(out.read_text()) or {}
    except (OSError, yaml.YAMLError):
        return False
    drec = digest.get("record") or {} if isinstance(digest, dict) else {}
    dhash = (drec.get("content_hash") or "").removeprefix("sha256:")
    if dhash != record_hash:
        return False
    dver = drec.get("processing_version")
    rver = _record_version(record_hash)
    if not dver or not rver:  # version unknown either side -> missing-safe -> current
        return True
    return dver == rver


def _parse_usage(stdout: str) -> dict | None:
    """The digester CLI's last `USAGE_JSON: {...}` line - the summed token usage
    across all model calls in the job."""
    for line in reversed(stdout.splitlines()):
        if line.startswith("USAGE_JSON:"):
            try:
                return json.loads(line[len("USAGE_JSON:") :].strip())
            except json.JSONDecodeError:
                return None
    return None


def run_digest(body_path: Path, out_path: Path) -> subprocess.CompletedProcess:
    """Invoke the digester's CLI (subscription, opus). cwd = the digester
    workspace so its package imports; PYTHONPATH includes anomalica-common/src.
    Subscription is asserted BY CONSTRUCTION, not left to the inherited env:
    DIGESTER_USE_API='0' short-circuits the API toggle off and the global
    ANOMALICA_USE_API fallback is removed - there is no metered/dollar path."""
    workspace = _path("DIGESTER_WORKSPACE", _ANOMALICA / "digester" / "workspace")
    common_src = _path("ANOMALICA_COMMON_SRC", _ANOMALICA / "anomalica-common" / "src")
    env = {
        **os.environ,
        "PYTHONPATH": str(common_src) + os.pathsep + os.environ.get("PYTHONPATH", ""),
        "DIGESTER_USE_API": "0",  # explicit subscription - never metered
    }
    env.pop("ANOMALICA_USE_API", None)  # and drop the global API fallback
    out_path.parent.mkdir(parents=True, exist_ok=True)
    return subprocess.run(
        [
            "python3",
            "-m",
            "digester.cli",
            "extract",
            str(body_path),
            "-o",
            str(out_path),
            "--model",
            "opus",
        ],
        cwd=str(workspace),
        env=env,
        capture_output=True,
        text=True,
        timeout=1800,
        check=False,
    )


# --- The runner (processing-mode worker) ------------------------------------


class Runner:
    """Owns processing-mode state + the Claude worker thread. One job at a time;
    re-reads usage after each; stops when mode goes OFF. Fail-closed: if a
    completed digest can't be confirmed dropped from the queue, the worker HALTS
    (sits idle, surfaced in status) rather than risk re-spending on a stale queue
    - a halt clears only on the next OFF->ON toggle / restart."""

    def __init__(self) -> None:
        self._on = False
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._status: dict = {
            "state": "idle",
            "reason": "",
            "gate": None,
            "usage_status": None,
            "current": None,
            "checked_at": None,
        }
        self._completed: list[dict] = []
        # Hashes attempted this worker-run (success/fail/skip) so we don't re-pick
        # within the run. Reset each worker start; NOT the durable guard - the
        # durable guards are current_digest_exists() + the queue refresh.
        self._done: set[str] = set()
        # Failed-attempt counts, PERSISTED across restarts so a record that keeps
        # failing isn't re-spent on every toggle.
        self._failed: dict[str, int] = {}
        self._halted = False
        self._halt_reason = ""
        self._load()
        # NB: __init__ does NOT spawn the worker (bare imports - e.g. tests - must
        # never start it SSHing to Forest). The server calls resume_if_on() from
        # its startup hook to resume a persisted ON across a restart.

    def resume_if_on(self) -> None:
        with self._lock:
            if self._on:
                self._spawn()

    # -- persistence --
    def _file(self) -> Path:
        return _state_dir() / "processing.json"

    def _load(self) -> None:
        try:
            d = json.loads(self._file().read_text())
            self._on = bool(d.get("on"))
            self._completed = list(d.get("completed", []))[-50:]
            self._failed = {
                str(k): int(v) for k, v in dict(d.get("failed", {})).items()
            }
        except (OSError, json.JSONDecodeError, ValueError, TypeError):
            pass

    def _save(self) -> None:
        try:
            _state_dir().mkdir(parents=True, exist_ok=True)
            self._file().write_text(
                json.dumps(
                    {
                        "on": self._on,
                        "completed": self._completed[-50:],
                        "failed": self._failed,
                    }
                )
            )
        except OSError:
            pass

    # -- public API --
    def status(self) -> dict:
        with self._lock:
            return {
                "mode": "on" if self._on else "off",
                "halted": self._halted,
                **self._status,
                "completed": list(reversed(self._completed[-20:])),
            }

    def set_mode(self, on: bool) -> dict:
        with self._lock:
            changed = on != self._on
            self._on = on
            if changed:
                self._save()
            if on:
                self._spawn()
        return self.status()

    # -- internals --
    def _spawn(self) -> None:
        if self._thread is None or not self._thread.is_alive():
            self._thread = threading.Thread(target=self._run_loop, daemon=True)
            self._thread.start()

    def _set(self, **kw) -> None:
        with self._lock:
            self._status.update(kw)
            self._status["checked_at"] = _now().isoformat()

    def _is_on(self) -> bool:
        with self._lock:
            return self._on

    def _record(self, **job) -> None:
        with self._lock:
            self._completed.append(job)
            self._completed = self._completed[-50:]
            self._save()

    def _halt(self, reason: str) -> None:
        with self._lock:
            self._halted = True
            self._halt_reason = reason
        self._set(state="halted", reason=reason, current=None)

    def _sleep(self, secs: float) -> None:
        # Sleep in slices so toggling OFF is responsive.
        end = time.time() + secs
        while time.time() < end and self._is_on():
            time.sleep(min(2.0, max(0.0, end - time.time())))

    def _run_loop(self) -> None:
        with self._lock:
            self._done = set()
            self._halted = False
            self._halt_reason = ""
        while self._is_on():
            with self._lock:
                halted = self._halted
            if halted:
                self._sleep(POLL_INTERVAL_S)
                continue
            try:
                self._tick()
            except Exception as exc:  # noqa: BLE001 - a poisoned line must not silently kill the thread
                self._set(
                    state="waiting", reason=f"tick error, holding: {exc}", current=None
                )
                self._sleep(POLL_INTERVAL_S)
        self._set(state="idle", reason="processing off", current=None)

    def _tick(self) -> None:
        rec, ustat = read_forest_usage()
        if (
            rec is None or ustat != "fresh"
        ):  # fail closed on anything but a fresh sample
            self._set(
                state="waiting",
                reason=f"usage {ustat} - not gating on it",
                usage_status=ustat,
                gate=None,
                current=None,
            )
            self._sleep(POLL_INTERVAL_S)
            return
        gate = evaluate_gate(rec, _now())
        if not gate["dispatch"]:
            self._set(
                state="waiting",
                reason=gate["reason"],
                usage_status=ustat,
                gate=gate["windows"],
                current=None,
            )
            self._sleep(POLL_INTERVAL_S)
            return
        with self._lock:
            done = set(self._done)
        job = pick_top_digest_job(done)
        if job is None:
            self._set(
                state="idle",
                reason="below the line, no eligible digest jobs",
                usage_status=ustat,
                gate=gate["windows"],
                current=None,
            )
            self._sleep(POLL_INTERVAL_S)
            return
        self._execute_digest(job, gate["windows"], ustat)

    def _skip(
        self,
        h: str,
        reason: str,
        gate_windows: dict,
        ustat: str,
        state: str = "waiting",
    ) -> None:
        with self._lock:
            self._done.add(h)
        self._set(
            state=state,
            reason=reason,
            usage_status=ustat,
            gate=gate_windows,
            current=None,
        )
        self._sleep(POLL_INTERVAL_S)

    def _execute_digest(self, job: dict, gate_windows: dict, ustat: str) -> None:
        target = job.get("target", {})
        title = target.get("label") or (target.get("hash", "")[:12])
        h = target.get("hash", "")

        # content_hash guard: a non-64-char hash can never satisfy the scheduler's
        # completion check, so it would re-dispatch forever. Refuse it.
        if len(h) != 64:
            self._skip(
                h, f"skipping '{title}': no usable content_hash", gate_windows, ustat
            )
            return

        # Failed-attempt cap: don't re-spend on a record that keeps failing.
        if self._failed.get(h, 0) >= MAX_DIGEST_ATTEMPTS:
            self._skip(
                h,
                f"skipping '{title}': {self._failed[h]} failed attempts (cap reached)",
                gate_windows,
                ustat,
            )
            return

        # Restart-proof re-spend guard: if a CURRENT digest already exists on disk
        # (queue may be stale after an unconfirmed re-run), skip rather than spend.
        if current_digest_exists(h):
            self._skip(
                h,
                f"'{title}' already digested (current on disk) - skipping",
                gate_windows,
                ustat,
                state="idle",
            )
            return

        # Real execution gate (off by default). Proves the path end-to-end, spends
        # nothing - the state master/Mark verify before the supervised first run.
        if not _execute_enabled():
            self._set(
                state="ready",
                reason=f"would digest '{title}' - execution disabled (set RUNNER_EXECUTE=1)",
                usage_status=ustat,
                gate=gate_windows,
                current={"type": "digest", "target": title},
            )
            self._sleep(POLL_INTERVAL_S)
            return

        body = resolve_body_path(h)
        out = digest_out_path(h)
        if body is None or out is None:
            self._skip(
                h,
                f"no store body / records slug for '{title}' ({h[:12]})",
                gate_windows,
                ustat,
            )
            return

        start = _now()
        self._set(
            state="running",
            reason=f"digesting '{title}'",
            usage_status=ustat,
            gate=gate_windows,
            current={"type": "digest", "target": title, "started": start.isoformat()},
        )
        ok = False
        tokens = None
        err = None
        try:
            proc = run_digest(body, out)
            ok = proc.returncode == 0 and out.exists()
            usage = _parse_usage(proc.stdout or "")
            if usage:
                tokens = usage.get("output_tokens") or usage.get("total_tokens")
            if not ok:
                err = f"exit {proc.returncode}, no output written"
        except (subprocess.SubprocessError, OSError) as exc:
            err = f"digest failed: {exc}"
        end = _now()
        with self._lock:
            self._done.add(h)
            if ok:
                self._failed.pop(h, None)
            else:
                self._failed[h] = self._failed.get(h, 0) + 1
            self._save()
        self._record(
            type="digest",
            target=title,
            hash=h,
            start=start.isoformat(),
            end=end.isoformat(),
            duration_s=round((end - start).total_seconds(), 1),
            tokens=tokens,
            ok=ok,
            error=err,
        )
        self._set(current=None)
        if not ok:
            return
        # Refresh the queue so the completed job drops; FAIL CLOSED if we can't
        # confirm it - never dispatch again on a stale queue.
        if not rerun_scheduler():
            self._halt(
                "scheduler re-run failed - halting to avoid re-spend on a stale queue"
            )
            return
        if is_eligible_digest(h):
            self._halt(
                f"'{title}' still eligible after a successful digest + reschedule - "
                "halting (completion not registered)"
            )


runner = Runner()
