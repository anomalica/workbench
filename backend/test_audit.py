#!/usr/bin/env python3
"""Audit clustering: passages by merged source location, meaning-clusters within
them, singleton flagging. Pure - a stub similarity stands in for embeddings."""

from backend.audit import (
    Claim,
    Variant,
    parse_location,
    build_passages,
    claims_of,
    _merge_spans,
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
