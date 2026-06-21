"""Graph-curation write side: read the AI-proposed merge candidates and apply /
undo merges via the assimilator's host command.

Reads are read-only (the candidates JSON file; node_merges via backend.graph).
Writes shell `python -m assimilator.merge` - the assimilator owns the live-DB
mutation, the workbench just invokes it and reports the result. A merge re-points
a victim's claims/speaker/producer onto the survivor and is reversible by
merge_id; see the assimilator's contract.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

# .../anomalica/{workbench,assimilator,anomalica-common}; this is workbench/backend/.
_ANOMALICA = Path(__file__).resolve().parents[2]


def _path(env: str, default: Path) -> Path:
    return Path(os.environ.get(env, str(default)))


def candidates_path() -> Path:
    # ANOMALICA_MERGE_CANDIDATES is the assimilator's own output-path env, so the
    # workbench follows wherever propose_merges writes; same default path.
    return _path(
        "ANOMALICA_MERGE_CANDIDATES",
        Path.home() / ".local" / "share" / "assimilator" / "merge-candidates.json",
    )


def read_candidates() -> list[dict]:
    """The AI-proposed, pre-vetted merge candidates (a JSON list, scheduler-style).
    Each: {node_ids, suggested_canonical, score, node_type, reason}. Absent or
    unreadable file -> [] (the assimilator may not have emitted it yet)."""
    try:
        data = json.loads(candidates_path().read_text())
    except (OSError, json.JSONDecodeError):
        return []
    return data if isinstance(data, list) else []


def _run_merge(args: list[str]) -> dict:
    """Shell the assimilator's merge command (writes the live DB). Returns
    {ok: bool, error?: str}. Fail-closed: any non-zero exit / failure is ok=False."""
    ws = _path("ASSIMILATOR_WORKSPACE", _ANOMALICA / "assimilator" / "workspace")
    common = _path("ANOMALICA_COMMON_SRC", _ANOMALICA / "anomalica-common" / "src")
    env = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join(
            [str(ws), str(common), os.environ.get("PYTHONPATH", "")]
        ),
    }
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "assimilator.merge", *args],
            env=env,
            capture_output=True,
            text=True,
            timeout=300,
            check=False,
        )
    except (subprocess.SubprocessError, OSError) as exc:
        return {"ok": False, "error": str(exc)}
    if proc.returncode != 0:
        msg = (proc.stderr or proc.stdout or f"exit {proc.returncode}").strip()
        return {"ok": False, "error": msg[:500]}
    return {"ok": True}


def apply_merge(survivor_id: str, victim_ids: list[str], canonical_name: str) -> dict:
    """Merge victims into the survivor under canonical_name. Validated here;
    the assimilator does the re-pointing + records the reversible merge-log row."""
    if not survivor_id or not victim_ids or not canonical_name:
        return {
            "ok": False,
            "error": "survivor_id, victim_ids and canonical_name are required",
        }
    if survivor_id in victim_ids:
        return {"ok": False, "error": "survivor cannot also be a victim"}
    return _run_merge(
        [
            "--survivor",
            survivor_id,
            "--victims",
            ",".join(victim_ids),
            "--name",
            canonical_name,
        ]
    )


def undo_merge(merge_id: str) -> dict:
    """Reverse a merge by its merge_id (restores victims, re-points claims back)."""
    if not merge_id:
        return {"ok": False, "error": "merge_id is required"}
    return _run_merge(["--undo", merge_id])
