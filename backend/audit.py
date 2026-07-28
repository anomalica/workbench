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


@dataclass(frozen=True)
class Node:
    """One entity a model extracted (Pass A's output): a person, organisation,
    place. `node_id` is the model's own uuid, which is REGENERATED every run and
    differs between models for the same entity - so it is provenance, never
    identity. Matching across models keys on (type, name)."""

    variant: str
    model: str
    node_id: str
    type: str
    name: str


def node_key(node: "Node") -> tuple[str, str]:
    """How the same entity is recognised across models: type + case-folded name.

    Deliberately EXACT on the name, not fuzzy. The models do vary their surface
    form ("Stewart, Jon" vs "Jon Stewart"), and matching those is the same
    same-thing? problem the claim clustering solves with embeddings - but a
    silent fuzzy merge here would invent agreement between models that a reviewer
    would then read as a fact about recall. An unmatched pair shows as two rows,
    which is wrong-but-visible; a wrongly-merged pair is wrong-and-invisible.
    Embedding-matched node identity is a later lift, on the same wire as the
    claim clustering."""
    return (node.type.strip().casefold(), node.name.strip().casefold())


@dataclass
class NodeRow:
    """One entity and which variants extracted it. `by_variant` maps a variant id
    to the node it produced, absent when that model did not find this entity -
    the explicit "nothing" the claims grid also renders."""

    type: str
    name: str
    by_variant: dict[str, "Node"]

    @property
    def found_by(self) -> int:
        return len(self.by_variant)

    @property
    def singleton(self) -> bool:
        return self.found_by == 1


@dataclass
class NodeGroup:
    """Entity rows that may be the SAME THING in different words. Grouped, never
    merged: "Stewart, Jon" and "Jon Stewart" are shown side by side so a
    reviewer can see the competing forms and choose, because a silent merge
    invents an agreement between models that then reads as recall."""

    rows: list[NodeRow]

    @property
    def variants(self) -> set[str]:
        return {v for r in self.rows for v in r.by_variant}


def group_node_rows(rows: list[NodeRow], similar: Similar) -> list[NodeGroup]:
    """Single-link grouping of entity rows by name similarity, within a type.
    The predicate is the same one the claims use, so grouping happens in the
    embedding space when it is available and by exact name when it is not."""

    class _Named:
        __slots__ = ("text",)

        def __init__(self, text: str):
            self.text = text

    out: list[NodeGroup] = []
    by_type: dict[str, list[NodeRow]] = {}
    for r in rows:
        by_type.setdefault(r.type, []).append(r)

    for _type, group in by_type.items():
        parent = list(range(len(group)))

        def find(i: int) -> int:
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                if find(i) == find(j):
                    continue
                if similar(_Named(group[i].name), _Named(group[j].name)):
                    parent[find(i)] = find(j)

        buckets: dict[int, list[NodeRow]] = {}
        for i, r in enumerate(group):
            buckets.setdefault(find(i), []).append(r)
        for rs in buckets.values():
            out.append(NodeGroup(rows=sorted(rs, key=lambda r: r.name.casefold())))

    return sorted(
        out, key=lambda g: (g.rows[0].type.casefold(), g.rows[0].name.casefold())
    )


def node_rows(variants: list["Variant"]) -> list[NodeRow]:
    """Every distinct entity across the variants, with which models found it.

    The other half of the two-pass output: comparing WHICH ENTITIES each model
    extracted is as much a model-quality signal as comparing claims, and it was
    invisible until now. Ordered by type then name so the list reads as a stable
    index rather than shuffling per run."""
    rows: dict[tuple[str, str], NodeRow] = {}
    for v in variants:
        for n in v.nodes:
            key = node_key(n)
            row = rows.get(key)
            if row is None:
                row = NodeRow(type=n.type, name=n.name, by_variant={})
                rows[key] = row
            # First writer wins the display casing; a model that repeats an
            # entity within its own digest keeps its first node.
            row.by_variant.setdefault(n.variant, n)
    return sorted(rows.values(), key=lambda r: (r.type.casefold(), r.name.casefold()))


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
    # How this passage was formed. "source" means its members were grouped by
    # MEASURED overlap of their quotes in the record; "location" means the old
    # axis, built from the model-reported location string.
    grouped_by: str = "location"

    @property
    def variants(self) -> set[str]:
        return {v for cl in self.clusters for v in cl.variants}


