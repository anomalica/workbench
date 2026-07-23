"""Adjudication gold for the audit view, v2: per-claim quality + irrelevant
marks and per-cluster best-of, scored against by the digester's eval.

Stored per record at `ingests/store/{hash}.audit.json`, schema
`anomalica/audit/2`, ACCESS-GATED (claim text and quote cite the source
verbatim). Shape converged with anomalica/digester (bus, 2026-07-23) - clean
slate over v1: zero v1 files existed on disk, so there is no migration and a v1
document on disk reads as empty.

    {
      "schema": "anomalica/audit/2",
      "record_hash": "<64-hex>",
      "claims": [
        {
          "gold_id": "<uuid4 hex>",   # minted once, immutable, never content-derived
          "variant": "haiku.d161b1ed",# EXACT variant file stem: model + prompt sha.
                                       # Not a version label - aggregating by model
                                       # is only valid within one prompt sha, and the
                                       # tuning programme changes prompts constantly.
          "model": "haiku",           # aggregation key, valid only within a sha
          "prompt_sha": "d161b1ed",
          "claim_id": "<as emitted>", # PROVENANCE ONLY - uuid4 regenerates every
                                       # extraction run, so it can never be identity
          "location": "01:41:55.0-01:45:35.0",
          "text": "the claim as the model wrote it",
          "quote": "verbatim source excerpt",  # the STABLE anchor: survives
                                       # re-digestion where model prose varies
          "quality": "good",          # bad | okay | good; OPTIONAL - absent means
                                       # NOT YET JUDGED, never implicitly fine.
                                       # "bad" INCLUDES unsupported-by-source and
                                       # misrepresents/inverts-the-source: the one
                                       # taxonomy carries the semantic axis, the
                                       # eval's mech-fid checks own the mechanical.
          "irrelevant": true,         # OPTIONAL, absent = false. ORTHOGONAL to
                                       # quality: perfectly written, about nothing
                                       # worth recording. The noise metric.
          "note": "",
          "reviewed_by": "email", "reviewed_at": "<ISO>"
        }
      ],
      "clusters": [
        {
          "gold_id": "<uuid4 hex>",
          "members": [{"variant": "...", "claim_id": "..."}],
          "best_variant": "opus.d161b1ed",  # OPTIONAL: present ONLY when chosen.
                                       # Absent = skipped, and a skip must NEVER
                                       # be scored as a tie-loss.
          "best_claim_id": "...",     # OPTIONAL: disambiguates when the winning
                                       # variant contributed two claims
          "reviewed_by": "email", "reviewed_at": "<ISO>"
        }
      ]
    }

DENOMINATORS (pinned with the digester so the two sides can't publish
contradicting numbers off identical data): quality and irrelevant rates are
computed over JUDGED claims only - an absent quality is excluded from numerator
AND denominator; best-of win rate over CONTESTED clusters only. Aggregation is
computed, never stored here: the sidecar is pure human judgment.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

SCHEMA = "anomalica/audit/2"

QUALITY = ("bad", "okay", "good")


def empty(record_hash: str) -> dict:
    # `models` is REQUIRED by the spec (anomalica audit-format.md / ADR 0045):
    # the variant set run on this record, stamped at write time. Without it,
    # "absent from a cluster" cannot be told from "never run on this record",
    # and the missed-fact rate is uncomputable. Silently fatal if omitted.
    return {
        "schema": SCHEMA,
        "record_hash": record_hash,
        "models": [],
        "claims": [],
        "clusters": [],
    }


def read(store_path: Path, record_hash: str) -> dict:
    """The gold sidecar for a record, or an empty doc when none exists. A file
    in any other shape (including v1) reads as empty - clean slate, converged."""
    path = store_path / f"{record_hash}.audit.json"
    if not path.is_file():
        return empty(record_hash)
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return empty(record_hash)
    if (
        not isinstance(data, dict)
        or data.get("schema") != SCHEMA
        or not isinstance(data.get("claims"), list)
        or not isinstance(data.get("clusters"), list)
    ):
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


def _ids(gold: dict) -> set[str]:
    return {
        e.get("gold_id")
        for k in ("claims", "clusters")
        for e in gold.get(k, [])
        if e.get("gold_id")
    }


def validate_claim(entry: dict) -> str | None:
    """The reason a claim verdict is invalid, or None. Strict on the enums - the
    body is stored as given, and the digester's eval scores on it."""
    for field in ("variant", "model", "prompt_sha", "claim_id", "text"):
        if not isinstance(entry.get(field), str) or not entry[field]:
            return f"missing or invalid {field}"
    q = entry.get("quality")
    if q is not None and q not in QUALITY:
        return "quality must be bad | okay | good"
    if q is None and "irrelevant" not in entry:
        return "a verdict needs a quality or an irrelevant mark"
    if "irrelevant" in entry and not isinstance(entry["irrelevant"], bool):
        return "irrelevant must be a bool"
    return None


