#!/usr/bin/env python3
"""Relevance-tuning highlights: sidecar schema and span validation.

Ground-truth highlights for the digester's extraction tuning loop
(anomalica/decisions/drafts/relevance-tuning-mode.md). The sidecar
`{hash}.highlights.json` lives next to the record in ingests/store/.

Offsets are Unicode code points into the raw stored body - the verbatim
text after the closing frontmatter fence, exactly as parse_frontmatter
returns it. Python str indexing is by code point, so body[start:end]
must equal each span's text field.
"""

from __future__ import annotations

import hashlib

HIGHLIGHTS_SCHEMA = "anomalica/highlights/1"


def body_sha256(body: str) -> str:
    """Hash of the exact text the span offsets index (UTF-8 bytes)."""
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


class SpanError(ValueError):
    """A span failed validation; the message is safe to return to the client."""


def validate_spans(
    raw: object,
    body: str,
    *,
    field: str = "spans",
    allow_overlap: bool = False,
) -> list[dict]:
    """Validate and normalise a span list against the body.

    Returns spans sorted by start. Highlight spans must be non-overlapping;
    rejected spans may overlap (two models can emit overlapping junk), so
    callers pass allow_overlap=True for them.
    """
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise SpanError(f"{field} must be a list")

    spans: list[dict] = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            raise SpanError(f"{field}[{i}] must be an object")
        start = item.get("start")
        end = item.get("end")
        if not isinstance(start, int) or not isinstance(end, int):
            raise SpanError(f"{field}[{i}] start/end must be integers")
        if start < 0 or end > len(body) or start >= end:
            raise SpanError(
                f"{field}[{i}] out of range: [{start}, {end}) in body of {len(body)}"
            )
        text = item.get("text")
        if not isinstance(text, str) or body[start:end] != text:
            raise SpanError(f"{field}[{i}] text does not match body[{start}:{end}]")
        span = {"start": start, "end": end, "text": text}
        note = item.get("note")
        if isinstance(note, str) and note.strip():
            span["note"] = note.strip()
        spans.append(span)

    spans.sort(key=lambda s: (s["start"], s["end"]))
    if not allow_overlap:
        for prev, cur in zip(spans, spans[1:]):
            if cur["start"] < prev["end"]:
                raise SpanError(
                    f"{field} must be non-overlapping: "
                    f"[{prev['start']}, {prev['end']}) overlaps [{cur['start']}, {cur['end']})"
                )
    return spans


def build_sidecar(
    record_hash: str,
    body: str,
    complete: bool,
    spans: list[dict],
    rejected: list[dict],
    reviewed_by: str,
    reviewed_at: str,
    complete_ranges: list[dict] | None = None,
) -> dict:
    """Assemble a schema-valid highlights sidecar. Spans must already be
    validated against this exact body.

    `complete_ranges` records WHICH PARTS the reviewer actually swept, and it is
    what makes precision measurable on a record too long to treat wall-to-wall.

    The problem it solves: an unhighlighted sentence is ambiguous. It means
    either "read it, not claim-worthy" or "never looked at it" - and those are
    opposite signals. `complete` (whole record) can only say "all of it" or
    "nothing stated". On the 3.5-hour Jon Stewart video a reviewer sweeping two
    bounded sections must set complete=false, because true would be a lie about
    the other three hours - and eval then has to score recall only, discarding
    the over-extraction signal entirely. That is the noise question, which is the
    one actually being asked.

    Semantics: WITHIN a listed range, unhighlighted means deliberately judged not
    claim-worthy. OUTSIDE every range, unhighlighted means unreviewed and nothing
    is scored there. Absence of evidence is not evidence of absence - the same
    rule the audit applies to passages where only one model filed.

    A RANGE, not a per-span flag: completeness is a property of the reviewer's
    ATTENTION over a region, not of a span. The evidence that matters is the GAPS
    between spans inside a swept region, and a gap has no span to hang a flag on.

    Offsets are body char offsets in the same space as `spans`, checkable against
    the same body_sha256. Additive and optional: existing sidecars stay valid, and
    `complete: true` still means exactly "the whole body is one complete range".
    Converged with anomalica/digester, who consume it in `digester eval`."""
    doc = {
        "schema": HIGHLIGHTS_SCHEMA,
        "record_hash": record_hash,
        "body_sha256": body_sha256(body),
        "complete": bool(complete),
        "reviewed_by": reviewed_by,
        "reviewed_at": reviewed_at,
        "spans": spans,
        "rejected": rejected,
    }
    if complete_ranges:
        doc["complete_ranges"] = complete_ranges
    return doc


def validate_ranges(body: str, ranges: list[dict] | None) -> list[dict]:
    """Validate + normalise complete_ranges against this exact body.

    Overlapping or touching ranges MERGE: two adjacent sweeps are one swept
    region, and leaving them separate would let the same gap be scored twice.
    Ranges are not spans - they may legitimately contain many spans - so the
    non-overlap rule for highlights does not apply here.
    """
    if not ranges:
        return []
    out: list[dict] = []
    for r in ranges:
        try:
            start, end = int(r["start"]), int(r["end"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"complete_range needs int start/end: {r!r}") from exc
        if start < 0 or end > len(body) or start >= end:
            raise ValueError(
                f"complete_range {start}-{end} outside body (0-{len(body)})"
            )
        item = {"start": start, "end": end}
        note = (r.get("note") or "").strip()
        if note:
            item["note"] = note
        out.append(item)
    out.sort(key=lambda r: (r["start"], r["end"]))

    merged: list[dict] = []
    for r in out:
        if merged and r["start"] <= merged[-1]["end"]:
            prev = merged[-1]
            prev["end"] = max(prev["end"], r["end"])
            notes = [n for n in (prev.get("note"), r.get("note")) if n]
            if notes:
                prev["note"] = "; ".join(dict.fromkeys(notes))
        else:
            merged.append(dict(r))
    return merged
