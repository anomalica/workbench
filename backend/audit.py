"""Model/digest audit clustering: compare several extraction variants of one
record against each other, organised by source passage.

The organising axis is the SOURCE PASSAGE - a natural chunk of the record, taken
from where the claims say they came from (`location`, a timecode range on a
transcript). The audit view walks the record passage by passage; within each
passage the claims from every variant are clustered by MEANING so the same fact
phrased differently by different models collapses into one cluster that shows
every variant's wording. A cluster only one variant produced is a SINGLETON -
either unique recall (a fact the others missed) or a hallucination - and is
flagged for the reviewer.

This module is the pure core: it takes already-parsed claims and a similarity
predicate and produces the passage/cluster structure. The two seams it does NOT
own - reading variant YAML off disk, and the embedding model behind the
similarity predicate (the assimilator's fastembed Qwen3 space, keyed by
`embedding_model_id`, never mixed across embedders) - are wired in by the caller,
so the clustering can be tested with a stub similarity and a fake variant.

Adjudication (real / hallucinated / missed) is layered on top of this structure
and persisted separately (the `{hash}.audit.json` gold sidecar); it is not part
of clustering.
"""

from __future__ import annotations

import re

from dataclasses import dataclass, field
from typing import Callable

# --- claims -----------------------------------------------------------------


@dataclass(frozen=True)
class Claim:
    """One extracted claim, tagged with the variant that produced it.

    `variant` is the (model, prompt) extraction's id; `model` is shown to the
    reviewer. `location` is the raw source-location string (a timecode range on
    transcripts); `quote` is the verbatim source span the model cited and `text`
    is the model's claim statement - clustering runs over `text`.

    The epistemic frame (`claim_type`, `attestation`, `speaker`, `refs`) is how
    the model captured the claim - hearsay vs fact, third-hand vs first-hand, who
    said it, what it cites. The audit surfaces it per member so a reviewer can
    see whether one variant flattened it (dropped the attestation or the source
    ref) where another preserved it. `refs` is a tuple so the frozen claim stays
    hashable.
    """

    variant: str
    model: str
    claim_id: str
    location: str
    quote: str
    text: str
    claim_type: str = ""
    attestation: str = ""
    speaker: str = ""
    refs: tuple[str, ...] = ()


# --- source passages --------------------------------------------------------


@dataclass
class TimeSpan:
    """A parsed source location. `timed` locations carry a half-open second
    range `[start, end)` and group by overlap; `untimed` ones (line references,
    or anything not a clock) group by their exact raw string instead - so a
    mixed record's line-based claims never all collapse to time 0.

    NOTE: real extracts mix schemes - HH:MM:SS timecodes (the majority) with
    `lines 54-57` references and bare ranges. The canonical location scheme the
    variant-run will settle on is a digester-side question flagged to the fleet;
    this parser is deliberately conservative until it lands."""

    start: float
    end: float
    raw: str
    timed: bool = True


def _clock_to_seconds(clock: str) -> float | None:
    """`HH:MM:SS.d` / `HH:MM:SS` / `MM:SS` / bare seconds -> seconds, or None if
    not a clock. The canonical transcript scheme the variant-run emits is
    HH:MM:SS.d, so the final field may carry fractional seconds; earlier fields
    are whole numbers."""
    parts = clock.strip().split(":")
    if not parts:
        return None
    secs = 0.0
    for i, raw in enumerate(parts):
        p = raw.strip()
        if p.isdigit():
            secs = secs * 60 + int(p)
        elif i == len(parts) - 1:  # only the seconds field may be fractional
            try:
                secs = secs * 60 + float(p)
            except ValueError:
                return None
        else:
            return None
    return secs


_LINE_REF = re.compile(r"^line\s+(\d+)", re.IGNORECASE)
_BARE_INT = re.compile(r"^(\d+)$")


def line_addressed(claims: list["Claim"]) -> bool:
    """Does this record address its source by LINE rather than by clock?

    Decided from the record's own evidence: if any claim writes `line N`, the
    record is line-addressed, and a bare `N` elsewhere in it means line N - not N
    seconds. This is not a guess about the digester's semantics; it is reading
    what the record itself says, within the record.

    It exists because the models do not agree on the format. On the DoD record
    haiku writes `line 1` while sonnet writes `1`, and on Pajarito haiku writes
    `11` while sonnet writes `line 11` - the same lines, both times. Without
    this, `1` parses as ONE SECOND on a web page, lands in a timed passage, and
    can never meet `line 1` - so the models are never compared and every cluster
    is a false singleton."""
    return any(_LINE_REF.match(c.location.split("(", 1)[0].strip()) for c in claims)


