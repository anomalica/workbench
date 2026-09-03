"""Record tags: a reviewer asserts that a record is ABOUT a subject.

The pipeline links two records only through a named entity they share. Two
records about the same UNNAMED thing stay apart - claim similarity finds nothing
when they share no wording, and name matching cannot separate a real pair from
house-style noise. The residue is a link a person has to assert, and this is
where they assert it.

The write side only. The assimilator owns the operation (`assimilator/tags.py`):
we append the entry to the curation ledger and run its `apply-tags`, which
resolves the subject by name and alias, resolves the record by content hash, and
records what happened. Two files, two jobs, and the reason is the same one that
governs merges and renames: the workbench holds the graph READ-ONLY, and a row
written straight into the database would not survive a rebuild - the graph is
re-imported from the digests and only the ledger is replayed.

READING BACK IS NOT OPTIONAL. A tag can legitimately end `pending` - a record
that has not been digested yet has no graph row to attach to, and on 2026-09-03
that was 210 of the 319 records in the store - and a reviewer who asserted a
link is owed that answer rather than a row that silently is not there. So the
LEDGER is what a record's tags are read from, and `record_tags` says what became
of each one; reading the table alone would lose every pending tag, because a
pending tag has no record row to key on.
"""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

import yaml

from backend import graph

_ANOMALICA = Path(__file__).resolve().parents[2]
_ASSIMILATOR_WS = _ANOMALICA / "assimilator" / "workspace"
_COMMON_SRC = _ANOMALICA / "anomalica-common" / "src"


def tags_path() -> Path:
    base = Path(os.environ.get("ANOMALICA_CURATION_DIR", str(_ANOMALICA / "curation")))
    return base / "tags.yaml"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _prefixed(content_hash: str) -> str:
    """The form `records.content_hash` holds. The workbench keys everything on
    the bare digest (the store filename, every ingest route); the graph stores it
    prefixed. The assimilator accepts either, so this is about not making the
    ledger a third spelling."""
    h = content_hash.strip()
    return h if h.startswith("sha256:") else f"sha256:{h}"


def _append(entry: dict) -> None:
    path = tags_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        f.write("---\n" + yaml.safe_dump(entry, sort_keys=False, allow_unicode=True))


def read_ledger() -> list[dict]:
    """Every entry, oldest first. Absent file is an empty list."""
    path = tags_path()
    if not path.is_file():
        return []
    try:
        return [d for d in yaml.safe_load_all(path.read_text()) if isinstance(d, dict)]
    except yaml.YAMLError:
        return []


def _outcomes(tag_ids: list[str]) -> dict[str, dict]:
    """What the assimilator recorded for each tag, keyed by tag_id."""
    if not tag_ids:
        return {}
    con = graph._open()
    if con is None:
        return {}
    try:
        placeholders = ",".join("?" * len(tag_ids))
        rows = con.execute(
            "SELECT t.tag_id, t.status, t.reason, t.undone_at, n.name, n.node_type"
            f" FROM record_tags t LEFT JOIN nodes n ON n.id = t.node_id"
            f" WHERE t.tag_id IN ({placeholders})",
            tag_ids,
        ).fetchall()
    except sqlite3.OperationalError:
        # A graph built before tags existed has no such table - which means no
        # tag has been applied, not that the tags are gone.
        return {}
    finally:
        con.close()
    return {
        r[0]: {
            "status": r[1],
            "reason": r[2],
            "undone_at": r[3],
            "resolved_name": r[4],
            "resolved_type": r[5],
        }
        for r in rows
    }


