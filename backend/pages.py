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

import json
import os
import sqlite3
import re
import subprocess
import sys
import uuid
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
from anomalica_common.slug import section_for, slugify as _slugify  # noqa: E402


_BRIEF_HASH = re.compile(rb"brief_hash:\s*([0-9a-f]{16,64})")
# The `page:` block and nothing after it. The head also holds the start of
# `related_nodes`, whose entries carry `slug:` and `node_type:` lines at the
# same indent, so a field regex over the whole head would read a neighbour's
# slug as the page's if the block order ever changed. Cut the block out first.
_PAGE_BLOCK = re.compile(rb"^page:\n((?:[ \t]+[^\n]*\n)+)", re.M)


def _brief_head(path: Path) -> dict | None:
    """What identifies a brief, from its first bytes: `brief_hash` and the
    `page` block (node_id, node_type, slug, claim_count_total).

    Head-read, never parsed whole. A brief runs to ~300KB and the list shows
    400 of them; parsing each to read one integer hung the endpoint outright.
    The page block is written first and is a few lines, so 4KB covers it.
    """
    try:
        with path.open("rb") as f:
            head = f.read(4096)
    except OSError:
        return None
    h = _BRIEF_HASH.search(head)
    page: dict = {}
    block = _PAGE_BLOCK.search(head)
    if block:
        try:
            parsed = yaml.safe_load(b"page:\n" + block.group(1))
        except yaml.YAMLError:
            parsed = None
        if isinstance(parsed, dict) and isinstance(parsed.get("page"), dict):
            page = parsed["page"]
    return {"brief_hash": h.group(1).decode() if h else None, "page": page}


def _claim_total(path: Path) -> int | None:
    head = _brief_head(path)
    if head is None:
        return None
    n = head["page"].get("claim_count_total")
    return n if isinstance(n, int) else None


# A section is a plural word; a slug is lowercase letters, digits and hyphens
# (a disambiguated one carries a node-id suffix, which is hex and hyphens).
# Anything else is not a brief reference and is refused before it becomes a
# path - the two are user-supplied URL parts.
_PATH_PART = re.compile(r"[a-z0-9][a-z0-9-]*")


def brief_path(section: str, slug: str) -> Path | None:
    if not (_PATH_PART.fullmatch(section) and _PATH_PART.fullmatch(slug)):
        return None
    return briefs_dir() / section / f"{slug}.yaml"


def brief_index() -> dict[str, dict]:
    """Every brief, keyed by the node it is for.

    Keyed on node_id, not slug. A slug is unique only within a node type, so an
    event and a project both called "Apollo 14" have one slug and two briefs;
    looking a brief up by the name-derived slug found one file for both, and
    also missed every brief whose slug had been disambiguated with a suffix.
    The brief's own head says which node it is for, and that is the only key
    that cannot collide.

    Only `<section>/<slug>.yaml` is read. A file directly in the root is the
    pre-section layout, which the synthesiser prunes and this never reads.
    """
    out: dict[str, dict] = {}
    for path in sorted(briefs_dir().glob("*/*.yaml")):
        head = _brief_head(path)
        if head is None:
            continue
        nid = head["page"].get("node_id")
        if not isinstance(nid, str) or not nid:
            continue
        total = head["page"].get("claim_count_total")
        out[nid] = {
            "section": path.parent.name,
            "slug": path.stem,
            "brief_hash": head["brief_hash"],
            "claim_total": total if isinstance(total, int) else None,
        }
    return out


def content_pages_dir() -> Path:
    return (
        Path(os.environ.get("ANOMALICA_CONTENT_DIR", str(_ANOMALICA / "content")))
        / "pages"
    )


_PAGE_TITLE = re.compile(rb"^title:\s*[\"']?(.+?)[\"']?\s*$", re.M)


def _page_head(path: Path) -> tuple[str | None, str | None]:
    """A published page's title and the brief it was built from.

    Head-read, like `_claim_total`: an assembled page carries every claim id it
    used, so it runs to hundreds of kilobytes, and the two fields wanted here
    are in its first lines. Parsing 72 of them to read two strings is the same
    mistake that hung the topics list.
    """
    try:
        with path.open("rb") as f:
            head = f.read(4096)
    except OSError:
        return None, None
    title = _PAGE_TITLE.search(head)
    brief = _BRIEF_HASH.search(head)
    return (
        title.group(1).decode("utf-8", "replace").strip() if title else None,
        brief.group(1).decode() if brief else None,
    )


def _brief_hash_of(section: str, slug: str) -> str | None:
    """The CURRENT brief's hash for a page, so it can be told from the material
    it was written from. A page is the pair, not the slug: two sections can
    hold one slug, and they are different pages with different briefs."""
    path = brief_path(section, slug)
    head = _brief_head(path) if path else None
    return head["brief_hash"] if head else None


