#!/usr/bin/env python3
"""Compact human-gold review over canonical inline highlight units."""

from __future__ import annotations

import hashlib
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

import yaml

GOLD_SCHEMA = "anomalica/highlight-gold/1"
VIEW_SCHEMA = "anomalica/highlight-gold-view/1"
DECISIONS = {"accept", "adjust", "split", "reject", "defer"}
BATCH_SIZE = 5

_MARKER = re.compile(r"\{\{highlight-(start|end):\s*([A-Za-z0-9_-]+)\s*\}\}")
_CONTEXT = re.compile(
    r"\{\{highlight-context:\s*\[\s*([A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)+)\s*\]\s*\}\}"
)
_HIDDEN = re.compile(
    r"<!--[\s\S]*?-->|\{\{(?:t:[^}]+|highlight-(?:start|end):[^}]+|highlight-context:[^}]+)\}\}|"
    r"^\d{2}:\d{2}:\d{2}(?:\.\d+)?[ \t]",
    re.MULTILINE,
)
_TYPOGRAPHIC = str.maketrans(
    {
        "\u2018": "'",
        "\u2019": "'",
        "\u201a": "'",
        "\u201b": "'",
        "\u201c": '"',
        "\u201d": '"',
        "\u201e": '"',
        "\u201f": '"',
        "\u2013": "-",
        "\u2014": "-",
        "\u2212": "-",
        "\u00a0": " ",
    }
)


class GoldError(ValueError):
    """A request or source invariant failed; its message is client-safe."""


def body_sha256(body: str) -> str:
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def bound_body_sha256(body: str) -> str:
    return f"sha256:{body_sha256(body)}"


def _display_text(text: str) -> str:
    text = _HIDDEN.sub("", text)
    return re.sub(r"\s+", " ", text).strip()


def parse_units(body: str) -> list[dict]:
    """Resolve every paired marker into multipart units in source order."""
    open_parts: dict[str, list[int]] = {}
    parts: dict[str, list[dict]] = {}
    order: dict[str, int] = {}
    for marker in _MARKER.finditer(body):
        kind, highlight_id = marker.groups()
        if kind == "start":
            open_parts.setdefault(highlight_id, []).append(marker.end())
            continue
        starts = open_parts.get(highlight_id)
        if not starts:
            continue
        start = starts.pop()
        if marker.start() <= start:
            continue
        part = {
            "start": start,
            "end": marker.start(),
            "text": _display_text(body[start : marker.start()]),
        }
        parts.setdefault(highlight_id, []).append(part)
        order.setdefault(highlight_id, start)

    # Ingest-format orphan semantics: an unmatched start extends to body end;
    # an unmatched end was ignored above. Both consumers therefore resolve the
    # same source unit after one half is removed by an edit.
    for highlight_id, starts in open_parts.items():
        for start in starts:
            if start >= len(body):
                continue
            parts.setdefault(highlight_id, []).append(
                {"start": start, "end": len(body), "text": _display_text(body[start:])}
            )
            order.setdefault(highlight_id, start)

    contexts: dict[str, list[str]] = {}
    for edge in _CONTEXT.finditer(body):
        ids = [item.strip() for item in edge.group(1).split(",")]
        dependent, ancestors = ids[0], ids[1:]
        target = contexts.setdefault(dependent, [])
        for ancestor in ancestors:
            if ancestor != dependent and ancestor not in target:
                target.append(ancestor)

    units = [
        {
            "highlight_id": highlight_id,
            "parts": sorted(unit_parts, key=lambda item: (item["start"], item["end"])),
        }
        for highlight_id, unit_parts in parts.items()
    ]
    units.sort(key=lambda unit: (order[unit["highlight_id"]], unit["highlight_id"]))
    by_id = {unit["highlight_id"]: unit for unit in units}

    def ancestors_of(highlight_id: str) -> tuple[list[str], str | None]:
        found: list[str] = []
        visiting: set[str] = set()
        issue: str | None = None

        def visit(current: str) -> None:
            nonlocal issue
            if current in visiting:
                issue = "cyclic context link"
                return
            visiting.add(current)
            for ancestor in contexts.get(current, []):
                ancestor_unit = by_id.get(ancestor)
                if ancestor_unit is None:
                    issue = f"dangling context link to {ancestor}"
                    continue
                if (
                    ancestor_unit["parts"][0]["start"]
                    >= by_id[current]["parts"][0]["start"]
                ):
                    issue = f"forward context link to {ancestor}"
                    continue
                visit(ancestor)
                if ancestor not in found:
                    found.append(ancestor)
            visiting.remove(current)

        visit(highlight_id)
        found.sort(key=lambda item: order[item])
        return found, issue

    for unit in units:
        ancestor_ids, issue = ancestors_of(unit["highlight_id"])
        unit["context"] = [
            {"highlight_id": ancestor, "parts": by_id[ancestor]["parts"]}
            for ancestor in ancestor_ids
        ]
        unit["context_issue"] = issue
    return units


