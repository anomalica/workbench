#!/usr/bin/env python3
"""Ranking what Mark reads next.

The matcher is the part that fails quietly: a ranking built on bad matches still
produces a confident ordered list, and nothing about the output says the order
is noise. So the tests here are mostly about what must NOT match.
"""

import pytest

from backend.review_priority import (
    Priority,
    PageWorthy,
    build_matcher,
    match_terms,
    open_housekeeping,
    rank,
    reading_minutes,
    usable_terms,
)


class TestMatchTerms:
    def test_an_acronym_is_matchable_by_either_half(self):
        assert match_terms("United States Navy (USN)") == {"United States Navy", "USN"}

    def test_an_abbreviation_that_is_not_the_initials_still_counts(self):
        # `DoD` is not D-U-S-D-O-D, and `Caltech` is not CIT, but both are
        # plainly what people write instead of the full name.
        assert "DoD" in match_terms("United States Department of Defense (DoD)")
        assert "Caltech" in match_terms("California Institute of Technology (Caltech)")

    def test_a_disambiguator_never_yields_its_bare_name(self):
        # THE failure this guards. `Science (magazine)` carries a parenthetical
        # precisely because `Science` alone does not identify it, so matching
        # the bare word would score every record that mentions science at all -
        # and the ranking would still look perfectly plausible.
        terms = match_terms("Science (magazine)")
        assert "Science" not in terms
        assert terms == {"Science (magazine)"}

    def test_a_disambiguated_name_keeps_a_distinctive_outer_form(self):
        # Over-correcting costs real matches: text says "the Roswell incident",
        # not "Roswell incident (1947)".
        assert "Roswell incident" in match_terms("Roswell incident (1947)")
        assert "Nordic alien" in match_terms("Nordic alien (type)")

    def test_a_plain_name_is_itself(self):
        assert match_terms("Luis Elizondo") == {"Luis Elizondo"}


class TestUsableTerms:
    def test_drops_terms_too_short_to_be_evidence(self):
        assert usable_terms({"UFO", "AATIP"}) == {"AATIP"}

    def test_drops_words_written_too_often_in_passing(self):
        assert usable_terms({"Congress", "Majestic 12"}) == {"Majestic 12"}


class TestReadingMinutes:
    def test_strips_what_a_reviewer_does_not_read(self):
        # A per-word transcript is mostly timestamps by character count; leaving
        # them in made such records look several times longer than the prose.
        bare = "the quick brown fox jumped over it"
        timestamped = " ".join(
            f"{{{{t:{i}.0}}}}{w}" for i, w in enumerate(bare.split())
        )
        assert reading_minutes(timestamped) == pytest.approx(reading_minutes(bare))

    def test_strips_speaker_comments(self):
        assert reading_minutes("<!-- speaker: Someone -->\nword word") == pytest.approx(
            reading_minutes("word word")
        )

    def test_a_near_empty_record_cannot_divide_its_way_to_the_top(self):
        assert reading_minutes("") >= 0.2


def _page_worthy() -> PageWorthy:
    return build_matcher(
        [
            ("n1", "Luis Elizondo", "page-worthy"),
            ("n2", "Majestic 12 (MJ-12)", "high-bar"),
            ("n3", "Roswell incident (1947)", "page-worthy"),
        ],
        aliases={"n1": ["Advanced Aerospace Threat Identification Program (AATIP)"]},
    )


class TestReach:
    def test_counts_a_node_once_however_often_it_is_named(self):
        # Otherwise a monologue repeating one name outranks a survey that
        # touches five pages.
        pw = _page_worthy()
        assert pw.reach("Luis Elizondo said. Luis Elizondo also said. AATIP.") == ["n1"]

    def test_finds_distinct_nodes(self):
        pw = _page_worthy()
        assert set(pw.reach("Majestic 12 and the Roswell incident")) == {"n2", "n3"}

    def test_does_not_match_inside_a_longer_word(self):
        pw = _page_worthy()
        assert pw.reach("AATIPS AATIP-adjacent") == []

    def test_no_graph_means_no_reach_rather_than_an_error(self):
        empty = PageWorthy()
        assert empty.reach("Luis Elizondo") == []
        assert empty.available is False


class TestHousekeeping:
    def test_counts_only_undecided_proposals(self):
        sidecar = {
            "items": [
                {"status": "proposed"},
                {"status": "approved"},
                {"status": "rejected"},
            ]
        }
        assert open_housekeeping(sidecar) == 1

    def test_absent_or_malformed_is_not_open(self):
        assert open_housekeeping(None) == 0
        assert open_housekeeping({}) == 0
        assert open_housekeeping({"items": "nonsense"}) == 0


class TestRanking:
    def test_orders_by_pages_reached_per_minute(self):
        pw = _page_worthy()
        short = ("cheap", "Luis Elizondo and Majestic 12 and the Roswell incident")
        long = ("dear", "Luis Elizondo " + "filler " * 2000)
        ordered = rank([long, short], pw, {})
        assert [p.content_hash for p in ordered] == ["cheap", "dear"]

    def test_an_open_housekeeping_proposal_holds_a_record_back(self):
        # Not a penalty - a statement that the record is not ready to be read,
        # because its publisher or date may change underneath the review.
        pw = _page_worthy()
        rec = [
            ("blocked", "Luis Elizondo Majestic 12 Roswell incident"),
            ("clear", "Majestic 12"),
        ]
        ordered = rank(rec, pw, {"blocked": {"items": [{"status": "proposed"}]}})
        assert [p.content_hash for p in ordered] == ["clear", "blocked"]
        assert ordered[-1].score == 0.0

    def test_reports_what_reading_it_would_unlock(self):
        pw = _page_worthy()
        [p] = rank([("h", "Majestic 12 and the Roswell incident")], pw, {})
        assert set(p.unlocks) == {"Majestic 12 (MJ-12)", "Roswell incident (1947)"}
        assert p.high_bar == 1

    def test_ties_break_towards_the_cheaper_record(self):
        pw = PageWorthy()
        ordered = rank([("dear", "word " * 500), ("cheap", "word")], pw, {})
        assert [p.content_hash for p in ordered] == ["cheap", "dear"]

    def test_score_survives_serialisation(self):
        p = Priority(
            "h", minutes=2.0, reach=4, high_bar=1, housekeeping_open=0, unlocks=["x"]
        )
        assert p.as_dict()["score"] == 2.0
