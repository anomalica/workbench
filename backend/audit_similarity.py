"""Similarity predicate for audit clustering.

The real "same fact?" test is embedding-cosine in the assimilator's fastembed
Qwen3 space (`embeddings.EMBEDDING_MODEL_ID`), never mixed across embedders -
that lift is the assimilator's call and wires in later. Until then the scaffold
clusters with a lexical placeholder so the view works end to end on mock data.
The placeholder is deliberately crude: it is not the real similarity and must be
swapped out before the audit view is trusted for adjudication.
"""

from __future__ import annotations

import re

from backend.audit import Claim, Similar

_WORD = re.compile(r"[a-z0-9]+")


def _tokens(text: str) -> set[str]:
    return set(_WORD.findall(text.lower()))


def lexical_similar(threshold: float = 0.6) -> Similar:
    """PLACEHOLDER similarity: Jaccard token overlap over claim `text`. Stands in
    for embedding cosine so the scaffold clusters paraphrases on mock data."""

    def similar(a: Claim, b: Claim) -> bool:
        ta, tb = _tokens(a.text), _tokens(b.text)
        if not ta or not tb:
            return a.text.strip().lower() == b.text.strip().lower()
        overlap = len(ta & tb) / len(ta | tb)
        return overlap >= threshold

    return similar
