"""One page covering several subjects.

UAP and UFO are the same phenomenon under two vocabularies, and a reader cannot
tell which page to read. MERGING the two nodes is the wrong fix: they share only
26 claims of 2,068, and folding them together would destroy which word each
source used - which is the evidence for when the terminology changed and who
changed it. So the nodes stay separate and one PAGE covers both, with the
members' claims unioned when the brief is built.

It generalises past that pair: any two subjects a reader would look for in one
place and the graph holds under two names.

The write side only, and the pattern is the one merges, renames and tags follow:
the workbench appends to the curation ledger and the assimilator applies and
replays it, because the workbench holds the graph READ-ONLY and a row written
into the database would not survive a rebuild. Members are keyed on natural
identity - name and type, never ids, which are minted fresh per extraction.

The op suppresses its members' separate page proposals itself, so composing
writes no vetoes and decomposing needs nothing undone.
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


def compositions_path() -> Path:
    base = Path(os.environ.get("ANOMALICA_CURATION_DIR", str(_ANOMALICA / "curation")))
    return base / "pages.yaml"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _append(entry: dict) -> None:
    path = compositions_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        f.write("---\n" + yaml.safe_dump(entry, sort_keys=False, allow_unicode=True))


def read_ledger() -> list[dict]:
    path = compositions_path()
    if not path.is_file():
        return []
    try:
        return [d for d in yaml.safe_load_all(path.read_text()) if isinstance(d, dict)]
    except yaml.YAMLError:
        return []


def _members_of(node_ids: list[str]) -> list[dict]:
    """Each node as the natural key the ledger stores: name and type, with the
    aliases it already answers to. Ids are read here and thrown away - they are
    minted fresh by every extraction, so a page keyed on them would replay onto
    nothing after a rebuild."""
    con = graph._open()
    if con is None:
        return []
    out: list[dict] = []
    try:
        for nid in node_ids:
            row = con.execute(
                "SELECT name, node_type FROM nodes WHERE id = ? AND retired_at IS NULL",
                (nid,),
            ).fetchone()
            if row is None:
                continue
            aliases = [
                r[0]
                for r in con.execute(
                    "SELECT alias FROM aliases WHERE node_id = ?", (nid,)
                )
            ]
            out.append(
                {
                    "name": row[0],
                    "node_type": row[1],
                    # What it used to be called, so a member renamed between
                    # writing and replay still resolves.
                    "prior_names": [a for a in aliases if a != row[0]],
                }
            )
    except sqlite3.OperationalError:
        return []
    finally:
        con.close()
    return out


def _apply() -> subprocess.CompletedProcess:
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
            "apply-pages",
        ],
        capture_output=True,
        text=True,
        timeout=300,
        env=env,
    )


def _absent_table(exc: sqlite3.OperationalError) -> bool:
    """A graph built before compositions existed has no such table - which means
    none have been composed. ANY other operational error is a real one and must
    surface: a column that has been renamed under us reads exactly like "no
    outcome", and reporting that as a failed composition when the assimilator
    said it composed the page is the worst of both."""
    return "no such table" in str(exc).lower()


def _outcome(page_id: str) -> dict | None:
    """What the assimilator recorded: the page, which members landed on it, and
    which member pages it superseded. A member that no longer resolves is DROPPED
    rather than failing the page, so what came back is the answer to "did all of
    them make it"."""
    con = graph._open()
    if con is None:
        return None
    try:
        page = con.execute(
            "SELECT name, slug, node_type FROM pages WHERE page_id = ?",
            (page_id,),
        ).fetchone()
        if page is None:
            return None
        members = [
            r[0]
            for r in con.execute(
                "SELECT n.name FROM page_members m JOIN nodes n ON n.id = m.node_id"
                " WHERE m.page_id = ? ORDER BY m.position",
                (page_id,),
            )
        ]
        # The member pages this one takes over from. They come down at the next
        # assembly; naming them is how a reviewer knows what happened to the page
        # that is not the survivor.
        superseded = [
            f"{r[0]}/{r[1]}"
            for r in con.execute(
                "SELECT section, slug FROM superseded_pages WHERE page_id = ?",
                (page_id,),
            )
        ]
    except sqlite3.OperationalError as exc:
        if _absent_table(exc):
            return None
        raise
    finally:
        con.close()
    return {
        "name": page[0],
        "slug": page[1],
        "node_type": page[2],
        "members": members,
        "superseded": superseded,
    }


