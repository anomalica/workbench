"""Adjudication gold for the audit view: the human's verdict on each claim
cluster, scored against by the digester's grader.

Stored per record at `ingests/store/{hash}.audit.json` (schema
`anomalica/audit/1`) - access-gated, because a `missed`/adjudicated text is
transcribed from the (possibly copyrighted) source. One entry per adjudicated
claim:

    {
      "gold_id": "<uuid4>",          # assigned once, immutable - survives edits
                                     #   and re-runs; NOT derived from content
      "verdict": "real",             # real | hallucinated | not_asserted | missed
      "location": "01:41:55.0-01:45:35.0",
      "text": "the fact as adjudicated",
      "attribution": { ... },        # on `real`: copied from the `correct` member
      "members": [                   # audit-time provenance, NOT the scoring anchor
        {"variant": "opus-v3", "claim_id": "...", "verdict": "correct"},
        {"variant": "haiku-v3", "claim_id": "...", "verdict": "flattened"}
      ],
      "note": ""
    }

The gold_id is minted once and never recomputed (a text edit must not fork the
entry). Matching a fresh variant run to gold is a SEPARATE job, done by
location + text similarity - claim_ids regenerate every extraction run, so they
are provenance only, never identity. Verdict vocab and the attribution/member
model were converged with anomalica/digester.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

SCHEMA = "anomalica/audit/1"

CLUSTER_VERDICTS = ("real", "hallucinated", "not_asserted", "missed")
MEMBER_VERDICTS = ("correct", "flattened", "misattributed", "overhedged")


def empty(record_hash: str) -> dict:
    return {"schema": SCHEMA, "record_hash": record_hash, "adjudications": []}


def read(store_path: Path, record_hash: str) -> dict:
    """The gold sidecar for a record, or an empty doc when none exists."""
    path = store_path / f"{record_hash}.audit.json"
    if not path.is_file():
        return empty(record_hash)
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return empty(record_hash)
    if not isinstance(data, dict) or not isinstance(data.get("adjudications"), list):
        return empty(record_hash)
    return data


def write(store_path: Path, record_hash: str, gold: dict) -> Path:
    """Write the gold sidecar and return its path (the caller commits it)."""
    path = store_path / f"{record_hash}.audit.json"
    path.write_text(json.dumps(gold, indent=2, ensure_ascii=False) + "\n")
    return path


def mint_gold_id(existing: set[str]) -> str:
    """A fresh uuid4 hex id not already used in this record's gold."""
    while True:
        gid = uuid.uuid4().hex
        if gid not in existing:
            return gid


def upsert(gold: dict, adjudication: dict) -> dict:
    """Add or replace an adjudication by its gold_id, minting one if absent.
    Returns the gold doc (mutated in place) and stamps the entry's gold_id."""
    entries = gold.setdefault("adjudications", [])
    existing = {e.get("gold_id") for e in entries if e.get("gold_id")}
    gid = adjudication.get("gold_id") or mint_gold_id(existing)
    adjudication["gold_id"] = gid
    for i, e in enumerate(entries):
        if e.get("gold_id") == gid:
            entries[i] = adjudication
            return gold
    entries.append(adjudication)
    return gold


def remove(gold: dict, gold_id: str) -> bool:
    """Drop an adjudication by id. True if it existed."""
    entries = gold.get("adjudications", [])
    for i, e in enumerate(entries):
        if e.get("gold_id") == gold_id:
            del entries[i]
            return True
    return False


def _member_keys(members: list[dict]) -> set[tuple[str, str]]:
    return {(m.get("variant", ""), m.get("claim_id", "")) for m in members or []}


def match_adjudication(adjudication: dict, clusters: list[dict]) -> dict | None:
    """The current cluster an adjudication belongs to: exact by shared member
    (variant, claim_id) when the displayed run is the one the gold was marked
    against, else the caller falls back to location+text. `missed` adjudications
    (no members) never match a cluster - they render as their own gap items."""
    want = _member_keys(adjudication.get("members", []))
    if not want:
        return None
    best, best_overlap = None, 0
    for c in clusters:
        overlap = len(want & _member_keys(c.get("members", [])))
        if overlap > best_overlap:
            best, best_overlap = c, overlap
    return best
