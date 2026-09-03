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


def published_pages() -> list[dict]:
    """Pages that already exist - the third thing a reviewer needs to see.

    Without them the tab is a queue: what to do next, with no way to tell that
    a topic proposed last week went out last night. With them it is a status
    view, and the only place the three states of a subject sit together.

    A page whose `brief_hash` no longer matches its brief is TRAILING: the
    material moved after the page was written. That is the same signal
    `assimilator doctor` reports, read here from the page itself.

    Each page carries the NODE it was written about, found through its brief.
    A written page is a subject like any other - it can be renamed, and it can
    turn out to be a second page about something the graph already holds - and
    without the node id it is a row nothing can act on.
    """
    root = content_pages_dir()
    if not root.is_dir():
        return []
    # (section, slug) -> the brief, inverted from the node-keyed index. One pass
    # over the briefs rather than a file read per page.
    by_page = {
        (ref["section"], ref["slug"]): {**ref, "node_id": nid}
        for nid, ref in brief_index().items()
    }
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
        brief = by_page.get((kind, slug)) if kind else None
        current = brief["brief_hash"] if brief else None
        out.append(
            {
                "slug": slug,
                "name": title or slug,
                "kind": kind,
                "brief_hash": built_from,
                # None when the brief has gone: the page outlived its source,
                # which is a different condition from being out of date.
                "stale": None if current is None else current != built_from,
                "node_id": brief["node_id"] if brief else None,
                "claims": brief["claim_total"] if brief else None,
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


def _live_node(node_id: str) -> dict | None:
    """One live node as {id, name, node_type, claims}, or None."""
    con = graph._open()
    if con is None:
        return None
    try:
        row = con.execute(
            "SELECT id, name, node_type,"
            " (SELECT COUNT(*) FROM claim_node_refs r WHERE r.node_id = n.id)"
            " FROM nodes n WHERE id = ? AND retired_at IS NULL",
            (node_id,),
        ).fetchone()
    except sqlite3.OperationalError:
        return None
    finally:
        con.close()
    return (
        {"id": row[0], "name": row[1], "node_type": row[2], "claims": row[3]}
        if row
        else None
    )


def name_suggestions(q: str, exclude: str = "", limit: int = 8) -> list[dict]:
    """Live nodes whose name or alias contains `q`, best match first.

    Its own query rather than the browse endpoint's because the two want
    different things: browse lists everything alphabetically and includes nodes
    that have been merged away, while this is answering "is there already one of
    these?" - so it is live nodes only, and ordered by how well they match
    rather than by name, or the thing being looked for sits at position 40.
    """
    q = (q or "").strip()
    if len(q) < 2:
        return []
    con = graph._open()
    if con is None:
        return []
    like = f"%{q}%"
    try:
        rows = con.execute(
            "SELECT n.id, n.name, n.node_type,"
            " (SELECT COUNT(*) FROM claim_node_refs r WHERE r.node_id = n.id) AS claims,"
            " (SELECT a.alias FROM aliases a WHERE a.node_id = n.id"
            "  AND a.alias LIKE ? LIMIT 1) AS via"
            " FROM nodes n WHERE n.retired_at IS NULL AND n.id <> ?"
            " AND (n.name LIKE ? OR n.id IN"
            "      (SELECT node_id FROM aliases WHERE alias LIKE ?))"
            " LIMIT 200",
            (like, exclude or "", like, like),
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    finally:
        con.close()

    needle = q.casefold()
    articles = ("the ", "a ", "an ")

    def rank(name: str) -> int:
        low = name.casefold()
        if low == needle:
            return 0
        # A leading article is not what anybody types: somebody looking for "The
        # Greys" types "greys", and without this it ranks below every name that
        # merely begins with the word.
        bare = next((low[len(a) :] for a in articles if low.startswith(a)), low)
        if low.startswith(needle) or bare.startswith(needle):
            return 1
        return 2 if f" {needle}" in low else 3

    out = [
        {
            "id": r[0],
            "name": r[1],
            "node_type": r[2],
            "claims": r[3],
            # Set when the hit came from an alias rather than the name, so the
            # list can show WHY something with no visible match is in it.
            "via": r[4] if r[4] and needle not in (r[1] or "").casefold() else None,
            "exact": (r[1] or "").casefold() == needle,
        }
        for r in rows
    ]
    # Shorter first within a rank: the closer a name is in length to what was
    # typed, the more likely it is the thing being reached for. Claim count only
    # separates two names of the same length.
    out.sort(
        key=lambda n: (
            rank(n["name"]),
            len(n["name"]),
            -n["claims"],
            n["name"].casefold(),
        )
    )
    return out[:limit]


def _node_holding_name(name: str, other_than: str) -> dict | None:
    """The live node already called `name`, if there is one - the same test the
    assimilator clashes on, so the two never disagree about what is taken."""
    con = graph._open()
    if con is None:
        return None
    try:
        row = con.execute(
            "SELECT id FROM nodes WHERE name = ? AND retired_at IS NULL AND id <> ?",
            (name, other_than),
        ).fetchone()
    except sqlite3.OperationalError:
        return None
    finally:
        con.close()
    return _live_node(row[0]) if row else None


def _merge_into_the_name(
    node_id: str, current_name: str, new_name: str, confirm: bool, by: str | None
) -> dict:
    """Renaming a node to a name another node already has says the two are one
    thing, so do that: fold this node into the one already called that.

    The survivor is the node that HOLDS the name - its name then needs no
    changing, and the merge keeps the folded-in node's old name as an alias, so
    the wording the sources use still resolves.

    Guarded on node type. An exact match on a full node name is strong evidence
    of sameness between two topics; between a topic and a person it is far more
    likely to be a name that reads the same than a thing that is the same, and
    the assimilator's merge does not check types at all. Different types need
    somebody to say so.
    """
    from backend import curation

    target = _node_holding_name(new_name, node_id)
    if target is None:
        # The clash is gone - a concurrent change. Report the rejection plainly
        # rather than merging into whatever holds the name now.
        return {
            "ok": False,
            "status": "rejected",
            "note": "name already taken",
            "name": current_name,
        }
    source_node = _live_node(node_id)
    same_type = bool(source_node) and source_node["node_type"] == target["node_type"]
    if not (same_type or confirm):
        return {
            "ok": False,
            "status": "clash",
            "note": "that name belongs to a different kind of thing",
            "name": current_name,
            "target": target,
            "source": source_node,
        }
    # `by` is already workbench/<login>, taken from the session by the endpoint,
    # so it is also the confirmation: this merge happened because a person typed
    # a name that exists and pressed a button that said "Merge into it".
    result = curation.apply_merge(
        target["id"],
        [node_id],
        new_name,
        by=by,
        confirmed_by=by,
        confirmed_via="workbench-rename",
    )
    if not result.get("ok"):
        return {
            "ok": False,
            "status": "rejected",
            "note": result.get("error") or "merge failed",
            "name": current_name,
        }
    return {
        "ok": True,
        "status": "merged",
        "name": new_name,
        "note": None,
        "merged_into": target,
    }


def propose_rename(
    node_id: str,
    current_name: str | None,
    new_name: str | None,
    reason: str | None,
    by: str | None,
    confirm_merge: bool = False,
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
    if status == "rejected":
        # Rejected means the name is another live node's. That is not a dead end
        # - it is the reviewer saying these two are one thing.
        return _merge_into_the_name(node_id, current_name, new_name, confirm_merge, by)
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