def compose(
    name: str,
    node_ids: list[str],
    note: str | None,
    by: str | None,
    confirmed_by: str | None = None,
) -> dict:
    """Cover several subjects with one page.

    The page carries its own name, defaulted in the UI to the heaviest member's
    but free: "UFOs and UAPs" may be a better page name than either of them, and
    forcing a member's name forecloses that. The name sets the slug, so it also
    decides which member's existing page survives untouched.
    """
    name = (name or "").strip()
    if not name:
        raise ValueError("The page needs a name")
    if len(node_ids) < 2:
        raise ValueError("A page covers at least two subjects")

    members = _members_of(node_ids)
    if len(members) < 2:
        raise ValueError("At least two of those subjects no longer resolve")

    now = _now()
    entry = {
        "op": "compose",
        "page_id": str(uuid.uuid4()),
        "at": now,
        "by": by or "workbench",
        "page": {"name": name, "node_type": members[0]["node_type"]},
        "members": members,
        "note": (note or "").strip() or None,
    }
    if confirmed_by:
        # A composition takes member pages down, so it is the same class of
        # change as a merge and carries the same record: who confirmed it, when,
        # and through which control. The assimilator refuses an entry without
        # one, and replay skips a post-rule entry that lacks it - so the
        # confirmation must be the person who clicked, never this process.
        entry["confirmation"] = {
            "by": confirmed_by,
            "at": now,
            "via": "workbench-compose",
        }
    _append(entry)
    r = _apply()
    outcome = _outcome(entry["page_id"])
    if outcome is None:
        raise RuntimeError(
            r.stderr.strip()[-400:]
            or r.stdout.strip()[-400:]
            or "the page was not composed"
        )
    return {
        "ok": True,
        "page_id": entry["page_id"],
        "name": outcome["name"],
        "slug": outcome["slug"],
        "members": outcome["members"],
        # Said plainly rather than left to be noticed: a member that no longer
        # resolves is dropped, and the page is composed of the rest.
        "dropped": [m["name"] for m in members if m["name"] not in outcome["members"]],
        # The member pages this one takes over from - they come down at the next
        # assembly, and a reviewer should not have to find that out later.
        "superseded": outcome["superseded"],
    }


def decompose(page_id: str, by: str | None) -> dict:
    """Take a composed page apart. A compensating entry, never a deletion: the
    members go back to being proposed separately on their own evidence."""
    page_id = (page_id or "").strip()
    if not page_id:
        raise ValueError("A page is required")
    _append(
        {"op": "decompose", "page_id": page_id, "at": _now(), "by": by or "workbench"}
    )
    r = _apply()
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[-400:] or "the page was not decomposed")
    return {"ok": True, "page_id": page_id}


def list_compositions() -> list[dict]:
    """Live composed pages with their members, for the list to show as one row
    rather than as its members."""
    con = graph._open()
    if con is None:
        return []
    try:
        # Every row in `pages` is live: the assimilator rebuilds both tables from
        # the ledger on each apply, so a decomposed page is simply absent.
        rows = con.execute(
            "SELECT p.page_id, p.name, p.slug, p.node_type, n.name, m.node_id"
            " FROM pages p LEFT JOIN page_members m ON m.page_id = p.page_id"
            " LEFT JOIN nodes n ON n.id = m.node_id"
            " ORDER BY p.created_at DESC, m.position"
        ).fetchall()
    except sqlite3.OperationalError as exc:
        if _absent_table(exc):
            return []
        raise
    finally:
        con.close()
    pages: dict[str, dict] = {}
    for page_id, name, slug, node_type, member_name, member_id in rows:
        page = pages.setdefault(
            page_id,
            {
                "page_id": page_id,
                "name": name,
                "slug": slug,
                "node_type": node_type,
                "members": [],
            },
        )
        if member_name:
            page["members"].append({"name": member_name, "node_id": member_id})
    return list(pages.values())
