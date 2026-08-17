"""Reading infrastructure.db - the half of every digest nothing has ever read.

Extraction splits each record in two. Domain claims - what happened, who saw it -
go to knowledge.db and become articles. Infrastructure claims go here, and here
is where they have stayed: 1,830 claims, 9,605 nodes, and no consumer anywhere in
the pipeline since the database was created.

What is actually in it is a BIBLIOGRAPHY. Not the corpus's own sources - the
works its sources talk about. "American Cosmic cites Jeremy Sconce's Haunted
Media." "Leon Festinger, Henry Riecken and Stanley Schachter wrote When Prophecy
Fails." Following the claim-to-node references gives 800 works, 994 people and
356 organisations, linked by who wrote what and who cited whom.

Two facts fall out of that and both drive the layout:

  * Of the 800 works named, the corpus holds a handful. The rest is a reading
    list the material assembled itself, which is why `held` is computed and
    why works are the spine of the view rather than claims.
  * `administrative` (1,469 of 1,830) is the category working as intended - it
    is what a bibliography is made of. The other 361 are typed as observation,
    testimony, hearsay: they may be domain claims filed in the wrong half, or
    just bibliographic facts the model typed loosely. It is a place to look,
    not a defect list.

Read-only, by SQLite's own `mode=ro`: this database is derived, rebuilt from the
digests on every import, so nothing written here would survive - and a correction
belongs in the curation ledger the assimilator replays, not in its output.
"""

from __future__ import annotations

import os
import re
import sqlite3
from pathlib import Path

DEFAULT_INFRASTRUCTURE_DB = (
    Path.home() / ".local" / "share" / "assimilator" / "infrastructure.db"
)

#: Everything that is NOT this is worth a second look - see the module docstring.
ADMINISTRATIVE = "administrative"

#: The kinds worth browsing as entities. The graph also holds event/place/topic
#: nodes, but a bibliography's spine is works, the people who made them and the
#: bodies that published them; the rest surface as a selected entity's
#: connections rather than as lists of their own.
BROWSABLE = ("document", "person", "organisation")

#: Enough to hold every referenced entity of one kind (the largest is ~1,000)
#: so a browse list is never silently truncated.
ENTITY_LIMIT = 2000


def infrastructure_db_path() -> Path:
    return Path(
        os.environ.get("INFRASTRUCTURE_DB_PATH", str(DEFAULT_INFRASTRUCTURE_DB))
    )


def _open(db_path: str | Path | None = None) -> sqlite3.Connection | None:
    p = Path(db_path) if db_path else infrastructure_db_path()
    if not p.exists():
        return None
    con = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


# --- Matching a named work against the records the corpus actually holds ---

# Case is the whole signal here: an ALL-CAPS tail is an acronym for the words
# before it, a lower-case one is a disambiguator. Matching case-insensitively
# reduced every "X (book)" title to the single key "book", so eight unrelated
# books collided with each other and any record titled "... (book)" would have
# marked all of them held.
_ACRONYM = re.compile(r"\b[\w'\-]+(?:\s+[\w'\-]+){0,5}\s+\(([A-Z0-9][A-Z0-9\-]{1,9})\)")
_PARENTHETICAL = re.compile(r"\s*\([^)]*\)")
_LOOSE = re.compile(r"[^a-z0-9]+")


def title_keys(title: str | None) -> set[str]:
    """Every form one title might be written in.

    The corpus expands acronyms on first use - "Unidentified Flying Object
    (UFO)" - so the same work is `Messengers of Deception: UFO Contacts and
    Cults` in one place and carries the expansion in another. Matching the
    literal string finds 8 held works of 800; matching all three forms finds 18.

    The third form drops any parenthetical, which is how `Communion (Whitley
    Strieber book)` reaches `Communion`. That one is deliberately loose: it is
    what a reader would call the same work, and it costs nothing here because a
    false pairing only means a shelf-check hit on a title the corpus does hold.
    """
    raw = title or ""
    t = raw.lower()
    forms = {
        t,
        _ACRONYM.sub(lambda m: m.group(1), raw).lower(),
        _PARENTHETICAL.sub("", t),
    }
    return {k for k in (_LOOSE.sub(" ", f).strip() for f in forms) if k}