def validate_cluster(entry: dict) -> str | None:
    members = entry.get("members")
    if not isinstance(members, list) or len(members) < 2:
        return "a cluster needs at least two members"
    for m in members:
        if not isinstance(m, dict) or not m.get("variant") or not m.get("claim_id"):
            return "each member needs variant and claim_id"
    best = entry.get("best_variant")
    if best is not None and best not in {m["variant"] for m in members}:
        return "best_variant must be one of the members"
    # `tie` is an EXPLICIT value, distinct from absent (spec): clusters group
    # equivalent claims by construction, so genuine ties are the common case.
    # Absent = not adjudicated (out of the denominator); tie = competed, no win
    # (in the denominator). Without it a reviewer must skip (losing the tie) or
    # pick arbitrarily (noise straight into the win rate).
    tie = entry.get("tie")
    if tie is not None and not isinstance(tie, bool):
        return "tie must be a bool"
    if tie and best is not None:
        return "tie and best_variant are mutually exclusive"
    return None


def upsert_claim(gold: dict, entry: dict) -> dict:
    """Add or replace a claim verdict. Identity: gold_id when given, else the
    (variant, claim_id) pair - so re-judging the same claim updates one entry
    instead of accumulating duplicates. Stamps gold_id; returns the entry."""
    entries = gold.setdefault("claims", [])
    if not entry.get("gold_id"):
        for e in entries:
            if (
                e.get("variant") == entry["variant"]
                and e.get("claim_id") == entry["claim_id"]
            ):
                entry["gold_id"] = e["gold_id"]
                break
    gid = entry.get("gold_id") or mint_gold_id(_ids(gold))
    entry["gold_id"] = gid
    for i, e in enumerate(entries):
        if e.get("gold_id") == gid:
            entries[i] = entry
            return entry
    entries.append(entry)
    return entry


def _member_keys(members: list[dict]) -> set[tuple[str, str]]:
    return {(m.get("variant", ""), m.get("claim_id", "")) for m in members or []}


def upsert_cluster(gold: dict, entry: dict) -> dict:
    """Add or replace a cluster best-of. Identity: gold_id when given, else an
    overlapping member set (clusterings drift between runs; sharing any member
    means it is the same underlying fact group)."""
    entries = gold.setdefault("clusters", [])
    if not entry.get("gold_id"):
        want = _member_keys(entry.get("members", []))
        for e in entries:
            if want & _member_keys(e.get("members", [])):
                entry["gold_id"] = e["gold_id"]
                break
    gid = entry.get("gold_id") or mint_gold_id(_ids(gold))
    entry["gold_id"] = gid
    for i, e in enumerate(entries):
        if e.get("gold_id") == gid:
            entries[i] = entry
            return entry
    entries.append(entry)
    return entry


def remove(gold: dict, gold_id: str) -> bool:
    """Drop an entry (claim or cluster) by id. True if it existed."""
    for key in ("claims", "clusters"):
        entries = gold.get(key, [])
        for i, e in enumerate(entries):
            if e.get("gold_id") == gold_id:
                del entries[i]
                return True
    return False
