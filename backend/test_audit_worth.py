#!/usr/bin/env python3
"""The `worth` axis: is a correctly-extracted claim actually worth having?

Orthogonal to `verdict`, which is about CORRECTNESS. The two are independent - a
claim can be `real` (accurate, correctly attributed, faithfully worded) and still
be `noise`. Every verdict in the original vocabulary was a correctness verdict, so
the gold could not express Mark's actual complaint ("haiku is pulling out a lot of
low value facts that are quite unrelated to anything of value"), and a grader
scoring precision on correctness alone would rank haiku well on exactly the axis
he objects to.
"""

from backend import audit_gold


def test_the_two_axes_are_separate_vocabularies():
    # If worth ever became a fifth verdict, this fails - and we would have lost
    # which knob to turn: a hallucination is a fidelity bug, noise is a curation
    # policy choice.
    assert set(audit_gold.WORTH) == {"carries", "incidental", "noise"}
    assert not set(audit_gold.WORTH) & set(audit_gold.CLUSTER_VERDICTS)


def test_worth_is_optional_so_existing_gold_stays_valid():
    gold = {"adjudications": []}
    audit_gold.upsert(gold, {"verdict": "real", "text": "t"})
    entry = gold["adjudications"][0]
    assert "worth" not in entry, "an ungraded claim reads as ungraded, not as fine"


def test_worth_round_trips_on_a_real_claim():
    gold = {"adjudications": []}
    audit_gold.upsert(gold, {"verdict": "real", "worth": "noise", "text": "t"})
    assert gold["adjudications"][0]["worth"] == "noise"


def test_a_real_claim_can_be_noise():
    """The case the axis exists for: correctly extracted AND worthless."""
    gold = {"adjudications": []}
    audit_gold.upsert(
        gold, {"verdict": "real", "worth": "noise", "text": "boilerplate"}
    )
    e = gold["adjudications"][0]
    assert e["verdict"] == "real" and e["worth"] == "noise"