#: Below this, a prefix match is a coincidence rather than a truncation - see
#: `_held_matcher`.
PREFIX_FLOOR = 20


def _held_matcher(titles):
    """Does the corpus hold the work with this name?

    Prefix as well as exact, because the record list truncates: the ingest
    titled `David Fravor: UFOs, Aliens, Fighter Jets, and Aerospace Engineering
    | Lex` is the work the graph calls `... | Lex Fridman Podcast #122`, and an
    equality test calls that one unheld. Only from `PREFIX_FLOOR` characters up,
    so short titles still have to match outright.
    """
    keys = set()
    for t in titles or ():
        keys |= title_keys(t)
    long_keys = [k for k in keys if len(k) >= PREFIX_FLOOR]

    def held(name: str) -> bool:
        mine = title_keys(name)
        if mine & keys:
            return True
        return any(
            (m.startswith(k) or k.startswith(m))
            for k in long_keys
            for m in mine
            if len(m) >= PREFIX_FLOOR
        )

    return held


# --- Reads ---


def summary(db_path: str | Path | None = None, held_titles=None) -> dict | None:
    """What is in the database, in the terms the tab presents it.

    None when the database is absent, so the tab can say "the assimilator has
    not built this yet" rather than showing an empty list, which would read as
    "there is nothing in here" - a different and wrong statement.
    """
    con = _open(db_path)
    if con is None:
        return None
    try:
        rows = con.execute(
            """
            SELECT n.node_type, count(DISTINCT n.id) c
            FROM nodes n JOIN claim_node_refs f ON f.node_id = n.id
            GROUP BY n.node_type
            """
        ).fetchall()
        by_kind = {r["node_type"]: r["c"] for r in rows}
        by_type = [
            {"type": r["claim_type"], "count": r["c"]}
            for r in con.execute(
                "SELECT claim_type, count(*) c FROM claims GROUP BY claim_type ORDER BY c DESC"
            )
        ]
        works = _work_rows(con)
        held_by = _held_matcher(_with_own_records(con, held_titles))
        held = sum(1 for w in works if held_by(w["name"])) if held_titles else 0
        return {
            "claims": con.execute("SELECT count(*) FROM claims").fetchone()[0],
            "records": con.execute("SELECT count(*) FROM records").fetchone()[0],
            "entities": {k: by_kind.get(k, 0) for k in BROWSABLE},
            "connected": {k: by_kind.get(k, 0) for k in by_kind},
            "works_held": held,
            "works_named": len(works),
            "by_type": by_type,
            "suspect": sum(t["count"] for t in by_type if t["type"] != ADMINISTRATIVE),
            "works_double_listed": len(_same_work_names(con)),
        }
    finally:
        con.close()


def _same_work_names(con: sqlite3.Connection) -> dict[str, list[str]]:
    """Works listed under more than one name, keyed by each of those names.

    `Communion` and `Communion (Whitley Strieber book)` are two nodes, so the
    corpus counts them as two works. The assimilator's merge ledger would fold
    them, but replay is only ever passed the domain connection - it has never
    reached this database, and a merge recorded today still would not. Until
    that changes the duplicates are unreachable, so the view names them rather
    than quietly reporting one work as two.

    A shared key is not enough on its own. `Kirtland Air Force Base (UAP)
    Report` and `Vandenberg Air Force Base (UAP) Report` both reduce to `uap
    report` - two different documents agreeing on an acronym and a trailing
    word. So a key only pairs names when one of them IS that key written out:
    `UFO Danger Zone` is `ufo danger zone`, which is why it pairs with
    `Unidentified Flying Object (UFO) Danger Zone`, while `uap report` is
    neither document's name and pairs nothing.
    """
    plain: dict[str, set[str]] = {}
    by_key: dict[str, set[str]] = {}
    for row in _work_rows(con):
        name = row["name"]
        plain.setdefault(_LOOSE.sub(" ", name.lower()).strip(), set()).add(name)
        for k in title_keys(name):
            by_key.setdefault(k, set()).add(name)
    out: dict[str, set[str]] = {}
    for key, names in by_key.items():
        if len(names) < 2 or key not in plain:
            continue
        for n in names:
            out.setdefault(n, set()).update(names - {n})
    return {n: sorted(others) for n, others in out.items()}