def units_in_range(
    units: list[dict], start: int, end: int
) -> tuple[list[dict], list[dict]]:
    contained: list[dict] = []
    boundary: list[dict] = []
    for unit in units:
        parts = unit["parts"]
        if all(part["start"] >= start and part["end"] <= end for part in parts):
            contained.append(unit)
            continue
        intersects = any(part["start"] < end and part["end"] > start for part in parts)
        has_inside_part = any(
            part["start"] >= start and part["end"] <= end for part in parts
        )
        if intersects or has_inside_part:
            boundary.append(unit)
    return contained, boundary


def reviewer_from_user(user: dict) -> dict:
    subject = user.get("id") or user.get("subject")
    if subject is None:
        raise GoldError("GitHub identity missing; log out and log in again")
    return {
        "issuer": "github",
        "subject": str(subject),
        "name": str(user.get("name") or user.get("login") or subject),
    }


def empty_sidecar(record_hash: str, body: str) -> dict:
    return {
        "schema": GOLD_SCHEMA,
        "record_hash": f"sha256:{record_hash}",
        "body_sha256": bound_body_sha256(body),
        "ranges": [],
    }


def validate_sidecar(raw: object, record_hash: str, body: str) -> tuple[dict, bool]:
    if raw is None:
        return empty_sidecar(record_hash, body), False
    if not isinstance(raw, dict) or raw.get("schema") != GOLD_SCHEMA:
        raise GoldError("Existing gold sidecar has an unsupported schema")
    if raw.get("record_hash") != f"sha256:{record_hash}":
        raise GoldError("Existing gold sidecar names another record")
    return raw, raw.get("body_sha256") != bound_body_sha256(body)


def select_range(
    sidecar: dict,
    reviewer: dict,
    body_length: int,
    *,
    range_id: str | None = None,
    start: int | None = None,
    end: int | None = None,
) -> dict:
    ranges = sidecar.get("ranges") or []
    if range_id:
        selected = next((item for item in ranges if item.get("id") == range_id), None)
        if selected is None:
            raise GoldError("Unknown review range")
        if (
            selected.get("reviewer", {}).get("issuer") != reviewer["issuer"]
            or selected.get("reviewer", {}).get("subject") != reviewer["subject"]
        ):
            raise GoldError("Review range belongs to another reviewer")
        return selected

    if start is None and end is None:
        resumable = [
            item
            for item in ranges
            if not item.get("complete")
            and item.get("reviewer", {}).get("issuer") == reviewer["issuer"]
            and item.get("reviewer", {}).get("subject") == reviewer["subject"]
        ]
        if resumable:
            return max(resumable, key=lambda item: item.get("updated_at", ""))
        start, end = 0, body_length
    elif start is None or end is None:
        raise GoldError("Both range start and end are required")
    if (
        isinstance(start, bool)
        or isinstance(end, bool)
        or not isinstance(start, int)
        or not isinstance(end, int)
        or start < 0
        or start >= end
        or end > body_length
    ):
        raise GoldError(f"Review range must be within 0-{body_length}")
    for item in ranges:
        if item.get("start") == start and item.get("end") == end:
            if item.get("reviewer", {}).get("subject") == reviewer["subject"]:
                return item
        if start < item.get("end", 0) and item.get("start", 0) < end:
            raise GoldError("Review ranges must not overlap")
    return {
        "id": uuid.uuid4().hex,
        "start": start,
        "end": end,
        "complete": False,
        "reviewer": reviewer,
        "updated_at": None,
        "units": [],
    }


