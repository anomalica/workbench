#!/usr/bin/env python3
"""Location parsing: `line 11` and a bare `11` are the SAME line.

The models do not agree on how to write a location, and the disagreement is
silent and total. On the DoD record haiku writes `line 1` while sonnet writes
`1`; on Pajarito haiku writes `11` while sonnet writes `line 11`. Same lines,
both times.

Without normalisation a bare `1` parses as ONE SECOND (a timed span) on a web
page, so it can never share a passage with `line 1`. The models are then never
compared, every cluster is a singleton by construction, and the view reports the
strongest possible unique-recall signal from a formatting difference. Measured:
Pajarito 17/17 false singletons, DoD 0/21 gradable. After normalisation: DoD
16/16 gradable in one shared passage, Pajarito 9/13 across real cross-model
clusters.

The regime is inferred from the RECORD'S OWN EVIDENCE (does any claim say
`line N`?), not guessed from the medium - reading what the record says, inside
the record.
"""

from backend.audit import (
    Claim,
    build_passages,
    line_addressed,
    parse_location,
    passage_compared,
)


def _claim(location: str) -> Claim:
    return Claim(
        variant="v",
        model="m",
        claim_id="c",
        location=location,
        quote="q",
        text="t",
        claim_type="observation",
        attestation="reported",
        speaker="",
        refs=(),
    )


def test_line_ref_and_bare_int_canonicalise_together():
    """THE bug: these are the same line and must group together."""
    a = parse_location("line 11", lines_regime=True)
    b = parse_location("11", lines_regime=True)
    assert a.raw == b.raw == "line 11"
    assert not a.timed and not b.timed


def test_line_addressed_is_read_from_the_record():
    assert line_addressed([_claim("line 1"), _claim("1")]) is True
    assert line_addressed([_claim("1"), _claim("2")]) is False
    assert line_addressed([]) is False


def test_without_the_regime_a_bare_int_stays_a_timecode():
    # On a genuinely timed record (audio), `11` means 11 seconds and must not be
    # rewritten into a line reference.
    t = parse_location("11", lines_regime=False)
    assert t.timed is True
    assert t.start == 11.0


def test_a_line_ref_is_never_a_timecode_regardless_of_regime():
    assert parse_location("line 11", lines_regime=False).timed is False


def test_line_ref_canonicalises_case_and_padding():
    assert parse_location("Line 11", lines_regime=False).raw == "line 11"
    assert parse_location("line  011", lines_regime=False).raw == "line 11"


def test_clock_locations_are_untouched_by_the_regime():
    # A real timecode must survive even if some other claim in the record used a
    # line reference - a mixed record must not corrupt its timed spans.
    t = parse_location("00:08:31", lines_regime=True)
    assert t.timed is True
    assert t.start == 511.0


def test_non_numeric_locations_still_group_by_their_string():
    p = parse_location("page 1", lines_regime=True)
    assert p.timed is False
    assert p.raw == "page 1"


# --- the WIRING, not just the function ---------------------------------------
#
# These exist because the unit tests above all PASSED with the normalisation
# disabled in build_passages: they prove parse_location can canonicalise, not
# that anything asks it to. A test that cannot fail when the feature is removed
# is decoration - the mutation (lines_regime = False) collapsed the real DoD
# record from 16/16 gradable to 0/21 while the suite stayed green.


def _c(model: str, location: str, text: str) -> Claim:
    return Claim(
        variant=f"v-{model}",
        model=model,
        claim_id=f"{model}-{text}",
        location=location,
        quote="q",
        text=text,
        claim_type="observation",
        attestation="reported",
        speaker="",
        refs=(),
    )


def test_build_passages_puts_line_1_and_bare_1_in_the_SAME_passage():
    """The DoD shape: haiku writes `line 1`, sonnet writes `1`. If build_passages
    does not apply the regime, these split into a timed and an untimed passage,
    the models never meet, and every cluster is a false singleton."""
    claims = [_c("haiku", "line 1", "a"), _c("sonnet", "1", "b")]
    passages = build_passages(claims, lambda a, b: False)
    assert len(passages) == 1, "the same line must be one passage"
    assert passage_compared(passages[0]) is True, (
        "both models must be present to compare"
    )


def test_build_passages_keeps_a_timed_record_timed():
    # No `line N` anywhere, so bare integers stay seconds and must not be
    # rewritten - an audio record must keep its clock.
    claims = [_c("haiku", "11", "a"), _c("sonnet", "11", "b")]
    passages = build_passages(claims, lambda a, b: False)
    assert len(passages) == 1
    assert passages[0].start == 11.0, "a timed record keeps its timecode"