def _with_own_records(con: sqlite3.Connection, titles):
    """The caller's record titles, plus the records this database was built
    from - a record that produced claims is held by definition, and its title
    here is the untruncated one."""
    own = [r["title"] for r in con.execute("SELECT title FROM records")]
    return [*(titles or ()), *own]


def _work_rows(con: sqlite3.Connection) -> list[sqlite3.Row]:
    return con.execute(
        """
        SELECT n.id, n.name, count(*) c
        FROM nodes n JOIN claim_node_refs f ON f.node_id = n.id
        WHERE n.node_type = 'document'
        GROUP BY n.id
        """
    ).fetchall()


def records(db_path: str | Path | None = None) -> list[dict]:
    """The records this half of the corpus was extracted from, heaviest first.

    56 of the corpus's records have been digested, and they are not equal
    contributors: a book with a bibliography yields hundreds of these claims, a
    press conference yields none. Showing the spread is how the tab admits that
    what it holds is a sample of the corpus, not a survey of it.
    """
    con = _open(db_path)
    if con is None:
        return []
    try:
        return [
            dict(r)
            for r in con.execute(
                """
                SELECT r.title, r.content_hash AS hash, count(c.id) AS claims
                FROM records r LEFT JOIN claims c ON c.record_id = r.id
                GROUP BY r.id ORDER BY claims DESC, r.title
                """
            )
        ]
    finally:
        con.close()


def entities(
    db_path: str | Path | None = None,
    *,
    kind: str = "document",
    query: str = "",
    held_titles=None,
    limit: int = ENTITY_LIMIT,
) -> list[dict]:
    """Entities of one kind that at least one infrastructure claim mentions.

    Only referenced ones: the database carries 7,069 nodes no infrastructure
    claim touches (they belong to the domain half of the same extraction), and
    listing them would bury the 2,150 that mean something here.

    Ordered by mention count, because in a bibliography that is the closest
    thing to importance - the works and people the corpus keeps returning to.
    """
    con = _open(db_path)
    if con is None:
        return []
    try:
        args: list[object] = [kind]
        clause = ""
        if query.strip():
            clause = "AND n.name LIKE ?"
            args.append(f"%{query.strip()}%")
        rows = con.execute(
            f"""
            SELECT n.id, n.name, count(*) c,
                   count(DISTINCT cl.record_id) records
            FROM nodes n
            JOIN claim_node_refs f ON f.node_id = n.id
            JOIN claims cl ON cl.id = f.claim_id
            WHERE n.node_type = ? {clause}
            GROUP BY n.id
            ORDER BY c DESC, n.name
            LIMIT ?
            """,
            [*args, limit],
        ).fetchall()
        held_by = _held_matcher(_with_own_records(con, held_titles))
        return [
            {
                "id": r["id"],
                "name": r["name"],
                "mentions": r["c"],
                "records": r["records"],
                "held": bool(held_titles) and held_by(r["name"]),
            }
            for r in rows
        ]
    finally:
        con.close()