def tags_for_record(content_hash: str) -> list[dict]:
    """A record's live tags, newest last, each with what became of it.

    Read from the LEDGER and joined to the outcome, never the other way round: a
    tag on a record the pipeline has not digested yet is pending and has no row
    keyed to that record, so a table-first read would show a reviewer nothing
    where they had just asserted something.
    """
    wanted = {_prefixed(content_hash), content_hash.strip()}
    untagged: set[str] = set()
    entries: dict[str, dict] = {}
    for e in read_ledger():
        op = e.get("op")
        tag_id = e.get("tag_id")
        if not tag_id:
            continue
        if op == "untag":
            untagged.add(tag_id)
            continue
        if op != "tag":
            continue
        if ((e.get("record") or {}).get("content_hash") or "").strip() not in wanted:
            continue
        node = e.get("node") or {}
        entries[tag_id] = {
            "tag_id": tag_id,
            "name": node.get("name"),
            "node_type": node.get("node_type"),
            "note": e.get("note"),
            "at": e.get("at"),
            "by": e.get("by"),
        }
    live = {k: v for k, v in entries.items() if k not in untagged}
    outcomes = _outcomes(list(live))
    for tag_id, row in live.items():
        o = outcomes.get(tag_id) or {}
        # No row yet means apply-tags has not run over it, which is pending in
        # every sense that matters to a reviewer.
        row["status"] = o.get("status") or "pending"
        row["reason"] = o.get("reason")
        # The name the tag RESOLVED to, when it differs from the name typed -
        # the subject was renamed or merged since, and saying so beats showing a
        # name that no longer exists.
        row["resolved_name"] = o.get("resolved_name")
    return sorted(live.values(), key=lambda r: r["at"] or "")


def _apply() -> subprocess.CompletedProcess:
    """Land the ledger live. Exits non-zero only when an entry is LOST, which is
    another entry's problem, not this call's - the outcome is read per tag."""
    env = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join(
            [str(_ASSIMILATOR_WS), str(_COMMON_SRC), os.environ.get("PYTHONPATH", "")]
        ),
    }
    return subprocess.run(
        [
            sys.executable,
            "-m",
            "assimilator.cli",
            "--db",
            os.environ.get("GRAPH_DB_PATH", str(graph.graph_db_path())),
            "apply-tags",
        ],
        capture_output=True,
        text=True,
        timeout=300,
        env=env,
    )


def _record_title(content_hash: str) -> str | None:
    """The record's title, for audit only - the tag never resolves on it."""
    con = graph._open()
    if con is None:
        return None
    try:
        row = con.execute(
            "SELECT title FROM records WHERE content_hash IN (?, ?)",
            (_prefixed(content_hash), content_hash.strip()),
        ).fetchone()
    except sqlite3.OperationalError:
        return None
    finally:
        con.close()
    return row[0] if row else None


def add_tag(
    content_hash: str,
    node_name: str,
    node_type: str,
    note: str | None,
    by: str | None,
) -> dict:
    """Assert that a record is about a subject.

    A name with no node behind it is only created when the type is `topic` - a
    subject heading a person is entitled to name into existence. Any other type
    that matches nothing stays pending rather than minting a second person from
    a misspelling; that guard is the assimilator's, and this does not duplicate
    it, it just does not fight it.
    """
    name = (node_name or "").strip()
    if not name:
        raise ValueError("A subject name is required")
    if not (content_hash or "").strip():
        raise ValueError("A record is required")
    node_type = (node_type or "topic").strip() or "topic"

    entry = {
        "op": "tag",
        "tag_id": str(uuid.uuid4()),
        "at": _now(),
        "by": by or "workbench",
        "node": {"name": name, "node_type": node_type, "prior_names": []},
        "record": {
            "content_hash": _prefixed(content_hash),
            "title": _record_title(content_hash),
        },
        "note": (note or "").strip() or None,
    }
    _append(entry)
    r = _apply()
    outcome = _outcomes([entry["tag_id"]]).get(entry["tag_id"]) or {}
    status = outcome.get("status") or "pending"
    return {
        "ok": status in ("applied", "pending"),
        "tag_id": entry["tag_id"],
        "status": status,
        "reason": outcome.get("reason")
        or (r.stderr.strip()[-200:] if r.returncode else None),
        "name": name,
        "node_type": node_type,
        "resolved_name": outcome.get("resolved_name"),
    }


def remove_tag(tag_id: str, by: str | None) -> dict:
    """Undo a tag. A compensating entry, never a deletion: what was asserted, and
    that it was withdrawn, both stay in the record."""
    tag_id = (tag_id or "").strip()
    if not tag_id:
        raise ValueError("A tag is required")
    _append({"op": "untag", "tag_id": tag_id, "at": _now(), "by": by or "workbench"})
    r = _apply()
    if r.returncode != 0 and "lost" not in (r.stdout or "").lower():
        raise RuntimeError(r.stderr.strip()[-400:] or "untag failed")
    return {"ok": True, "tag_id": tag_id}
