#!/usr/bin/env python3
"""Audit clustering: passages by merged source location, meaning-clusters within
them, singleton flagging. Pure - a stub similarity stands in for embeddings."""

from backend.audit import (
    Claim,
    Node,
    Variant,
    node_key,
    node_rows,
    parse_location,
    build_passages,
    build_source_passages,
    claims_of,
    _merge_spans,
    passage_anchor,
    MAX_CITED_SPAN_S,
    TimeSpan,
)


def claim(variant, text, location, cid=None, model=None):
    return Claim(
        variant=variant,
        model=model or variant,
        claim_id=cid or f"{variant}:{text}",
        location=location,
        quote=text,
        text=text,
    )


# Two claims are "the same fact" iff their text matches after lowercasing - a
# deterministic stand-in for embedding-cosine similarity.
def same_text(a, b):
    return a.text.strip().lower() == b.text.strip().lower()


class TestParseLocation:
    def test_parses_hhmmss_range(self):
        span = parse_location("00:02:40-00:02:55")
        assert (span.start, span.end) == (160.0, 175.0)

    def test_parses_mmss_range(self):
        span = parse_location("02:40-03:05")
        assert (span.start, span.end) == (160.0, 185.0)

    def test_unparseable_falls_back_to_zero_keeping_raw(self):
        span = parse_location("intro")
        assert (span.start, span.end, span.raw) == (0.0, 0.0, "intro")

    def test_reversed_range_does_not_go_negative_width(self):
        span = parse_location("00:03:00-00:02:00")
        assert span.end >= span.start

    def test_bare_seconds_range_parses_as_timed(self):
        span = parse_location("67-82")
        assert span.timed and (span.start, span.end) == (67.0, 82.0)

    def test_fractional_seconds_the_canonical_transcript_scheme(self):
        # HH:MM:SS.d - the scheme the variant-run normalises transcripts to.
        span = parse_location("00:02:40.5-00:02:55.0")
        assert span.timed and (span.start, span.end) == (160.5, 175.0)

    def test_fractional_only_allowed_in_the_seconds_field(self):
        assert parse_location("00:2.5:40").timed is False

    def test_line_reference_is_untimed(self):
        span = parse_location("lines 54-57")
        assert span.timed is False and span.raw == "lines 54-57"

    def test_timecode_with_trailing_line_annotation_uses_the_timecode(self):
        # The leading clock wins over the trailing "(lines ...)" annotation;
        # "00:01" reads as MM:SS = 1s (the last field is always seconds).
        span = parse_location("00:01 (lines 2-5)")
        assert span.timed and span.start == 1.0


class TestMergeSpans:
    def test_merges_overlapping_ranges_into_one_passage(self):
        spans = [TimeSpan(160, 175, "a"), TimeSpan(170, 185, "b")]
        merged = _merge_spans(spans)
        assert len(merged) == 1
        assert merged[0][0] == 160 and merged[0][1] == 185

    def test_keeps_disjoint_ranges_separate(self):
        spans = [TimeSpan(0, 30, "a"), TimeSpan(100, 130, "b")]
        merged = _merge_spans(spans)
        assert len(merged) == 2

    def test_touching_ranges_merge(self):
        spans = [TimeSpan(0, 30, "a"), TimeSpan(30, 60, "b")]
        assert len(_merge_spans(spans)) == 1


