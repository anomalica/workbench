#!/usr/bin/env python3
"""Records the assimilator judged to share a subject with this one.

EXPERIMENTAL (cleared 2026-09-03). The assimilator's `relate` pass writes one
row per judged pair to `record_relations` in the knowledge graph: a verdict,
the shared subject as a short phrase, its reason, and the claim pairs that
link the two. This reads those rows for one record and resolves what a
reviewer needs to see them - the other record's title and date, and the text
of each linked claim - so the panel can show the pair side by side and link
to both.

Read-only. Confirming or rejecting a relation is a curation-ledger operation
(decision 0038), replayed by the assimilator on rebuild; it is never written
into the graph from here. The table is derived and rebuildable, so an absent
table is "not run yet", not an error.
"""

from __future__ import annotations

import json
import sqlite3

from backend import graph

PUBLIC_HASH_LENGTH = 56
SHOWN_VERDICTS = ("same_subject", "possibly_related")


def _bare(content_hash: str) -> str:
    return (
        content_hash[len("sha256:") :]
        if content_hash.startswith("sha256:")
        else content_hash
    )


def _record_id(con: sqlite3.Connection, content_hash: str) -> str | None:
    """The graph's id for a record, whichever way its hash was stored."""
    bare = _bare(content_hash)
    row = con.execute(
        "SELECT id FROM records WHERE content_hash IN (?, ?) LIMIT 1",
        (bare, f"sha256:{bare}"),
    ).fetchone()
    return row["id"] if row else None


def _record_summary(con: sqlite3.Connection, record_id: str) -> dict:
    row = con.execute(
        "SELECT title, date, content_hash FROM records WHERE id = ?", (record_id,)
    ).fetchone()
    if row is None:
        return {
            "record_id": record_id,
            "title": None,
            "date": None,
            "content_hash": None,
            "public_hash": None,
        }
    h = _bare(row["content_hash"] or "") or None
    return {
        "record_id": record_id,
        "title": row["title"],
        "date": row["date"],
        "content_hash": h,
        "public_hash": h[:PUBLIC_HASH_LENGTH] if h else None,
    }


def _claim(con: sqlite3.Connection, claim_ref: str, records: tuple[str, str]) -> dict:
    """A linked claim. The assimilator writes the digest's 8-character id,
    which is the first 8 of the graph's full id, so the lookup is by prefix -
    scoped to the two records of the pair, because 8 hex characters over
    33,000 claims can collide and a stranger's claim must not be shown as the
    link. The full id is returned: the record page deep-links on it."""
    rows = con.execute(
        "SELECT id, content, record_id FROM claims "
        "WHERE (id = ? OR id LIKE ?) AND record_id IN (?, ?) LIMIT 2",
        (claim_ref, f"{claim_ref}%", *records),
    ).fetchall()
    # A link to a claim the graph no longer holds - or one that resolves to
    # two - is shown as unresolved, not dropped: the assimilator said the pair
    # existed when it judged, and a reviewer should see that it did.
    if len(rows) != 1:
        return {"id": claim_ref, "text": None, "record_id": None}
    row = rows[0]
    return {"id": row["id"], "text": row["content"], "record_id": row["record_id"]}


def _links(
    con: sqlite3.Connection, raw: str | None, records: tuple[str, str]
) -> list[dict]:
    try:
        pairs = json.loads(raw) if raw else []
    except json.JSONDecodeError:
        return []
    out = []
    for p in pairs if isinstance(pairs, list) else []:
        if not isinstance(p, dict):
            continue
        out.append(
            {
                "a": _claim(con, str(p.get("a", "")), records),
                "b": _claim(con, str(p.get("b", "")), records),
                "relation": str(p.get("relation") or ""),
            }
        )
    return out


def relations_for(content_hash: str) -> list[dict]:
    """Every same_subject / possibly_related judgement involving this record,
    from either side of the pair, with the OTHER record and the linked claims
    resolved. `unrelated` rows are the pass's negatives and are not shown."""
    con = graph._open()
    if con is None:
        return []
    try:
        me = _record_id(con, content_hash)
        if me is None:
            return []
        try:
            rows = con.execute(
                """
                SELECT record_a, record_b, verdict, shared_subject, reason, links,
                       model, judged_at
                FROM record_relations
                WHERE (record_a = ? OR record_b = ?)
                  AND verdict IN (?, ?)
                ORDER BY judged_at DESC
                """,
                (me, me, *SHOWN_VERDICTS),
            ).fetchall()
        except sqlite3.OperationalError:
            # The pass has not run against this graph: no table, nothing to show.
            return []
        out = []
        for r in rows:
            other_id = r["record_b"] if r["record_a"] == me else r["record_a"]
            links = _links(con, r["links"], (me, other_id))
            # Present each pair with THIS record's claim first, whichever side
            # the assimilator wrote it on, so the panel reads "ours / theirs".
            for link in links:
                if (
                    link["a"]["record_id"] not in (me, None)
                    and link["b"]["record_id"] == me
                ):
                    link["a"], link["b"] = link["b"], link["a"]
            out.append(
                {
                    "verdict": r["verdict"],
                    "shared_subject": r["shared_subject"],
                    "reason": r["reason"],
                    "model": r["model"],
                    "judged_at": r["judged_at"],
                    "other": _record_summary(con, other_id),
                    "links": links,
                }
            )
        return out
    finally:
        con.close()