# --- clustering -------------------------------------------------------------

# True when two claims mean the same thing (same fact, any phrasing). Injected:
# production passes an embedding-cosine test in the assimilator's vector space;
# tests pass a stub.
Similar = Callable[[Claim, Claim], bool]


# A cited range longer than this is not describing a passage - it is describing
# the whole discussion, and merging by overlap lets it swallow the record.
#
# Measured, not guessed. On the jon-stewart record 99% of ranges are <= 40s
# (median 6.4s), but EIGHT claims out of 2078 cite 5+ minutes, up to 03:16:03 -
# and six of those start at the identical 00:04:34.4, which is a model emitting a
# start time with an unrelated end. Because passages merge on overlap, those
# eight chained the entire transcript into ONE passage holding 1864 claims - 85%
# of the record, unreadable and O(n^2) to cluster.
#
# The threshold is deliberately far above normal: 300s is 7.5x the 99th
# percentile, so it separates degenerate locations from dense ones rather than
# tuning where a passage ends. It is not a sensitive knob - 60s, 120s and 300s
# all yield the same shape (599-600 passages, largest 128) because only the
# outliers are affected, and a record with no degenerate ranges is untouched:
# ross-coulthart clamps ZERO claims and its passages are byte-identical at every
# threshold. That property is what keeps this from re-introducing the
# confounding the merge exists to prevent - normal ranges never move.
MAX_CITED_SPAN_S = 300.0


def passage_anchor(span: TimeSpan) -> TimeSpan:
    """Where a claim sits on the passage timeline.

    Normally its own range. A DEGENERATE range (see MAX_CITED_SPAN_S) collapses
    to its start instead: the claim's evidence begins there, so it lands in the
    passage where its citation opens rather than spanning - and being compared
    against - everything after it. The raw location is preserved, so the reviewer
    still sees the full range the model actually cited."""
    if span.timed and (span.end - span.start) > MAX_CITED_SPAN_S:
        return TimeSpan(span.start, span.start, span.raw, timed=True)
    return span


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


# Typography the reader cannot see but a byte comparison can. A source rendered
# with curly quotes and a model quoting it with straight ones are quoting the
# same words; failing to match on that is a fact about punctuation, not about
# the extraction.
_TYPOGRAPHIC = {
    "\u2018": "'",
    "\u2019": "'",
    "\u201a": "'",
    "\u201b": "'",
    "\u201c": '"',
    "\u201d": '"',
    "\u201e": '"',
    "\u201f": '"',
    "\u2013": "-",
    "\u2014": "-",
    "\u2212": "-",
    "\u00a0": " ",
    "\u2026": "...",
}


def normalise_source(text: str) -> str:
    """The one normalisation. BOTH sides of a quote match must use it - the
    prose was being collapsed for whitespace only while the quote also had its
    typography folded, so converting a model's straight quote to match a
    source's curly one guaranteed they could never meet."""
    return _normalise(text)


def _normalise(text: str) -> str:
    for a, b in _TYPOGRAPHIC.items():
        text = text.replace(a, b)
    return re.sub(r"\s+", " ", text).strip()


_MIN_ANCHOR = 20
_PREFIX = 60


def locate_in_source(prose: str, quote: str) -> tuple[int, int] | None:
    """Where a claim's quote sits in the source, or None.

    The claim's own `location` is not this: it is model-reported and then
    re-derived by the aligner, which is how a 50-character quote ended up
    declaring a three-hour span. The quote itself can be found in the text, and
    that is a measurement rather than a claim about itself."""
    q = _normalise(quote)
    if len(q) < _MIN_ANCHOR:
        return None
    i = prose.find(q)
    if i >= 0:
        return (i, i + len(q))

    # An ELIDED quote ("Grusch...will contribute his expertise") is not
    # contiguous text, so it can never match whole. Its first fragment still
    # says where the evidence starts, which is what a reader needs.
    for part in re.split(r"\s*\.\.\.\s*", q):
        part = part.strip()
        if len(part) < _MIN_ANCHOR:
            continue
        j = prose.find(part)
        if j >= 0:
            return (j, j + len(part))

    # A WINDOW ANYWHERE IN THE QUOTE, not just its opening. Anchoring on the
    # first 60 characters meant one altered word at the START defeated the
    # match, however verbatim the rest was: a quote reading "holding those
    # accountable..." where the source says "hold those accountable..." is 180
    # characters of exact text behind one inflected verb, and calling that
    # untraceable is a fact about the matcher rather than about the extraction.
    for start in range(0, max(len(q) - _PREFIX, 0) + 1, _MIN_ANCHOR):
        window = q[start : start + _PREFIX]
        if len(window) < _MIN_ANCHOR:
            break
        i = prose.find(window)
        if i >= 0:
            return (i, i + len(window))
    return None