class TestBuildPassages:
    def test_groups_claims_by_source_passage(self):
        claims = [
            claim("opus", "Jon ran for governor", "00:00:00-00:00:30"),
            claim("opus", "It cost 30000 dollars", "00:01:00-00:01:30"),
        ]
        passages = build_passages(claims, same_text)
        assert len(passages) == 2
        assert passages[0].start == 0.0
        assert passages[1].start == 60.0

    def test_same_fact_from_two_variants_is_one_cluster_with_both_phrasings(self):
        claims = [
            claim("opus", "Jon ran for governor", "00:00:00-00:00:30"),
            claim("haiku", "jon ran for governor", "00:00:00-00:00:30"),  # same, cased
        ]
        passages = build_passages(claims, same_text)
        assert len(passages) == 1
        assert len(passages[0].clusters) == 1
        cluster = passages[0].clusters[0]
        assert cluster.variants == {"opus", "haiku"}
        assert cluster.singleton is False
        assert len(cluster.members) == 2

    def test_flags_a_single_variant_cluster_as_singleton(self):
        claims = [
            claim("opus", "shared fact", "00:00:00-00:00:30"),
            claim("haiku", "shared fact", "00:00:00-00:00:30"),
            claim("opus", "only opus saw this", "00:00:00-00:00:30"),
        ]
        passages = build_passages(claims, same_text)
        clusters = passages[0].clusters
        singletons = [c for c in clusters if c.singleton]
        assert len(singletons) == 1
        assert singletons[0].members[0].text == "only opus saw this"
        assert singletons[0].variants == {"opus"}

    def test_different_facts_in_one_passage_are_separate_clusters(self):
        claims = [
            claim("opus", "fact one", "00:00:00-00:00:30"),
            claim("opus", "fact two", "00:00:00-00:00:30"),
        ]
        passages = build_passages(claims, same_text)
        assert len(passages[0].clusters) == 2

    def test_cross_variant_location_drift_still_groups_one_passage(self):
        # Models rarely agree on the exact timecode; overlapping ranges merge.
        claims = [
            claim("opus", "same fact", "00:02:40-00:02:55"),
            claim("haiku", "same fact", "00:02:45-00:03:00"),
        ]
        passages = build_passages(claims, same_text)
        assert len(passages) == 1
        assert len(passages[0].clusters) == 1
        assert passages[0].clusters[0].variants == {"opus", "haiku"}

    def test_singletons_across_passages(self):
        claims = [
            claim("opus", "a", "00:00:00-00:00:30"),
            claim("haiku", "b", "00:01:00-00:01:30"),
        ]
        passages = build_passages(claims, same_text)
        assert len(passages) == 2
        assert all(len(p.clusters) == 1 and p.clusters[0].singleton for p in passages)

    def test_passages_are_ordered_by_source_time(self):
        claims = [
            claim("opus", "late", "00:05:00-00:05:30"),
            claim("opus", "early", "00:00:00-00:00:30"),
        ]
        passages = build_passages(claims, same_text)
        assert [p.index for p in passages] == [0, 1]
        assert passages[0].start < passages[1].start

    def test_empty_input(self):
        assert build_passages([], same_text) == []

    def test_untimed_line_locations_group_by_exact_string_not_all_at_zero(self):
        # Two different line refs must NOT collapse into one passage.
        claims = [
            claim("opus", "a", "lines 10-12"),
            claim("opus", "b", "lines 40-42"),
        ]
        passages = build_passages(claims, same_text)
        assert len(passages) == 2

    def test_timed_passages_come_before_untimed(self):
        claims = [
            claim("opus", "line claim", "lines 10-12"),
            claim("opus", "time claim", "00:00:10-00:00:20"),
        ]
        passages = build_passages(claims, same_text)
        # The timed passage is first; the untimed line ref follows.
        assert passages[0].clusters[0].members[0].text == "time claim"
        assert passages[1].clusters[0].members[0].text == "line claim"

    def test_membership_is_order_independent(self):
        a = claim("opus", "x", "00:00:00-00:00:30")
        b = claim("haiku", "x", "00:00:00-00:00:30")
        p1 = build_passages([a, b], same_text)
        p2 = build_passages([b, a], same_text)
        assert (
            p1[0].clusters[0].variants
            == p2[0].clusters[0].variants
            == {"opus", "haiku"}
        )


class TestVariant:
    def test_claims_of_flattens_variants(self):
        variants = [
            Variant("opus", "opus", [claim("opus", "a", "0:00-0:30")], cost_usd=6.69),
            Variant(
                "haiku", "haiku", [claim("haiku", "b", "0:00-0:30")], cost_usd=0.12
            ),
        ]
        allc = claims_of(variants)
        assert len(allc) == 2
        assert {c.variant for c in allc} == {"opus", "haiku"}

    def test_build_passages_over_two_variants(self):
        variants = [
            Variant(
                "opus",
                "opus",
                [
                    claim("opus", "shared", "00:00:00-00:00:30"),
                    claim("opus", "opus only", "00:00:00-00:00:30"),
                ],
            ),
            Variant("haiku", "haiku", [claim("haiku", "shared", "00:00:00-00:00:30")]),
        ]
        passages = build_passages(claims_of(variants), same_text)
        assert len(passages) == 1
        shared = [c for c in passages[0].clusters if not c.singleton]
        singles = [c for c in passages[0].clusters if c.singleton]
        assert len(shared) == 1 and shared[0].variants == {"opus", "haiku"}
        assert len(singles) == 1 and singles[0].variants == {"opus"}


def node(variant, name, ntype="person", nid=None):
    return Node(
        variant=variant,
        model=variant,
        node_id=nid or f"{variant}:{name}",
        type=ntype,
        name=name,
    )


