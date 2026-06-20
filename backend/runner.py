"""Runner / processing-mode service.

Works the scheduler queue while processing mode is ON, then idles. Subscription
ONLY - `claude -p`, never a metered/dollar path. The DUAL-TREND usage gate IS the
spend-pacing: a Claude job dispatches only when usage is below the trend line on
BOTH the 5-hour session and the 7-day all-models window. See
anomalica/master/.ai/specs/runner-design.md.

Phase 1: the Claude worker + the gate + the digest executor + recently-completed
stats. The gate is pure and exhaustively tested - it's the safety-critical part
(a bug here would burn the weekly rate-limit the whole fleet shares).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

FIVE_HOUR_S = 5 * 3600
SEVEN_DAY_S = 7 * 86400

# Gate tuning.
MARGIN_PCT = 3.0  # stay this many points below the line before dispatching
SESSION_CAP_PCT = 90.0  # never dispatch if the 5h session is already this high
FRESH_MAX_AGE_S = 20 * 60  # usage older than this is stale - never gate on it
POLL_INTERVAL_S = 90  # re-check cadence while waiting at/above the line

DEFAULT_STATE_DIR = Path.home() / ".local" / "share" / "anomalica-workbench"
FOREST_USAGE_DIR = "/var/lib/forest/bronze/claude-usage"

# The Anomalica repos sit beside the workbench: .../anomalica/{workbench,ingests,
# digests,digester,anomalica-common}. runner.py is .../workbench/backend/runner.py.
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
    (0-100). Malformed/missing usage -> no dispatch (safe default)."""
    try:
        fh = usage["five_hour"]
        sd = usage["seven_day"]
        fh_util = float(fh["utilization"])
        sd_util = float(sd["utilization"])
        fh_ideal = window_ideal_pct(fh["resets_at"], FIVE_HOUR_S, now)
        sd_ideal = window_ideal_pct(sd["resets_at"], SEVEN_DAY_S, now)
    except (KeyError, TypeError, ValueError):
        return {"dispatch": False, "reason": "usage unreadable", "windows": {}}

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


# --- Forest usage reader (live, with a freshness check) ---------------------


def read_forest_usage(now: datetime | None = None) -> tuple[dict | None, str]:
    """Read the freshest Claude-usage sample from Forest. Returns (record,
    status) where status is "fresh" / "stale" / "unavailable". Never gates on a
    stale (older than FRESH_MAX_AGE_S) or missing sample - the caller waits."""
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
    if out.returncode != 0 or not out.stdout.strip():
        return None, "unavailable"
    try:
        rec = json.loads(out.stdout.strip().splitlines()[-1])
    except json.JSONDecodeError:
        return None, "unavailable"

    sampled = rec.get("t")
    if sampled:
        try:
            age = (now - datetime.fromisoformat(sampled)).total_seconds()
            if age > FRESH_MAX_AGE_S:
                return rec, "stale"
        except ValueError:
            pass
    return rec, "fresh"


# --- Queue access + executors ----------------------------------------------

import shlex  # noqa: E402


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


def rerun_scheduler() -> None:
    """Re-enumerate the queue after a job completes (a completion unlocks the
    next stage). The assimilator owns the command (`assimilator schedule`)."""
    cmd = os.environ.get("RUNNER_SCHEDULE_CMD", "assimilator schedule")
    try:
        subprocess.run(shlex.split(cmd), capture_output=True, timeout=120, check=False)
    except (subprocess.SubprocessError, OSError):
        pass


def resolve_body_path(record_hash: str) -> Path | None:
    """The record body to digest, resolved NEXT TO the review sidecar in the
    store - `store/{H}.v2.md` if present else `store/{H}.md`. NEVER via the
    records/ slug symlinks: the digester found a slug pointing at OLD unreviewed
    v1 content, so trusting it would digest unreviewed material."""
    store = _path("INGESTS_PATH", _ANOMALICA / "ingests") / "store"
    for name in (f"{record_hash}.v2.md", f"{record_hash}.md"):
        p = store / name
        if p.exists():
            return p
    return None


