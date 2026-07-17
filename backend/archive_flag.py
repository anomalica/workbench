"""Stamping the archive decision INTO the record.

Archiving moved a record to `store/v1/` and deleted its `records/` symlink, and
left it at that. But `store/v1/` is not a private notation: the scheduler's ingest
lane reads it as the INTAKE QUEUE - "un-ingested sources, go fetch these". So the
folder Mark archives INTO is the folder the GPU lane shops FROM, and archiving a
record offered it straight back for re-transcription. Measured by the scheduler:
22 of his 26 archived records were sitting in the lane, 21 queued for GPU.

The two states are also IDENTICAL on disk - an archived record and a v1 transcript
awaiting re-ingestion are the same bytes in the same place - so the decision can
only be recovered from git commit subjects. A contract made of prose. The flag
makes it data.

The scheduler's skip already reads `archived`; nothing ever wrote it. This does.
"""

from __future__ import annotations

import re

FIELDS = ("archived", "archived_at")

# A TOP-LEVEL frontmatter field: no leading whitespace. The anchor matters -
# frontmatter carries nested maps (`copyright:` has an indented `status:`), so a
# pattern that ignored indentation would strip a nested key of the same name and
# a naive append could land INSIDE the preceding map rather than beside it.
_FIELD_RE = {f: re.compile(rf"^{f}\s*:.*$\n?", re.MULTILINE) for f in FIELDS}
_FRONTMATTER_RE = re.compile(r"\A(---\n)(.*?)(\n?---\n)", re.DOTALL)


def _strip(block: str) -> str:
    for rx in _FIELD_RE.values():
        block = rx.sub("", block)
    return block


def stamp_archived(text: str, archived: bool, at: str | None = None) -> str:
    """Set or clear `archived`/`archived_at` in a record's frontmatter.

    Idempotent: stamping twice yields one pair of fields, not two. Appended at
    the END of the block as top-level (unindented) keys, which closes any
    preceding nested map rather than joining it. Text without frontmatter is
    returned unchanged - inventing a header for a file that has none would be a
    bigger lie than the missing flag.
    """
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return text
    open_tag, block, close_tag = m.groups()

    block = _strip(block).rstrip("\n")
    if archived:
        block += "\narchived: true"
        if at:
            block += f"\narchived_at: {at}"
    return f"{open_tag}{block.lstrip(chr(10))}{close_tag}{text[m.end() :]}"


def is_archived(frontmatter: dict) -> bool:
    """Read the flag tolerantly: YAML may hand back a bool or the string."""
    v = frontmatter.get("archived")
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() in {"true", "yes"}
