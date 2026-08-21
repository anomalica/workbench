"""Topic and page management: what earns a page, and what goes into it.

The graph proposes pages by evidence (>=3 claims from >=2 distinct works), and
until now that proposal set was visible only as scheduler job labels - a title
and a claim count, with no way to see WHY a topic qualified, what would go into
it, or to say "yes to this one, never to that one, and here is one you missed".

Three things this surfaces, and they are deliberately different:

- PROPOSED topics are what the graph found. They carry their evidence, so a
  decision is made on the numbers rather than on the name.
- VETOED topics are an editorial "never a page". Durable in the curation ledger
  and replayed on every rebuild, so the proposal stops reappearing each pass.
- SEEDED topics are Mark's own, and are the piece the graph cannot produce: a
  subject named BEFORE there is material, which then fills up. That inverts the
  usual reading - it shows where the corpus is thin against what we care about,
  which is a better steer for what to ingest next than what happens to be
  abundant.

Reads are read-only against the graph and the briefs directory. Writes go through
the assimilator's own commands, exactly as graph curation does: the assimilator
owns the mutation and the durable ledger, the workbench invokes and reports.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

import yaml

from backend import graph

_ANOMALICA = Path(__file__).resolve().parents[2]
_ASSIMILATOR_WS = _ANOMALICA / "assimilator" / "workspace"


def briefs_dir() -> Path:
    return Path(
        os.environ.get(
            "ANOMALICA_BRIEFS_DIR",
            str(Path.home() / ".local" / "share" / "assimilator" / "briefs"),
        )
    )


def seeded_path() -> Path:
    base = Path(os.environ.get("ANOMALICA_CURATION_DIR", str(_ANOMALICA / "curation")))
    return base / "seeded-topics.yaml"


def read_seeded() -> list[dict]:
    """Topics named by a human, newest last. Absent file is an empty list."""
    p = seeded_path()
    if not p.is_file():
        return []
    try:
        docs = [d for d in yaml.safe_load_all(p.read_text()) if isinstance(d, dict)]
    except yaml.YAMLError:
        return []
    live: dict[str, dict] = {}
    for d in docs:
        name = (d.get("name") or "").strip()
        if not name:
            continue
        if d.get("op") == "remove":
            live.pop(name.lower(), None)
        else:
            live[name.lower()] = d
    return list(live.values())


def add_seeded(name: str, note: str | None, by: str | None) -> dict:
    """Append a seeded topic. Append-only: a removal is a compensating entry, so
    the history of what was asked for survives even after it is dropped."""
    from datetime import datetime, timezone

    entry = {
        "op": "seed",
        "name": name.strip(),
        "note": (note or "").strip() or None,
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "by": by,
    }
    p = seeded_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a") as f:
        f.write("---\n" + yaml.safe_dump(entry, sort_keys=False))
    return entry


def remove_seeded(name: str, by: str | None) -> None:
    from datetime import datetime, timezone

    p = seeded_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a") as f:
        f.write(
            "---\n"
            + yaml.safe_dump(
                {
                    "op": "remove",
                    "name": name.strip(),
                    "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "by": by,
                },
                sort_keys=False,
            )
        )


sys.path.insert(0, str(_ANOMALICA / "anomalica-common" / "src"))
from anomalica_common.slug import slugify as _slugify  # noqa: E402


_CLAIM_TOTAL = re.compile(rb"claim_count_total:\s*(\d+)")


def _claim_total(path: Path) -> int | None:
    """claim_count_total from the head of a brief, without parsing it.

    The page block is written first, so the number is within the first few
    hundred bytes; 4KB is generous cover for a long title and creator list.
    """
    try:
        with path.open("rb") as f:
            m = _CLAIM_TOTAL.search(f.read(4096))
    except OSError:
        return None
    return int(m.group(1)) if m else None


def list_topics(limit: int = 400) -> dict:
    """Proposed topics with their evidence, each joined to its brief if one exists.

    `has_brief` and `brief_claims` are the honest answer to "what would actually
    go into this page": a proposal states what the gate counted, the brief states
    what synthesis could assemble, and the two disagreeing is a real condition
    worth seeing rather than hiding.
    """
    con = graph._open()
    if con is None:
        return {"topics": [], "seeded": read_seeded()}
    try:
        rows = con.execute(
            """
            SELECT p.node_id, n.name, p.node_type, p.tier, p.claim_count,
                   p.source_count, p.independent_source_count,
                   p.second_source_claims, p.status
            FROM page_proposals p JOIN nodes n ON n.id = p.node_id
            WHERE n.retired_at IS NULL
            ORDER BY p.claim_count DESC LIMIT ?
            """,
            (limit,),
        ).fetchall()
        vetoed = {r[0] for r in con.execute("SELECT node_id FROM page_vetoes")}
    finally:
        con.close()

    bdir = briefs_dir()
    out = []
    for nid, name, ntype, tier, claims, sources, ind, second, status in rows:
        slug = _slugify(name)
        bp = bdir / f"{slug}.yaml"
        # Read the count out of the head of the file rather than parsing the
        # brief. A brief runs to ~300KB and the list shows 400 of them; parsing
        # them all to read one integer each hung the endpoint outright.
        brief_claims = _claim_total(bp) if bp.is_file() else None
        out.append(
            {
                "node_id": nid,
                "name": name,
                "node_type": ntype,
                "tier": tier,
                "slug": slug,
                "claims": claims,
                "sources": sources,
                "independent_sources": ind,
                # The gate's own single-source test: a second work contributing
                # fewer than three claims means the page rests on one voice.
                "single_source": (second or 0) < 3,
                "status": "vetoed" if nid in vetoed else (status or "proposed"),
                "has_brief": bp.is_file(),
                "brief_claims": brief_claims,
            }
        )
    return {"topics": out, "seeded": read_seeded()}


def read_brief(slug: str) -> dict | None:
    """The brief itself - the exact material a page would be written from.

    Returned whole rather than summarised. The point of showing it is to see what
    is actually going in, and a summary of the input is not the input.
    """
    p = briefs_dir() / f"{slug}.yaml"
    if not p.is_file():
        return None
    try:
        return yaml.safe_load(p.read_text()) or {}
    except yaml.YAMLError:
        return None


def veto(node_ids: list[str], reason: str | None, by: str | None) -> dict:
    """Editorial 'never a page', through the assimilator's own command."""
    cmd = [
        sys.executable,
        "-m",
        "assimilator.cli",
        "--db",
        os.environ.get("GRAPH_DB_PATH", str(graph.graph_db_path())),
        "veto-pages",
        "--reason",
        reason or "",
        "--by",
        by or "workbench",
        *node_ids,
    ]
    env = {**os.environ, "PYTHONPATH": str(_ASSIMILATOR_WS)}
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120, env=env)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[-400:] or "veto failed")
    return {"ok": True, "detail": r.stdout.strip()}