def digest_out_path(job_label: str) -> Path:
    """Canonical digest output: digests/records/<friendly>.yaml, where friendly
    is the job's slug label minus any version suffix (matches the existing
    digest naming, e.g. ...ep-87.v2 -> ...ep-87.yaml)."""
    friendly = re.sub(r"\.v\d+$", "", job_label)
    return (
        _path("DIGESTS_PATH", _ANOMALICA / "digests") / "records" / f"{friendly}.yaml"
    )


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
    workspace so its package imports; PYTHONPATH includes anomalica-common/src;
    DIGESTER_USE_API left unset (subscription, zero dollars)."""
    workspace = _path("DIGESTER_WORKSPACE", _ANOMALICA / "digester" / "workspace")
    common_src = _path("ANOMALICA_COMMON_SRC", _ANOMALICA / "anomalica-common" / "src")
    env = {
        **os.environ,
        "PYTHONPATH": str(common_src) + os.pathsep + os.environ.get("PYTHONPATH", ""),
    }
    env.pop("DIGESTER_USE_API", None)  # subscription default, never metered
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
    re-reads usage after each; stops when mode goes OFF."""

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
        # Hashes attempted this worker-run, so we never re-pick (and re-spend on)
        # a record before the scheduler re-run drops it from the queue. Reset each
        # time the worker starts (toggle OFF then ON re-attempts a failed record).
        self._done: set[str] = set()
        self._load()
        # NB: __init__ does NOT spawn the worker (bare imports - e.g. tests -
        # must never start it SSHing to Forest). The server calls resume_if_on()
        # from its startup hook to resume a persisted ON across a restart.

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
        except (OSError, json.JSONDecodeError):
            pass

    def _save(self) -> None:
        try:
            _state_dir().mkdir(parents=True, exist_ok=True)
            self._file().write_text(
                json.dumps({"on": self._on, "completed": self._completed[-50:]})
            )
        except OSError:
            pass

    # -- public API --
    def status(self) -> dict:
        with self._lock:
            return {
                "mode": "on" if self._on else "off",
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

    def _run_loop(self) -> None:
        with self._lock:
            self._done = set()
        while self._is_on():
            rec, ustat = read_forest_usage()
            if rec is None or ustat == "stale":
                self._set(
                    state="waiting",
                    reason=f"usage {ustat} - not gating on it",
                    usage_status=ustat,
                    gate=None,
                    current=None,
                )
                self._sleep(POLL_INTERVAL_S)
                continue
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
                continue
            with self._lock:
                done = set(self._done)
            job = pick_top_digest_job(done)
            if job is None:
                self._set(
                    state="idle",
                    reason="below the line, but no eligible digest jobs",
                    usage_status=ustat,
                    gate=gate["windows"],
                    current=None,
                )
                self._sleep(POLL_INTERVAL_S)
                continue
            self._execute_digest(job, gate["windows"], ustat)
        self._set(state="idle", reason="processing off", current=None)

    def _sleep(self, secs: float) -> None:
        # Sleep in slices so toggling OFF is responsive.
        end = time.time() + secs
        while time.time() < end and self._is_on():
            time.sleep(min(2.0, max(0.0, end - time.time())))

    def _execute_digest(self, job: dict, gate_windows: dict, ustat: str) -> None:
        target = job.get("target", {})
        title = target.get("label") or (target.get("hash", "")[:12])
        record_hash = target.get("hash", "")

        # Real execution is OFF by default. With it off the worker still proves
        # the gate end-to-end (picks the top job, reports it) but spends nothing -
        # this is the state master/Mark verify before the first supervised run.
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

        body = resolve_body_path(record_hash)
        if body is None:
            # No store body to digest. Skip it this run so we don't spin on it.
            with self._lock:
                self._done.add(record_hash)
            self._set(
                state="waiting",
                reason=f"no store body for '{title}' (looked for {record_hash[:12]}.v2.md/.md)",
                usage_status=ustat,
                gate=gate_windows,
                current=None,
            )
            self._sleep(POLL_INTERVAL_S)
            return

        out = digest_out_path(title)
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
        try:
            proc = run_digest(body, out)
            ok = proc.returncode == 0 and out.exists()
            usage = _parse_usage(proc.stdout or "")
            if usage:
                tokens = usage.get("output_tokens") or usage.get("total_tokens")
            if not ok:
                self._set(reason=f"digest exit {proc.returncode}, no output written")
        except (subprocess.SubprocessError, OSError) as exc:
            self._set(reason=f"digest failed: {exc}")
        end = _now()
        # Mark attempted (success OR fail) so this run won't re-pick and re-spend
        # on it; a successful digest is dropped by the scheduler re-run below, a
        # failed one waits for the next worker start (no in-run retry by design).
        with self._lock:
            self._done.add(record_hash)
        self._record(
            type="digest",
            target=title,
            hash=record_hash,
            start=start.isoformat(),
            end=end.isoformat(),
            duration_s=round((end - start).total_seconds(), 1),
            tokens=tokens,
            ok=ok,
        )
        self._set(current=None)
        if ok:
            rerun_scheduler()


runner = Runner()