def entity(
    node_id: str,
    db_path: str | Path | None = None,
    held_titles=None,
    claim_limit: int = 200,
) -> dict | None:
    """One entity: what is said about it, and what it is said alongside.

    The co-references are the useful half. A work's connected people are its
    author and the people who cited it; a person's connected works are what
    they wrote and what they cited. The extraction never labels those roles,
    but the claim text does, so the connections are the index and the claims
    are the reading.
    """
    con = _open(db_path)
    if con is None:
        return None
    try:
        node = con.execute(
            "SELECT id, node_type, name FROM nodes WHERE id = ?", (node_id,)
        ).fetchone()
        if node is None:
            return None
        rows = con.execute(
            """
            SELECT c.content, c.claim_type, c.original_excerpt, c.location_in_record,
                   c.origin, c.relay, r.title AS record_title, r.content_hash AS record_hash
            FROM claims c
            JOIN claim_node_refs f ON f.claim_id = c.id
            LEFT JOIN records r ON r.id = c.record_id
            WHERE f.node_id = ?
            ORDER BY (c.claim_type = ?), r.title
            LIMIT ?
            """,
            (node_id, ADMINISTRATIVE, claim_limit),
        ).fetchall()
        connected = con.execute(
            """
            SELECT n.id, n.name, n.node_type, count(*) c
            FROM claim_node_refs mine
            JOIN claim_node_refs theirs ON theirs.claim_id = mine.claim_id
            JOIN nodes n ON n.id = theirs.node_id
            WHERE mine.node_id = ? AND n.id != ?
            GROUP BY n.id
            ORDER BY c DESC, n.name
            LIMIT 40
            """,
            (node_id, node_id),
        ).fetchall()
        held_by = _held_matcher(_with_own_records(con, held_titles))
        return {
            "id": node["id"],
            "name": node["name"],
            "kind": node["node_type"],
            "held": bool(held_titles) and held_by(node["name"]),
            "also_listed_as": (
                _same_work_names(con).get(node["name"], [])
                if node["node_type"] == "document"
                else []
            ),
            "aliases": [
                r["alias"]
                for r in con.execute(
                    "SELECT alias FROM aliases WHERE node_id = ? ORDER BY alias",
                    (node_id,),
                )
            ],
            "claims": [_claim(r) for r in rows],
            "connected": [
                {
                    "id": r["id"],
                    "name": r["name"],
                    "kind": r["node_type"],
                    "shared": r["c"],
                }
                for r in connected
            ],
        }
    finally:
        con.close()


def claims(
    db_path: str | Path | None = None,
    *,
    claim_type: str | None = None,
    query: str = "",
    limit: int = 200,
    offset: int = 0,
) -> list[dict]:
    """The raw claims, non-administrative first.

    That ordering is the only judgement this view makes: the loosely-typed 361
    sit above the 1,469 doing their job, so anything odd is met on the way in.
    """
    con = _open(db_path)
    if con is None:
        return []
    try:
        where = []
        args: list[object] = []
        if claim_type:
            where.append("c.claim_type = ?")
            args.append(claim_type)
        if query.strip():
            where.append("(c.content LIKE ? OR r.title LIKE ?)")
            like = f"%{query.strip()}%"
            args += [like, like]
        clause = f"WHERE {' AND '.join(where)}" if where else ""
        rows = con.execute(
            f"""
            SELECT c.content, c.claim_type, c.original_excerpt, c.location_in_record,
                   c.origin, c.relay, r.title AS record_title, r.content_hash AS record_hash
            FROM claims c
            LEFT JOIN records r ON r.id = c.record_id
            {clause}
            ORDER BY (c.claim_type = ?), r.title, c.id
            LIMIT ? OFFSET ?
            """,
            [*args, ADMINISTRATIVE, limit, offset],
        ).fetchall()
        return [_claim(r) for r in rows]
    finally:
        con.close()


def _claim(row: sqlite3.Row) -> dict:
    """A claim, with the excerpt it was drawn from dropped.

    The excerpt is the source text the claim paraphrases; it is what makes the
    claim checkable, but it is also long, and this view is read at the scale of
    hundreds of claims. Kept out of the payload until something asks for it.
    """
    c = dict(row)
    c.pop("original_excerpt", None)
    return c