class TestNodeComparison:
    def test_same_entity_across_models_is_one_row(self):
        variants = [
            Variant("opus", "opus", [], nodes=[node("opus", "Jon Stewart")]),
            Variant("haiku", "haiku", [], nodes=[node("haiku", "Jon Stewart")]),
        ]
        rows = node_rows(variants)
        assert len(rows) == 1
        assert rows[0].found_by == 2 and not rows[0].singleton
        assert set(rows[0].by_variant) == {"opus", "haiku"}

    def test_entity_only_one_model_found_is_a_singleton(self):
        variants = [
            Variant("opus", "opus", [], nodes=[node("opus", "Ada Lovelace")]),
            Variant("haiku", "haiku", [], nodes=[node("haiku", "Jon Stewart")]),
        ]
        rows = node_rows(variants)
        assert len(rows) == 2
        assert all(r.singleton for r in rows)

    def test_matching_ignores_case_but_not_word_order(self):
        # Case is noise; word order is a genuinely different surface form that
        # only a fuzzy match could join - and a silent fuzzy merge would invent
        # agreement between models. Two rows is wrong-but-visible.
        assert node_key(node("a", "NASA")) == node_key(node("b", "nasa"))
        assert node_key(node("a", "Stewart, Jon")) != node_key(node("b", "Jon Stewart"))

    def test_same_name_different_type_stays_distinct(self):
        variants = [
            Variant(
                "opus",
                "opus",
                [],
                nodes=[
                    node("opus", "Nimitz", ntype="person"),
                    node("opus", "Nimitz", ntype="organisation"),
                ],
            ),
        ]
        assert len(node_rows(variants)) == 2

    def test_a_model_repeating_an_entity_counts_once(self):
        variants = [
            Variant(
                "opus",
                "opus",
                [],
                nodes=[node("opus", "NASA", nid="n1"), node("opus", "NASA", nid="n2")],
            ),
        ]
        rows = node_rows(variants)
        assert len(rows) == 1 and rows[0].found_by == 1
        assert rows[0].by_variant["opus"].node_id == "n1"  # first writer wins

    def test_ordered_by_type_then_name(self):
        variants = [
            Variant(
                "opus",
                "opus",
                [],
                nodes=[
                    node("opus", "Zeta", ntype="person"),
                    node("opus", "Alpha", ntype="person"),
                    node("opus", "Beta", ntype="document"),
                ],
            ),
        ]
        assert [(r.type, r.name) for r in node_rows(variants)] == [
            ("document", "Beta"),
            ("person", "Alpha"),
            ("person", "Zeta"),
        ]

    def test_no_nodes_is_no_rows(self):
        assert node_rows([Variant("opus", "opus", [])]) == []


class TestDegenerateLocations:
    """A claim citing a huge range must not swallow the record.

    Live data: on jon-stewart eight claims of 2078 cite 5+ minutes (one is
    03:16:03 long, six share an identical start with unrelated ends - a model
    emitting a malformed location). Merging by overlap chained the whole
    transcript into ONE passage of 1864 claims.
    """

    def test_a_normal_range_is_untouched(self):
        span = parse_location("00:00:10-00:00:40")
        assert passage_anchor(span) is span

    def test_a_degenerate_range_collapses_to_its_start(self):
        span = parse_location("00:04:34.4-03:16:03.0")
        anchored = passage_anchor(span)
        assert anchored.start == span.start
        assert anchored.end == anchored.start
        # The location the model actually cited is preserved for display.
        assert anchored.raw == span.raw

    def test_an_untimed_location_is_never_anchored(self):
        span = parse_location("line 11")
        assert passage_anchor(span) is span

    def test_the_boundary_is_inclusive(self):
        exactly = parse_location(f"00:00:00-00:0{int(MAX_CITED_SPAN_S // 60)}:00")
        assert passage_anchor(exactly) is exactly  # 300s itself is not degenerate

    def test_one_huge_claim_no_longer_swallows_the_others(self):
        # Without anchoring, the 0-3600s claim overlaps every other and merges
        # them all into a single passage - the shape that made the real record
        # unreadable.
        claims = [
            claim("opus", "spans everything", "00:00:00-01:00:00"),
            claim("opus", "early fact", "00:00:05-00:00:20"),
            claim("haiku", "early fact", "00:00:05-00:00:20"),
            claim("opus", "much later fact", "00:50:00-00:50:30"),
        ]
        passages = build_passages(claims, same_text)
        assert len(passages) > 1
        # The distant claim is no longer compared against the early ones.
        early = [p for p in passages if p.start < 60]
        later = [p for p in passages if p.start > 2000]
        assert early and later
        texts = {c.text for cl in later[0].clusters for c in cl.members}
        assert texts == {"much later fact"}

    def test_the_two_models_still_meet_in_the_same_passage(self):
        # The property the merge exists for: models phrasing a timecode slightly
        # differently must still share a passage. Anchoring must not break it.
        claims = [
            claim("opus", "shared", "00:10:00.0-00:10:12.0"),
            claim("haiku", "shared", "00:10:01.5-00:10:14.0"),
        ]
        passages = build_passages(claims, same_text)
        assert len(passages) == 1
        assert not passages[0].clusters[0].singleton