def next_batch(units: list[dict], range_record: dict) -> list[dict]:
    decisions = {
        item.get("highlight_id"): item
        for item in range_record.get("units") or []
        if isinstance(item, dict)
    }
    never_reviewed = [unit for unit in units if unit["highlight_id"] not in decisions]
    deferred = [
        unit
        for unit in units
        if decisions.get(unit["highlight_id"], {}).get("decision") == "defer"
    ]
    return (never_reviewed + deferred)[:BATCH_SIZE]


def _normalised_visible(body: str) -> tuple[str, list[int]]:
    chars: list[str] = []
    indices: list[int] = []
    position = 0
    for hidden in _HIDDEN.finditer(body):
        for raw_index, char in enumerate(body[position : hidden.start()], position):
            chars.append(char.translate(_TYPOGRAPHIC))
            indices.append(raw_index)
        position = hidden.end()
    for raw_index, char in enumerate(body[position:], position):
        chars.append(char.translate(_TYPOGRAPHIC))
        indices.append(raw_index)

    normalised: list[str] = []
    mapped: list[int] = []
    previous_space = True
    for char, raw_index in zip(chars, indices):
        if char.isspace():
            if previous_space:
                continue
            normalised.append(" ")
            mapped.append(raw_index)
            previous_space = True
        else:
            normalised.append(char)
            mapped.append(raw_index)
            previous_space = False
    if normalised and normalised[-1] == " ":
        normalised.pop()
        mapped.pop()
    return "".join(normalised), mapped


def _quote_ranges(body: str, quote: str) -> list[tuple[int, int]]:
    visible, mapping = _normalised_visible(body)
    ranges: list[tuple[int, int]] = []
    fragments = re.split(r"\s*(?:\.\.\.|\u2026)\s*", quote)
    for fragment in fragments:
        needle = re.sub(r"\s+", " ", fragment.translate(_TYPOGRAPHIC)).strip()
        if not needle:
            continue
        at = visible.find(needle)
        if at < 0 or visible.find(needle, at + 1) >= 0:
            continue
        ranges.append((mapping[at], mapping[at + len(needle) - 1] + 1))
    return ranges


def load_digest_documents(
    digests_path: Path, canonical_path: Path | None
) -> list[dict]:
    if canonical_path is None:
        return []
    paths = [canonical_path]
    variants = digests_path / "variants" / canonical_path.stem
    if variants.is_dir():
        paths.extend(sorted(variants.glob("*.yaml")))
    documents: list[dict] = []
    for path in paths:
        try:
            doc = yaml.safe_load(path.read_text())
        except (OSError, yaml.YAMLError):
            continue
        if isinstance(doc, dict):
            documents.append(doc)
    return documents


def proposals_for_units(
    body: str, units: list[dict], documents: list[dict]
) -> dict[str, list[dict]]:
    proposals: dict[str, list[dict]] = {unit["highlight_id"]: [] for unit in units}
    seen: dict[str, set[str]] = {unit["highlight_id"]: set() for unit in units}
    for document in documents:
        for section in ("domain_claims", "infrastructure_claims"):
            for claim in document.get(section) or []:
                if not isinstance(claim, dict):
                    continue
                text = str(claim.get("text") or "").strip()
                quote = str(claim.get("quote") or "").strip()
                if not text or not quote:
                    continue
                aligned = _quote_ranges(body, quote)
                if not aligned:
                    continue
                key = re.sub(r"\s+", " ", text).casefold()
                for unit in units:
                    overlaps = any(
                        quote_start < part["end"] and part["start"] < quote_end
                        for quote_start, quote_end in aligned
                        for part in unit["parts"]
                    )
                    highlight_id = unit["highlight_id"]
                    if overlaps and key not in seen[highlight_id]:
                        proposals[highlight_id].append({"text": text, "quote": quote})
                        seen[highlight_id].add(key)
    return proposals


