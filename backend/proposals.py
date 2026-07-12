"""Pending-edit proposals: a contributor's edit, queued for review.

A contributor cannot commit to main; their submit is stored here as a full
content snapshot (not a diff - robust to base drift, trivial to render: the diff
is computed at review time against the current record). A reviewer/editor
approves -> the snapshot is committed to ingests attributed to the contributor;
rejects -> the entry is dropped.

Stored one JSON file per proposal under `ingests/proposals/`. SECURITY: this
directory holds UNREVIEWED content from anyone - possibly vandalism, possibly an
edit to a gated record carrying copyrighted text. It must never be served on a
public path, and the list/read endpoints must require reviewer/editor.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path


def _dir(ingests_path: Path) -> Path:
    return ingests_path / "proposals"


def enqueue(
    ingests_path: Path,
    record_hash: str,
    content: str,
    author: dict,
    notes: str = "",
    spans: list | None = None,
    verdict: dict | None = None,
) -> dict:
    """Store a contributor's proposed edit. Returns the stored entry."""
    d = _dir(ingests_path)
    d.mkdir(parents=True, exist_ok=True)
    pid = uuid.uuid4().hex
    entry = {
        "id": pid,
        "record_hash": record_hash,
        "content": content,
        "author_login": author.get("login", ""),
        "author_name": author.get("name", ""),
        "author_email": author.get("email", ""),
        "notes": notes,
        "spans": spans or [],
        "verdict": verdict,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": "pending",
    }
    (d / f"{pid}.json").write_text(json.dumps(entry, indent=2))
    return entry


def _read(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def list_pending(ingests_path: Path) -> list[dict]:
    """Every pending proposal, oldest first. Content is omitted from the summary
    (the diff is fetched per-proposal); returns metadata only."""
    d = _dir(ingests_path)
    if not d.is_dir():
        return []
    out = []
    for p in sorted(d.glob("*.json")):
        e = _read(p)
        if e and e.get("status") == "pending":
            out.append({k: v for k, v in e.items() if k != "content"})
    out.sort(key=lambda e: e.get("created_at", ""))
    return out


def get(ingests_path: Path, pid: str) -> dict | None:
    """A single proposal (full content included), or None."""
    if not _valid_id(pid):
        return None
    p = _dir(ingests_path) / f"{pid}.json"
    return _read(p) if p.is_file() else None


def remove(ingests_path: Path, pid: str) -> bool:
    """Delete a proposal file (on approve or reject). True if it existed."""
    if not _valid_id(pid):
        return False
    p = _dir(ingests_path) / f"{pid}.json"
    if p.is_file():
        p.unlink()
        return True
    return False


def count_pending(ingests_path: Path) -> int:
    return len(list_pending(ingests_path))


def _valid_id(pid: str) -> bool:
    """A proposal id is a uuid4 hex - reject anything else so the id can't be a
    path traversal into the store."""
    return (
        isinstance(pid, str)
        and len(pid) == 32
        and all(c in "0123456789abcdef" for c in pid)
    )