def published_pages() -> list[dict]:
    """Pages that already exist - the third thing a reviewer needs to see.

    Without them the tab is a queue: what to do next, with no way to tell that
    a topic proposed last week went out last night. With them it is a status
    view, and the only place the three states of a subject sit together.

    A page whose `brief_hash` no longer matches its brief is TRAILING: the
    material moved after the page was written. That is the same signal
    `assimilator doctor` reports, read here from the page itself.
    """
    root = content_pages_dir()
    if not root.is_dir():
        return []
    out: list[dict] = []
    for path in sorted(root.rglob("*.en.md")):
        rel = path.relative_to(root)
        title, built_from = _page_head(path)
        if built_from is None:
            # Hand-written pages (about, contact, methodology) are not assembled
            # from a brief and are not topics.
            continue
        slug = rel.stem.removesuffix(".en")
        kind = rel.parts[0] if len(rel.parts) > 1 else None
        current = _brief_hash_of(kind, slug) if kind else None
        out.append(
            {
                "slug": slug,
                "name": title or slug,
                "kind": kind,
                "brief_hash": built_from,
                # None when the brief has gone: the page outlived its source,
                # which is a different condition from being out of date.
                "stale": None if current is None else current != built_from,
            }
        )
    return out


def list_topics(limit: int = 400) -> dict:
    """Proposed topics with their evidence, each joined to its brief if one exists.

    `has_brief` and `brief_claims` are the honest answer to "what would actually
    go into this page": a proposal states what the gate counted, the brief states
    what synthesis could assemble, and the two disagreeing is a real condition
    worth seeing rather than hiding.
    """
    con = graph._open()
    if con is None:
        # Seeded and published come from files, not the graph, so an absent
        # database costs the proposals and nothing else.
        return {"topics": [], "seeded": read_seeded(), "published": published_pages()}
    rows: list = []
    vetoed: set = set()
    renames: dict = {}
    try:
        rows = con.execute(
            """
            SELECT p.node_id, n.name, p.node_type, p.tier, p.claim_count,
                   p.source_count, p.independent_source_count,
                   p.second_source_claims, p.subject_claims, p.status
            FROM page_proposals p JOIN nodes n ON n.id = p.node_id
            WHERE n.retired_at IS NULL
            ORDER BY p.claim_count DESC LIMIT ?
            """,
            (limit,),
        ).fetchall()
        vetoed = {r[0] for r in con.execute("SELECT node_id FROM page_vetoes")}
    except sqlite3.OperationalError:
        # A graph built before page proposals existed has no such table. That
        # is a graph with nothing to propose, not a broken one - and the
        # pre-render must not fall over on it, or a whole snapshot fails for a
        # feature that has never run.
        rows = []
    try:
        # Renames that did NOT land. An applied one needs no telling - the row
        # already shows the new name - but a rejected or lost one is an answer
        # somebody is owed, and it is invisible everywhere else. Ordered oldest
        # first so the latest attempt per node is the one that survives.
        renames = {
            r[0]: {"status": r[1], "proposed_name": r[2], "note": r[3]}
            for r in con.execute(
                "SELECT node_id, status, proposed_name, resolution_note"
                " FROM rename_proposals WHERE status != 'applied' ORDER BY proposed_at"
            )
        }
    except sqlite3.OperationalError:
        renames = {}
    finally:
        con.close()

    index = brief_index()
    out = []
    for nid, name, ntype, tier, claims, sources, ind, second, subject, status in rows:
        ref = index.get(nid)
        # The brief's slug is the authoritative one: a same-type collision
        # loser carries a suffix the name alone does not know about. The
        # name-derived slug stands in only where there is no brief to ask.
        slug = ref["slug"] if ref else _slugify(name)
        section = ref["section"] if ref else section_for(ntype)
        out.append(
            {
                "node_id": nid,
                "name": name,
                "node_type": ntype,
                "tier": tier,
                "section": section,
                "slug": slug,
                "claims": claims,
                "sources": sources,
                "independent_sources": ind,
                # The gate's own single-source test: a second work contributing
                # fewer than three claims means the page rests on one voice.
                "single_source": (second or 0) < 3,
                # Claims that are ABOUT the node, not merely mentioning it - the
                # gate's subject test (page_gate._subject_counts). NULL on a
                # proposal table computed before the column existed.
                "subject_claims": subject,
                "status": "vetoed" if nid in vetoed else (status or "proposed"),
                # Present only when a rename was asked for and did not land.
                "rename": renames.get(nid),
                "has_brief": ref is not None,
                "brief_claims": ref["claim_total"] if ref else None,
            }
        )
    return {"topics": out, "seeded": read_seeded(), "published": published_pages()}


