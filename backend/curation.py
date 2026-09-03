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
import re
import os
import subprocess
import sys
from pathlib import Path

from backend import graph

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


def manual_candidates_path() -> Path:
    """Human/manually-decomposed candidates, SEPARATE from propose_merges'
    output because that file is REGENERATED - anything appended to it is
    clobbered on the next run. This one is only ever written deliberately
    (e.g. the assimilator's referenced-source consolidation proposals), so it
    survives regeneration. Same directory as the main file by default."""
    return _path(
        "ANOMALICA_MERGE_CANDIDATES_MANUAL",
        candidates_path().with_name("merge-candidates-manual.json"),
    )


def _read_candidate_file(path: Path) -> list[dict]:
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(data, list):
        return []
    # A candidate needs at least two nodes to be a merge at all.
    return [
        c
        for c in data
        if isinstance(c, dict)
        and isinstance(c.get("node_ids"), list)
        and len(c["node_ids"]) >= 2
    ]


def _origin(candidate: dict) -> str:
    """Who proposed it. A machine-written entry names its pass in the reason's
    first word ("import:", "verify:"); a reviewer's own carries no such tag or
    says "manual:". The tag is what earns an entry the manual ordering, so a
    machine's pass must never be read as a person."""
    reason = str(candidate.get("reason") or "")
    m = re.match(r"([a-z]+):", reason)
    return m.group(1) if m and m.group(1) != "manual" else "manual"


def read_candidates() -> list[dict]:
    """The pre-vetted merge candidates (JSON lists, scheduler-style). Each:
    {node_ids, suggested_canonical, score, node_type, reason}. Absent or
    unreadable files -> [] (the assimilator may not have emitted them yet).

    Manual candidates come FIRST (a reviewer-authored proposal outranks the
    machine's duplicate of it - its reason carries the human verification) and
    dedup by cluster key, so propose_merges later re-proposing the same cluster
    doesn't queue it twice. EVERY candidate from either file is review-only:
    score is display data, and the sole apply path is a reviewer's explicit
    merge click (apply_merge). Nothing here auto-applies at any score."""
    # The file is no longer only human-authored: the assimilator's import
    # appends an entry when a node it mints shares a name with a live node of
    # another type, with a reason beginning "import:". Tagging those "manual"
    # would call a machine proposal a reviewer's verification, which is the
    # one thing the ordering below relies on the tag to mean.
    tagged = [
        {**c, "source": _origin(c)}
        for c in _read_candidate_file(manual_candidates_path())
    ]
    # Only a reviewer's own entry leads. The machine passes that now write to
    # the same file (verify, import) are a shortlist, not a person's word:
    # nine in ten right, and 246 of them ahead of everything would bury the
    # few human proposals. They sit with the rules' candidates, by score.
    human = [c for c in tagged if c["source"] == "manual"]
    machine = {
        candidate_key(c["node_ids"]): c for c in tagged if c["source"] != "manual"
    }
    lead = {candidate_key(c["node_ids"]) for c in human}
    for c in _read_candidate_file(candidates_path()):
        key = candidate_key(c["node_ids"])
        if key in lead:
            continue
        held = machine.get(key)
        if held is None:
            machine[key] = {**c, "source": "rules"}
        elif held["source"] == "rules":
            # The rules file lists the pair twice (its passes overlap). One
            # entry, the higher score; a rules score beside a rules score
            # would read as two signals agreeing when it is one, twice.
            if (c.get("score") or 0) > (held.get("score") or 0):
                machine[key] = {**c, "source": "rules"}
        else:
            # A judged entry and the rules both surfaced the pair. Keep the
            # judgement's reason and carry the rules' score beside it: two
            # independent signals, and a reviewer benefits from seeing whether
            # they agree.
            machine[key] = {**held, "rule_score": c.get("score")}
    ranked = sorted(machine.values(), key=lambda c: -(c.get("score") or 0))
    return human + ranked


def _run(module: str, args: list[str]) -> dict:
    """Shell an assimilator host command (writes the live DB). Returns
    {ok: bool, error?: str}. Fail-closed: any non-zero exit / failure is ok=False.

    The database is passed EXPLICITLY. Without it the command falls back to the
    assimilator's own default path, which is not necessarily the one the
    workbench reads (GRAPH_DB_PATH) - so a run pointed at a copy of the graph
    read from the copy and wrote the real one. It silently did.
    """
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
            [
                sys.executable,
                "-m",
                f"assimilator.{module}",
                "--db",
                str(graph.graph_db_path()),
                *args,
            ],
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


def apply_merge(
    survivor_id: str,
    victim_ids: list[str],
    canonical_name: str,
    by: str | None = None,
) -> dict:
    """Merge victims into the survivor under canonical_name. Validated here;
    the assimilator does the re-pointing + records the reversible merge-log row."""
    if not survivor_id or not victim_ids or not canonical_name:
        return {
            "ok": False,
            "error": "survivor_id, victim_ids and canonical_name are required",
        }
    if survivor_id in victim_ids:
        return {"ok": False, "error": "survivor cannot also be a victim"}
    return _run(
        "merge",
        [
            "--survivor",
            survivor_id,
            "--victims",
            ",".join(victim_ids),
            "--name",
            canonical_name,
            *(["--by", by] if by else []),
        ],
    )


def undo_merge(merge_id: str) -> dict:
    """Reverse a merge by its merge_id (restores victims, re-points claims back)."""
    if not merge_id:
        return {"ok": False, "error": "merge_id is required"}
    return _run("merge", ["--undo", merge_id])


def candidate_key(node_ids) -> str:
    """A stable key for a candidate cluster (its sorted node ids), for matching a
    candidate against the rejections ledger."""
    return ",".join(sorted(str(i) for i in node_ids if i))


def rejected_keys() -> set:
    """Candidate keys the human marked 'not a duplicate', read from the derived
    node_rejections table (the durable rejections.yaml ledger's queryable view).
    Used to filter the queue so a rejected cluster never re-shows."""
    return {candidate_key(r["node_ids"]) for r in graph.list_rejections()}


def enriched_candidates() -> list[dict]:
    """The AI-proposed merge candidates enriched with each member's
    {id, name, node_type, claims}, with already-DECIDED clusters filtered out: a
    merged cluster has a retired member; a rejected cluster is in the rejections
    ledger. (Skip stays transient + client-side, so skipped candidates may
    return.) Shared by the /api/curation/candidates endpoint and the pre-render."""
    raw = read_candidates()
    all_ids = {nid for c in raw for nid in c.get("node_ids", [])}
    brief = graph.nodes_brief(all_ids)
    retired = graph.retired_node_ids(all_ids)
    rejected = rejected_keys()
    return [
        {**c, "members": [brief[i] for i in c.get("node_ids", []) if i in brief]}
        for c in raw
        if not any(nid in retired for nid in c.get("node_ids", []))
        and candidate_key(c.get("node_ids", [])) not in rejected
    ]


def reject(node_ids: list[str], reason: str = "", by: str = "") -> dict:
    """Record a durable 'these are distinct' rejection via the assimilator's reject
    command (writes rejections.yaml + the node_rejections table). Fail-closed."""
    if not node_ids or len(node_ids) < 2:
        return {
            "ok": False,
            "error": "need at least two node ids to reject as distinct",
        }
    return _run(
        "reject",
        [
            "--nodes",
            ",".join(node_ids),
            "--reason",
            reason or "marked not a duplicate in the workbench",
            "--by",
            by or "workbench",
        ],
    )