class TestSourceOrderedPassages:
    """Grouping and ordering by where a claim's quote appears in the record.

    The model-reported location is not that: it is re-derived by the aligner,
    and one degenerate range swallowed 85% of a record into a single passage.
    Ordering by it also meant the first passage on screen could come from well
    down the transcript, so the source read top-to-bottom while the claims
    beside it did not.
    """

    PROSE = (
        "Chapter one opens the story here. "
        "The witness described a bright object over the water. "
        "Later that evening the crew filed their report. "
        "A final unrelated paragraph closes the record."
    )

    def q(self, variant, quote, text=None, location="99:99"):
        return Claim(
            variant=variant,
            model=variant,
            claim_id=f"{variant}:{quote[:8]}",
            location=location,
            quote=quote,
            text=text or quote,
        )

    def test_orders_passages_by_position_in_the_source(self):
        # Deliberately given in the WRONG order, with locations that would sort
        # differently, so only the source position can produce this result.
        claims = [
            self.q(
                "a",
                "A final unrelated paragraph closes the record.",
                location="00:00:01",
            ),
            self.q(
                "a",
                "The witness described a bright object over the water.",
                location="00:00:99",
            ),
            self.q("a", "Chapter one opens the story here.", location="00:00:50"),
        ]
        passages = build_source_passages(claims, same_text, self.PROSE)
        first = [c.text for cl in passages[0].clusters for c in cl.members]
        last = [c.text for cl in passages[-1].clusters for c in cl.members]
        assert first == ["Chapter one opens the story here."]
        assert last == ["A final unrelated paragraph closes the record."]

    def test_groups_claims_whose_quotes_overlap(self):
        claims = [
            self.q("haiku", "The witness described a bright object over the water."),
            self.q(
                "sonnet",
                "witness described a bright object over the water. Later that evening",
            ),
            self.q("opus", "A final unrelated paragraph closes the record."),
        ]
        passages = build_source_passages(claims, same_text, self.PROSE)
        assert len(passages) == 2
        assert {c.variant for cl in passages[0].clusters for c in cl.members} == {
            "haiku",
            "sonnet",
        }
        assert {c.variant for cl in passages[1].clusters for c in cl.members} == {
            "opus"
        }

    def test_one_huge_quote_does_not_swallow_the_record(self):
        # The failure the old axis had: a claim covering everything merged with
        # everything. Overlap on measured spans keeps the distinct ones distinct.
        claims = [
            self.q("a", self.PROSE),
            self.q("b", "A final unrelated paragraph closes the record."),
            self.q("c", "Chapter one opens the story here."),
        ]
        passages = build_source_passages(claims, same_text, self.PROSE)
        assert len(passages) >= 1
        sizes = [sum(len(cl.members) for cl in p.clusters) for p in passages]
        assert sum(sizes) == 3

    def test_an_unlocatable_quote_is_kept_and_placed_last(self):
        # A claim whose evidence is not in the source is the broken-quote
        # signal; dropping it would hide exactly what a reviewer needs to see.
        claims = [
            self.q("a", "Chapter one opens the story here."),
            self.q(
                "b",
                "This sentence appears nowhere in the record at all.",
                location="00:00:05",
            ),
        ]
        passages = build_source_passages(claims, same_text, self.PROSE)
        texts = [c.text for p in passages for cl in p.clusters for c in cl.members]
        assert "This sentence appears nowhere in the record at all." in texts
        assert texts[0] == "Chapter one opens the story here."

    def test_falls_back_entirely_when_there_is_no_source(self):
        claims = [self.q("a", "Chapter one opens the story here.", location="00:00:01")]
        assert len(build_source_passages(claims, same_text, "")) == 1