def build_view(
    sidecar: dict,
    range_record: dict,
    body: str,
    all_units: list[dict],
    documents: list[dict],
    *,
    stale: bool = False,
) -> dict:
    contained, boundary = units_in_range(
        all_units, range_record["start"], range_record["end"]
    )
    batch = (
        []
        if stale or range_record.get("complete")
        else next_batch(contained, range_record)
    )
    proposals = proposals_for_units(body, batch, documents)
    batch = [{**unit, "proposals": proposals[unit["highlight_id"]]} for unit in batch]
    decisions = {
        item.get("highlight_id"): item.get("decision")
        for item in range_record.get("units") or []
        if isinstance(item, dict)
    }
    resolved = sum(
        decision in {"accept", "adjust", "split", "reject"}
        for decision in decisions.values()
    )
    deferred = sum(decision == "defer" for decision in decisions.values())
    return {
        "schema": VIEW_SCHEMA,
        "record_hash": sidecar["record_hash"],
        "body_sha256": bound_body_sha256(body),
        "body_length": len(body),
        "stale": stale,
        "range": range_record,
        "progress": {
            "total": len(contained),
            "resolved": resolved,
            "deferred": deferred,
            "boundary_count": len(boundary),
        },
        "boundary_cases": [
            {"highlight_id": unit["highlight_id"], "parts": unit["parts"]}
            for unit in boundary
        ],
        "batch": batch,
    }


def validate_batch_decisions(raw: object, batch: list[dict]) -> list[dict]:
    if not isinstance(raw, list):
        raise GoldError("decisions must be a list")
    expected = [unit["highlight_id"] for unit in batch]
    if len(raw) != len(expected):
        raise GoldError("Every unit in the current batch needs a decision")
    by_id = {unit["highlight_id"]: unit for unit in batch}
    output: list[dict] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            raise GoldError("Each decision must be an object")
        highlight_id = item.get("highlight_id")
        decision = item.get("decision")
        if highlight_id not in by_id or highlight_id in seen:
            raise GoldError("Decisions must name each current batch unit exactly once")
        if decision not in DECISIONS:
            raise GoldError(f"Invalid decision for {highlight_id}")
        seen.add(highlight_id)
        facts_raw = item.get("facts")
        facts = []
        if facts_raw is not None:
            if not isinstance(facts_raw, list) or not all(
                isinstance(fact, str) for fact in facts_raw
            ):
                raise GoldError(f"Facts for {highlight_id} must be a list of strings")
            facts = [fact.strip() for fact in facts_raw if fact.strip()]
            if len(facts) != len(facts_raw) or len(set(facts)) != len(facts):
                raise GoldError(
                    f"Facts for {highlight_id} must be non-empty and unique"
                )
        if decision == "accept":
            proposed = {
                proposal["text"] for proposal in by_id[highlight_id]["proposals"]
            }
            if len(facts) != 1 or facts[0] not in proposed:
                raise GoldError("accept requires exactly one unchanged proposed fact")
        elif decision == "adjust" and len(facts) < 1:
            raise GoldError("adjust requires one or more facts")
        elif decision == "split" and len(facts) < 2:
            raise GoldError("split requires two or more facts")
        elif decision in {"reject", "defer"} and facts:
            raise GoldError(f"{decision} forbids facts")
        if decision != "defer" and by_id[highlight_id].get("context_issue"):
            raise GoldError(
                f"{highlight_id} must be deferred until its context link is resolved"
            )
        normalised = {"highlight_id": highlight_id, "decision": decision}
        if facts:
            normalised["facts"] = facts
        output.append(normalised)
    output.sort(key=lambda item: expected.index(item["highlight_id"]))
    return output


def apply_batch(
    sidecar: dict,
    range_record: dict,
    decisions: list[dict],
    contained_units: list[dict],
    *,
    complete: bool,
    now: str | None = None,
) -> dict:
    timestamp = now or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    existing = {item["highlight_id"]: item for item in range_record.get("units") or []}
    existing.update({item["highlight_id"]: item for item in decisions})
    source_order = {
        unit["highlight_id"]: index for index, unit in enumerate(contained_units)
    }
    range_record["units"] = sorted(
        existing.values(), key=lambda item: source_order[item["highlight_id"]]
    )
    range_record["updated_at"] = timestamp
    if complete:
        unresolved = [
            unit
            for unit in contained_units
            if existing.get(unit["highlight_id"], {}).get("decision")
            not in {"accept", "adjust", "split", "reject"}
            or unit.get("context_issue")
        ]
        if unresolved:
            raise GoldError(
                "Range cannot be completed while units are undecided, deferred, or have invalid context"
            )
        range_record["complete"] = True
        range_record["attested_at"] = timestamp
    else:
        range_record["complete"] = False
        range_record.pop("attested_at", None)
    ranges = sidecar.setdefault("ranges", [])
    for index, item in enumerate(ranges):
        if item.get("id") == range_record["id"]:
            ranges[index] = range_record
            break
    else:
        ranges.append(range_record)
    return sidecar