def read_brief(section: str, slug: str) -> dict | None:
    """The brief itself - the exact material a page would be written from.

    Returned whole rather than summarised. The point of showing it is to see what
    is actually going in, and a summary of the input is not the input.

    Addressed by the pair. A slug alone can name two pages now that the
    collision is representable, and guessing which one was asked for is how the
    scheduler re-emitted the wrong page on every pass.
    """
    p = brief_path(section, slug)
    if p is None or not p.is_file():
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


def rename_proposals_dir() -> Path:
    base = Path(os.environ.get("ANOMALICA_CURATION_DIR", str(_ANOMALICA / "curation")))
    return base / "rename-proposals"


def rename_outcome(proposal_id: str) -> dict | None:
    """What the assimilator recorded for one proposal, or None if it never
    reached the table (a graph built before renames existed has no such table)."""
    con = graph._open()
    if con is None:
        return None
    try:
        row = con.execute(
            "SELECT status, resolution_note FROM rename_proposals WHERE id = ?",
            (proposal_id,),
        ).fetchone()
    except sqlite3.OperationalError:
        return None
    finally:
        con.close()
    return {"status": row[0], "note": row[1]} if row else None


def propose_rename(
    node_id: str,
    current_name: str | None,
    new_name: str | None,
    reason: str | None,
    by: str | None,
) -> dict:
    """Rename a graph node - the title its page will carry - via the assimilator.

    Two hops rather than one because the workbench holds the graph READ-ONLY and
    a name written straight into the database would not survive a rebuild: the
    graph is re-imported from the digests and only the curation ledger is
    replayed. So the rename is dropped as a proposal file and applied by the
    assimilator's own command, which writes the ledger entry replay re-applies.

    The outcome is read back and returned rather than assumed. A rename can end
    `rejected` (the name is already another node's, which is a MERGE decision,
    not this one) or `lost` (neither the id nor the name resolves any more), and
    both of those exit zero - reporting success off the exit code would tell a
    reviewer their change landed when it did not.
    """
    from datetime import datetime, timezone

    new_name = (new_name or "").strip()
    current_name = (current_name or "").strip()
    if not new_name:
        raise ValueError("A new name is required")
    if not current_name:
        raise ValueError("The current name is required to identify the node")
    if new_name == current_name:
        raise ValueError("That is already the name")

    now = datetime.now(timezone.utc)
    proposal = {
        "id": str(uuid.uuid4()),
        "node_id": node_id,
        # NOT redundant with node_id: a rebuild mints new node ids, so the name
        # the reviewer saw is the fallback identity.
        "node_name_at_proposal": current_name,
        "proposed_name": new_name,
        "reason": (reason or "").strip() or None,
        "proposed_by": by or "workbench",
        "proposed_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    directory = rename_proposals_dir()
    directory.mkdir(parents=True, exist_ok=True)
    # Timestamp first so the directory sorts into application order; the id tail
    # keeps two proposals made in the same second from overwriting each other.
    stamp = now.strftime("%Y-%m-%dT%H-%M-%SZ")
    path = (
        directory / f"{stamp}-{_slugify(current_name)[:60]}-{proposal['id'][:8]}.json"
    )
    path.write_text(json.dumps(proposal, indent=2) + "\n")

    cmd = [
        sys.executable,
        "-m",
        "assimilator.cli",
        "--db",
        os.environ.get("GRAPH_DB_PATH", str(graph.graph_db_path())),
        "apply-renames",
    ]
    env = {**os.environ, "PYTHONPATH": str(_ASSIMILATOR_WS)}
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120, env=env)
    except subprocess.TimeoutExpired as exc:
        # The proposal file is already on disk, so the next apply-renames run
        # picks it up - say that rather than implying the rename was lost.
        raise RuntimeError(
            "the assimilator did not finish in time; the rename is queued"
        ) from exc
    outcome = rename_outcome(proposal["id"])
    if outcome is None:
        # Nothing was recorded, so the command did not get as far as this
        # proposal - that IS the failure, whatever the exit code said.
        raise RuntimeError(
            r.stderr.strip()[-400:] or r.stdout.strip()[-400:] or "rename failed"
        )
    status = outcome["status"]
    # A non-zero exit here means some OTHER proposal file in the directory would
    # not parse. Ours has a recorded outcome, so report that outcome.
    return {
        "ok": status == "applied",
        "status": status,
        "note": outcome["note"],
        "name": new_name if status == "applied" else current_name,
        "proposal_id": proposal["id"],
        "detail": r.stdout.strip(),
    }