def parse_location(raw: str, lines_regime: bool = False) -> TimeSpan:
    """Parse a source location. A leading `HH:MM:SS[-HH:MM:SS]` (or bare-second)
    clock becomes a timed range; a `lines N-N` / non-clock location stays untimed
    and groups by its CANONICAL string. A trailing `(lines ...)` annotation is
    ignored in favour of the leading clock.

    `lines_regime` says the record addresses source by line (see line_addressed),
    which makes a bare integer a line number rather than a timecode."""
    head = raw.split("(", 1)[0].strip()

    # A line reference is never a timecode. Canonicalise it so `line 11` and a
    # bare `11` in the same record group together instead of splitting the models
    # apart on formatting.
    m = _LINE_REF.match(head)
    if m:
        return TimeSpan(0.0, 0.0, f"line {int(m.group(1))}", timed=False)
    if lines_regime:
        b = _BARE_INT.match(head)
        if b:
            return TimeSpan(0.0, 0.0, f"line {int(b.group(1))}", timed=False)

    if "-" in head:
        lo_str, hi_str = head.split("-", 1)
        lo, hi = _clock_to_seconds(lo_str), _clock_to_seconds(hi_str)
        if lo is not None and hi is not None:
            return TimeSpan(lo, max(lo, hi), raw, timed=True)
    single = _clock_to_seconds(head)
    if single is not None:
        return TimeSpan(single, single, raw, timed=True)
    return TimeSpan(0.0, 0.0, raw, timed=False)


@dataclass
class Cluster:
    """A meaning-cluster of claims within one passage: the same fact as several
    variants stated it. `variants` is the set of variant ids that produced it;
    `singleton` is true when only one did."""

    id: str
    members: list[Claim]

    @property
    def variants(self) -> set[str]:
        return {c.variant for c in self.members}

    @property
    def singleton(self) -> bool:
        return len(self.variants) == 1


@dataclass
class Passage:
    """A source passage and the claims every variant drew from it, clustered by
    meaning. `start`/`end` are the merged second range; `raw_locations` are the
    original location strings that fell in it."""

    index: int
    start: float
    end: float
    raw_locations: list[str]
    clusters: list[Cluster]

    @property
    def variants(self) -> set[str]:
        return {v for cl in self.clusters for v in cl.variants}


# --- clustering -------------------------------------------------------------

# True when two claims mean the same thing (same fact, any phrasing). Injected:
# production passes an embedding-cosine test in the assimilator's vector space;
# tests pass a stub.
Similar = Callable[[Claim, Claim], bool]


def _merge_spans(spans: list[TimeSpan]) -> list[tuple[float, float, list[str]]]:
    """Merge overlapping/adjacent location ranges into passages. Models rarely
    agree on the exact timecode of a passage, so exact-string grouping would
    split one passage across variants; merging by overlap keeps them together.
    Returns (start, end, raw_locations) per passage, in source order."""
    if not spans:
        return []
    ordered = sorted(spans, key=lambda s: (s.start, s.end))
    passages: list[tuple[float, float, list[str]]] = []
    cur_start, cur_end, raws = ordered[0].start, ordered[0].end, [ordered[0].raw]
    for s in ordered[1:]:
        if s.start <= cur_end:  # overlaps or touches the open passage
            cur_end = max(cur_end, s.end)
            raws.append(s.raw)
        else:
            passages.append((cur_start, cur_end, raws))
            cur_start, cur_end, raws = s.start, s.end, [s.raw]
    passages.append((cur_start, cur_end, raws))
    return passages


def _cluster_by_meaning(
    claims: list[Claim], similar: Similar, id_prefix: str
) -> list[Cluster]:
    """Single-link clustering: two claims share a cluster if a chain of
    `similar` links connects them. Order-independent in membership."""
    n = len(claims)
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int) -> None:
        parent[find(i)] = find(j)

    for i in range(n):
        for j in range(i + 1, n):
            if similar(claims[i], claims[j]):
                union(i, j)

    groups: dict[int, list[Claim]] = {}
    for i, claim in enumerate(claims):
        groups.setdefault(find(i), []).append(claim)

    # Order clusters by their earliest member, so the output is stable.
    ordered = sorted(groups.values(), key=lambda g: min(claims.index(c) for c in g))
    return [Cluster(id=f"{id_prefix}-{k}", members=g) for k, g in enumerate(ordered)]


def build_passages(claims: list[Claim], similar: Similar) -> list[Passage]:
    """Group claims into source passages (by merged location range) and cluster
    each passage's claims by meaning. The core of the audit view: one variant's
    unique claim shows as a singleton cluster; a fact several variants share
    shows as one cluster carrying all their phrasings."""
    if not claims:
        return []

    lines_regime = line_addressed(claims)
    spans = {c: parse_location(c.location, lines_regime) for c in claims}
    # Timed claims group into passages by overlapping second-range; untimed ones
    # (line refs, unparseable) group by their exact raw location, ordered after
    # the timed passages so a mixed record still walks time-first.
    timed = [spans[c] for c in claims if spans[c].timed]
    merged = _merge_spans(timed)

    passages: list[Passage] = []
    for start, end, raws in merged:
        raw_set = set(raws)
        members = [c for c in claims if spans[c].timed and spans[c].raw in raw_set]
        passages.append(
            _make_passage(len(passages), start, end, raw_set, members, similar)
        )

    seen: dict[str, list[Claim]] = {}
    for c in claims:
        if not spans[c].timed:
            seen.setdefault(spans[c].raw, []).append(c)
    for raw, members in seen.items():
        passages.append(_make_passage(len(passages), 0.0, 0.0, {raw}, members, similar))

    return passages


