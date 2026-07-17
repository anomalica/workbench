#!/usr/bin/env python3
"""The archive flag: making Mark's decision readable as data.

store/v1/ means "archived" to the workbench and "intake queue" to the scheduler,
so archiving a record offered it back to the GPU lane for re-transcription - 22 of
26 archived records were sitting in that lane. The two states are identical on
disk, so the only other record of the decision is a git commit subject: a contract
made of prose.
"""

from backend.archive_flag import is_archived, stamp_archived

RECORD = """---
schema: anomalica/record/1
title: "A Record"
duration: 3004
copyright:
  status: publicly_accessible
---

The body text.
"""


def test_stamping_adds_top_level_fields():
    out = stamp_archived(RECORD, True, "2026-07-17T20:00:00Z")
    assert "\narchived: true\n" in out
    assert "\narchived_at: 2026-07-17T20:00:00Z\n" in out
    assert out.endswith("The body text.\n"), "the body must be untouched"


def test_the_flag_lands_OUTSIDE_the_nested_copyright_map():
    """The trap: frontmatter has nested maps. An indented append would make
    `archived` a member of `copyright`, where nobody reads it."""
    out = stamp_archived(RECORD, True, "2026-07-17T20:00:00Z")
    fm = out.split("---")[1]
    for line in fm.splitlines():
        if line.startswith("archived"):
            assert not line.startswith(" "), "must be top-level, not nested"
    # and it must parse as a top-level key
    import yaml

    assert yaml.safe_load(fm)["archived"] is True
    assert yaml.safe_load(fm)["copyright"]["status"] == "publicly_accessible"


def test_stamping_is_idempotent():
    once = stamp_archived(RECORD, True, "2026-07-17T20:00:00Z")
    twice = stamp_archived(once, True, "2026-07-17T20:00:00Z")
    assert twice == once
    assert twice.count("archived: true") == 1


def test_restamping_replaces_rather_than_duplicates():
    a = stamp_archived(RECORD, True, "2026-01-01T00:00:00Z")
    b = stamp_archived(a, True, "2026-07-17T20:00:00Z")
    assert b.count("archived_at:") == 1
    assert "2026-07-17T20:00:00Z" in b and "2026-01-01" not in b


def test_unarchiving_clears_both_fields():
    a = stamp_archived(RECORD, True, "2026-07-17T20:00:00Z")
    back = stamp_archived(a, False)
    assert "archived" not in back.split("---")[1]
    import yaml

    assert (
        yaml.safe_load(back.split("---")[1])["copyright"]["status"]
        == "publicly_accessible"
    )


def test_clearing_a_record_that_was_never_archived_is_a_no_op():
    assert stamp_archived(RECORD, False) == RECORD


def test_text_without_frontmatter_is_returned_unchanged():
    # Inventing a header for a file that has none is a bigger lie than the
    # missing flag.
    plain = "no frontmatter here\n"
    assert stamp_archived(plain, True, "now") == plain


def test_is_archived_reads_bool_or_string():
    assert is_archived({"archived": True}) is True
    assert is_archived({"archived": "true"}) is True
    assert is_archived({"archived": False}) is False
    assert is_archived({}) is False