def build_source_passages(
    claims: list[Claim], similar: Similar, prose: str
) -> list[Passage]:
    """Passages ordered and grouped by WHERE THE CLAIM'S QUOTE APPEARS in the
    record, rather than by the location string the model reported.

    Two things this fixes. ORDER: passages built from location strings do not
    follow the document, so the first passage on screen could come from well
    down the transcript - the reviewer reads the source top to bottom and the
    claims beside it in some other order. GROUPING: locations merge by overlap,
    and one degenerate range swallowed 85% of a record into a single passage;
    grouping on measured quote spans put the largest group at 17 claims instead
    of 128.

    Claims whose quote cannot be found keep the old location-based grouping and
    follow at the end - they are the broken-quote cases, and hiding them would
    hide the signal that a claim's evidence is not in the source."""
    located: list[tuple[int, int, Claim]] = []
    unplaced: list[Claim] = []
    for c in claims:
        span = locate_in_source(prose, c.quote) if prose else None
        if span is None:
            unplaced.append(c)
        else:
            located.append((span[0], span[1], c))

    passages: list[Passage] = []
    located.sort(key=lambda t: (t[0], t[1]))
    group: list[Claim] = []
    group_end = -1
    for start, end, c in located:
        if group and start >= group_end:  # no overlap with the open group
            passages.append(_source_passage(len(passages), group, similar))
            group = []
        group.append(c)
        group_end = max(group_end, end)
    if group:
        passages.append(_source_passage(len(passages), group, similar))

    # Whatever could not be placed keeps the old axis, after the placed ones.
    if unplaced:
        for p in build_passages(unplaced, similar):
            passages.append(
                Passage(
                    index=len(passages),
                    start=p.start,
                    end=p.end,
                    raw_locations=p.raw_locations,
                    clusters=p.clusters,
                )
            )
    return passages


def build_passages(claims: list[Claim], similar: Similar) -> list[Passage]:
    """Group claims into source passages (by merged location range) and cluster
    each passage's claims by meaning. The core of the audit view: one variant's
    unique claim shows as a singleton cluster; a fact several variants share
    shows as one cluster carrying all their phrasings."""
    if not claims:
        return []

    lines_regime = line_addressed(claims)
    spans = {
        c: passage_anchor(parse_location(c.location, lines_regime)) for c in claims
    }
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


def _source_passage(idx: int, members: list["Claim"], similar: Similar) -> Passage:
    """A passage grouped by source position. It keeps the members' own location
    strings for display - the reviewer still sees what each model said the
    timecode was, including when they disagree, which is itself worth seeing."""
    raws = sorted({c.location for c in members if c.location})
    return Passage(
        index=idx,
        start=0.0,
        end=0.0,
        raw_locations=raws,
        clusters=_cluster_by_meaning(members, similar, id_prefix=f"s{idx}"),
        grouped_by="source",
    )


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
    # Pass A's entities. Compared across models by node_rows; they carry no
    # source location, so they sit outside the passage axis entirely.
    nodes: list[Node] = field(default_factory=list)
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
    # When the extraction ran, and each pass's prompt identity. Two variants of
    # one model are told apart by these, not by the model name.
    extracted_at: str = ""
    prompts: list[dict] = field(default_factory=list)


def passage_compared(passage: Passage) -> bool:
    """Did this passage actually compare models? True only if it holds claims
    from more than one.

    ONLY MEANINGFUL ON THE LOCATION AXIS. It exists because passages built from
    location STRINGS could hold one model by accident - the models write their
    timecodes differently, so their claims about one moment landed in different
    passages and every cluster came out a singleton by construction. A passage
    grouped by measured quote overlap has no such accident: one model there means
    one model quoted that text, which is a finding rather than an artefact, and
    suppressing its grading hid 20% of the claims behind no controls at all.

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