def _make_passage(idx, start, end, raw_set, members, similar) -> Passage:
    return Passage(
        index=idx,
        start=start,
        end=end,
        raw_locations=sorted(raw_set),
        clusters=_cluster_by_meaning(members, similar, id_prefix=f"p{idx}"),
    )


# --- variant summary --------------------------------------------------------


@dataclass
class Variant:
    """A single (model, prompt) extraction of the record: its claims and the
    cost the ledger/frontmatter recorded for producing it."""

    id: str
    model: str
    claims: list[Claim]
    cost_usd: float | None = None
    prompt_ids: list[str] = field(default_factory=list)
    # A digest of the prompt SHAs this variant ran. The identity of a comparison
    # is (model, prompt) - two variants are like-for-like only if this matches.
    #
    # It exists because the VERSION LABEL LIES: jon-stewart's opus variant and the
    # haiku/sonnet pairs both declare `version: v3`, while their claims prompts
    # are 403ed351 and 3a766d14 - different prompts wearing the same label. A
    # reviewer comparing those reads a PROMPT difference as a MODEL difference,
    # which is the one conclusion this view exists to support. Only the sha can
    # tell them apart, so the sha is what we key on.
    prompt_fingerprint: str = ""


def passage_compared(passage: Passage) -> bool:
    """Did this passage actually compare models? True only if it holds claims
    from more than one.

    CONFOUNDING IS PER-PASSAGE, not per-record. Clustering only ever runs WITHIN
    a passage, so a passage holding one model produces singletons by
    construction - regardless of whether other passages in the record compared
    fine. A record-level check cannot see it: on the DoD record passage 0 holds
    both models and passage 1 holds only haiku, so the record reads clean while
    passage 1 quietly emits two "only haiku found this" flags.

    Those two are demonstrably false: the assimilator matched both against sonnet
    claims filed under a different location at cosine 0.943 and 0.863 - the same
    facts, labelled '2' by haiku and '1' by sonnet. build_passages never compares
    them because they are in different passages.

    Polarity is deliberate: a suppressed-but-real singleton costs one missed
    observation; a live false singleton puts a fabricated hallucination signal
    into the gold. Wrong-but-visible beats wrong-and-invisible."""
    models = {c.model for cl in passage.clusters for c in cl.members}
    return len(models) > 1


def axis_confounded(passages: list[Passage], variant_count: int) -> str:
    """Is the singleton signal an ARTEFACT of the passage axis rather than a fact
    about the models? Returns a reason, or "" when the axis is sound.

    The audit's whole signal is the singleton: "only one model produced this
    fact". That is only meaningful if the models' claims were ever COMPARED - and
    they are compared only within a passage. Passages group by location, so when
    models phrase locations differently they land in disjoint passages and every
    cluster is a singleton BY CONSTRUCTION, with no model ever having disagreed.

    This is live, not hypothetical. On the Pajarito PDF haiku emits `11` while
    sonnet emits `line 11` - the same line - so parse_location reads haiku's as
    ELEVEN SECONDS (timed) and sonnet's as an untimed string, they never share a
    passage, and the view reports 17/17 singletons: the strongest possible
    unique-recall/hallucination signal, entirely manufactured by string
    formatting. A reviewer cannot tell that from a real result, which is why this
    must be detected rather than left to be noticed.

    The check is deliberately structural, not a location-format heuristic:
    canonical locations are the digester's to define, and guessing at their
    semantics here would trade a visible bug for an invisible one."""
    if variant_count < 2 or not passages:
        # Nothing to compare, or nothing extracted at all: there is no signal
        # here to be false. Flagging an empty record would raise an alarm about
        # clusters that do not exist.
        return ""
    if any(passage_compared(p) for p in passages):
        # At least one passage compared models, so the axis is not wholly broken.
        # Passages that did NOT compare are still suppressed individually - see
        # passage_compared - so a partial failure is caught there rather than
        # here.
        return ""
    return (
        "No passage contains claims from more than one model, so no two models' "
        "claims were ever compared. Every cluster is a singleton by construction, "
        "not by disagreement - the models' locations do not line up."
    )


def claims_of(variants: list[Variant]) -> list[Claim]:
    return [c for v in variants for c in v.claims]
