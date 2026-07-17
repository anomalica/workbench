#!/usr/bin/env python3
"""The prompt fingerprint: the identity of "which prompt did this variant run?".

A comparison is only like-for-like if (model, prompt) differs in the model alone.
The VERSION LABEL cannot establish that - two variants on disk today both declare
`version: v3` while running different claims prompts - so the fingerprint keys on
the prompt SHAs. If this regresses, a prompt difference reads as a model
difference, which is the one conclusion the audit view exists to support.
"""

from backend.audit_load import prompt_fingerprint


def _doc(*shas: str, version: str = "v3") -> dict:
    return {
        "prompts": [
            {"pass": f"p{i}", "id": f"p{i}", "version": version, "sha256": sha}
            for i, sha in enumerate(shas)
        ]
    }


def test_same_prompts_fingerprint_the_same():
    assert prompt_fingerprint(_doc("aaa", "bbb")) == prompt_fingerprint(
        _doc("aaa", "bbb")
    )


def test_the_real_confound_is_caught():
    """The live case: both say v3, but the claims prompt differs (3a766d14 vs
    403ed351). Identical labels, different prompts - the fingerprint must split
    them or a reviewer compares prompts while believing they compare models."""
    haiku_sonnet = _doc("8751f7f4", "3a766d14", version="v3")
    opus = _doc("8751f7f4", "403ed351", version="v3")
    assert prompt_fingerprint(haiku_sonnet) != prompt_fingerprint(opus)


def test_version_label_alone_would_NOT_have_caught_it():
    # Guards the reason this function exists: the labels are equal, so anything
    # keyed on version would call these like-for-like.
    a = _doc("8751f7f4", "3a766d14", version="v3")
    b = _doc("8751f7f4", "403ed351", version="v3")
    assert [p["version"] for p in a["prompts"]] == [p["version"] for p in b["prompts"]]
    assert prompt_fingerprint(a) != prompt_fingerprint(b)


def test_order_does_not_change_the_fingerprint():
    # The same prompt set listed in a different order is the same prompt set.
    assert prompt_fingerprint(_doc("aaa", "bbb")) == prompt_fingerprint(
        _doc("bbb", "aaa")
    )


def test_absent_or_shaless_prompts_yield_empty():
    # Empty means "unknown", which the UI must treat as NOT verified like-for-like
    # rather than as a match. Never fingerprint a guess.
    assert prompt_fingerprint({}) == ""
    assert prompt_fingerprint({"prompts": []}) == ""
    assert prompt_fingerprint({"prompts": [{"id": "nodes", "version": "v3"}]}) == ""


def test_two_unknowns_are_not_equal_by_accident():
    # Both empty - the UI must not read "" == "" as "same prompt".
    assert prompt_fingerprint({}) == prompt_fingerprint({"prompts": []}) == ""
