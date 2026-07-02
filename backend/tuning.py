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
) -> dict:
    """Assemble a schema-valid highlights sidecar. Spans must already be
    validated against this exact body."""
    return {
        "schema": HIGHLIGHTS_SCHEMA,
        "record_hash": record_hash,
        "body_sha256": body_sha256(body),
        "complete": bool(complete),
        "reviewed_by": reviewed_by,
        "reviewed_at": reviewed_at,
        "spans": spans,
        "rejected": rejected,
    }
