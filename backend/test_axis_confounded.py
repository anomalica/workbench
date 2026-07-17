#!/usr/bin/env python3
"""axis_confounded: is the singleton signal real, or an artefact of the axis?

The audit's entire signal is the singleton - "only one model produced this fact".
It means something ONLY if the models' claims were ever compared, and they are
compared only within a passage. When models phrase locations differently they
land in disjoint passages, nothing is ever compared, and every cluster is a
singleton BY CONSTRUCTION - which a reviewer cannot distinguish from a real
result. This guard is what stops that reaching them as gradeable truth.

Live case it was written for: the Pajarito PDF. haiku emits `11`, sonnet emits
`line 11` - the same line - so parse_location reads haiku's as ELEVEN SECONDS and
sonnet's as an untimed string. 17/17 singletons, entirely manufactured.
"""

from backend.audit import Claim, Cluster, Passage, axis_confounded, passage_compared


def _claim(model: str, text: str, location: str = "1") -> Claim:
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
        refs=[],
    )


def _passage(index: int, *claims: Claim) -> Passage:
    return Passage(
        index=index,
        start=0.0,
        end=0.0,
        raw_locations=[c.location for c in claims],
        clusters=[
            Cluster(id=f"p{index}-{i}", members=[c]) for i, c in enumerate(claims)
        ],
    )


def test_disjoint_passages_are_confounded():
    """The Pajarito shape: each passage holds exactly one model, so no two models
    were ever compared - every singleton is manufactured."""
    passages = [
        _passage(0, _claim("haiku", "a", "11")),
        _passage(1, _claim("sonnet", "a", "line 11")),
    ]
    reason = axis_confounded(passages, variant_count=2)
    assert reason, "must flag: the models never met"
    assert "more than one model" in reason


def test_a_shared_passage_means_the_axis_works():
    """The DoD shape: both models land in one passage, so a singleton there is a
    real disagreement and must NOT be flagged."""
    passages = [_passage(0, _claim("haiku", "a"), _claim("sonnet", "b"))]
    assert axis_confounded(passages, variant_count=2) == ""


def test_one_shared_passage_is_enough_to_clear_it():
    # Mixed record: some passages single-model, one shared. The axis demonstrably
    # can compare, so singletons elsewhere are informative.
    passages = [
        _passage(0, _claim("haiku", "a", "1")),
        _passage(1, _claim("haiku", "b", "2"), _claim("sonnet", "b2", "2")),
    ]
    assert axis_confounded(passages, variant_count=2) == ""


def test_single_variant_records_are_never_confounded():
    # Nothing to compare by definition - a lone model's claims are all singletons
    # and that is simply what one model looks like, not an artefact.
    passages = [_passage(0, _claim("haiku", "a")), _passage(1, _claim("haiku", "b"))]
    assert axis_confounded(passages, variant_count=1) == ""


def test_no_passages_is_not_confounded():
    # An empty record has no false signal to give.
    assert axis_confounded([], variant_count=2) == ""


def test_three_models_all_disjoint_is_confounded():
    passages = [
        _passage(0, _claim("haiku", "a", "1")),
        _passage(1, _claim("sonnet", "a", "line 1")),
        _passage(2, _claim("opus", "a", "page 1")),
    ]
    assert axis_confounded(passages, variant_count=3)


# --- passage_compared: confounding is PER-PASSAGE ---------------------------
#
# The record-level guard passes a record where SOME passage compared models. That
# is not enough: a passage holding one model emits singletons by construction
# whatever its neighbours did. The DoD record is the live case - passage 0 holds
# both models, passage 1 holds only haiku, and passage 1's two "only haiku found
# this" flags are both false (the same facts exist in sonnet's claims under a
# different location label, cosine 0.943 and 0.863).


def test_a_passage_with_two_models_compared():
    p = _passage(0, _claim("haiku", "a"), _claim("sonnet", "b"))
    assert passage_compared(p) is True


def test_a_single_model_passage_did_not_compare():
    p = _passage(1, _claim("haiku", "a"), _claim("haiku", "b"))
    assert passage_compared(p) is False


def test_an_empty_passage_did_not_compare():
    assert (
        passage_compared(
            Passage(index=0, start=0.0, end=0.0, raw_locations=[], clusters=[])
        )
        is False
    )


def test_the_dod_shape_record_passes_but_its_lone_passage_does_not():
    """The gap this closes: the record-level check says fine, while one passage
    inside it is still manufacturing singletons."""
    shared = _passage(0, _claim("haiku", "a", "1"), _claim("sonnet", "a2", "1"))
    lone = _passage(1, _claim("haiku", "b", "2"), _claim("haiku", "c", "2"))
    assert (
        axis_confounded([shared, lone], variant_count=2) == ""
    )  # record: not wholly broken
    assert passage_compared(shared) is True
    assert passage_compared(lone) is False  # ...but this passage must not be graded
