#!/usr/bin/env python3
"""A brief lives at <section>/<slug>.yaml, and a page is the pair.

The slug is unique only within a node type, so an event and a project of one
name share a slug. Keyed on the slug alone, one file served both pages and the
scheduler re-emitted the loser forever. These tests pin the two things that
must hold: lookups key on the node, and a slug alone never resolves a brief.
"""

from pathlib import Path

import pytest

from backend import pages


def _brief(
    path: Path, *, node_id: str, node_type: str, slug: str, total: int, h: str
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "schema: anomalica/brief/1\n"
        f"brief_hash: {h}\n"
        "page:\n"
        "  kind: entity\n"
        f"  node_id: {node_id}\n"
        f"  node_type: {node_type}\n"
        f"  title: {slug}\n"
        f"  slug: {slug}\n"
        "  claim_count: 3\n"
        f"  claim_count_total: {total}\n"
        "generated:\n"
        "  graph_version: '2026-09-02'\n"
        "related_nodes:\n"
        "- node_id: other-node\n"
        "  title: Other\n"
        "  node_type: person\n"
        "  slug: a-neighbour-not-the-page\n"
        "  shared_claims: 1\n"
        "claims: []\n"
    )


@pytest.fixture
def briefs(tmp_path, monkeypatch) -> Path:
    monkeypatch.setenv("ANOMALICA_BRIEFS_DIR", str(tmp_path))
    return tmp_path


class TestBriefIndex:
    def test_two_pages_with_one_slug_are_two_briefs(self, briefs):
        _brief(
            briefs / "events" / "apollo-14.yaml",
            node_id="ev",
            node_type="event",
            slug="apollo-14",
            total=10,
            h="a" * 16,
        )
        _brief(
            briefs / "projects" / "apollo-14.yaml",
            node_id="pr",
            node_type="project",
            slug="apollo-14",
            total=4,
            h="b" * 16,
        )
        idx = pages.brief_index()
        assert idx["ev"]["section"] == "events"
        assert idx["pr"]["section"] == "projects"
        assert idx["ev"]["claim_total"] == 10
        assert idx["pr"]["claim_total"] == 4

    def test_a_disambiguated_slug_is_found_by_its_node(self, briefs):
        # The name-derived slug is `apollo-14`; the collision loser was written
        # under a suffixed one. Keyed on the name it would not be found at all.
        _brief(
            briefs / "projects" / "apollo-14-1a2b3c.yaml",
            node_id="pr",
            node_type="project",
            slug="apollo-14-1a2b3c",
            total=4,
            h="b" * 16,
        )
        assert pages.brief_index()["pr"]["slug"] == "apollo-14-1a2b3c"

    def test_the_pre_section_layout_is_never_read(self, briefs):
        _brief(
            briefs / "apollo-14.yaml",
            node_id="ev",
            node_type="event",
            slug="apollo-14",
            total=10,
            h="a" * 16,
        )
        assert pages.brief_index() == {}

    def test_reads_the_page_block_not_a_neighbour(self, briefs):
        # related_nodes carries slug lines at the same indent; a regex over the
        # head could take the neighbour's. The head parses the page block only.
        _brief(
            briefs / "people" / "ryan-graves.yaml",
            node_id="rg",
            node_type="person",
            slug="ryan-graves",
            total=7,
            h="c" * 16,
        )
        head = pages._brief_head(briefs / "people" / "ryan-graves.yaml")
        assert head["page"]["slug"] == "ryan-graves"
        assert head["brief_hash"] == "c" * 16


class TestReadBrief:
    def test_addressed_by_the_pair(self, briefs):
        _brief(
            briefs / "events" / "apollo-14.yaml",
            node_id="ev",
            node_type="event",
            slug="apollo-14",
            total=10,
            h="a" * 16,
        )
        _brief(
            briefs / "projects" / "apollo-14.yaml",
            node_id="pr",
            node_type="project",
            slug="apollo-14",
            total=4,
            h="b" * 16,
        )
        assert pages.read_brief("events", "apollo-14")["brief_hash"] == "a" * 16
        assert pages.read_brief("projects", "apollo-14")["brief_hash"] == "b" * 16
        assert pages.read_brief("people", "apollo-14") is None

    def test_a_reference_that_is_not_a_slug_is_refused_before_it_is_a_path(
        self, briefs
    ):
        _brief(
            briefs / "events" / "apollo-14.yaml",
            node_id="ev",
            node_type="event",
            slug="apollo-14",
            total=10,
            h="a" * 16,
        )
        assert pages.read_brief("..", "apollo-14") is None
        assert pages.read_brief("events", "../events/apollo-14") is None
        assert pages.read_brief("events/", "apollo-14") is None
        assert pages.read_brief("Events", "apollo-14") is None


class TestPublishedPages:
    def test_staleness_is_judged_against_the_page_s_own_section(
        self, briefs, tmp_path, monkeypatch
    ):
        content = tmp_path / "content"
        monkeypatch.setenv("ANOMALICA_CONTENT_DIR", str(content))
        (content / "pages" / "events").mkdir(parents=True)
        (content / "pages" / "events" / "apollo-14.en.md").write_text(
            "---\ntitle: Apollo 14\nbrief_hash: " + "a" * 16 + "\n---\n"
        )
        # The events brief matches; a projects brief of the same slug does not,
        # and must not be the one consulted.
        _brief(
            briefs / "events" / "apollo-14.yaml",
            node_id="ev",
            node_type="event",
            slug="apollo-14",
            total=10,
            h="a" * 16,
        )
        _brief(
            briefs / "projects" / "apollo-14.yaml",
            node_id="pr",
            node_type="project",
            slug="apollo-14",
            total=4,
            h="b" * 16,
        )
        [page] = pages.published_pages()
        assert page["kind"] == "events"
        assert page["stale"] is False


def _brief_v2(
    path: Path, *, nodes: list[tuple[str, str]], slug: str, total: int, h: str
) -> None:
    """A brief/2 file: `page.nodes` is a LIST, because one page can cover several
    subjects - which is how UAP and UFO share a page without the two nodes being
    merged into one."""
    path.parent.mkdir(parents=True, exist_ok=True)
    members = "".join(
        f"  - node_id: {nid}\n    name: {name}\n    node_type: topic\n"
        for nid, name in nodes
    )
    path.write_text(
        "schema: anomalica/brief/2\n"
        f"brief_hash: {h}\n"
        "page:\n"
        "  kind: entity\n"
        "  nodes:\n"
        f"{members}"
        "  node_type: topic\n"
        f"  title: {slug}\n"
        f"  slug: {slug}\n"
        "  claim_count: 3\n"
        f"  claim_count_total: {total}\n"
        "claims: []\n"
    )


class TestABriefCanCoverSeveralNodes:
    """The silent failure this guards: reading only the old singular
    `page.node_id` against brief/2 files skips EVERY brief and returns an empty
    index, with no error anywhere - every page then reads as having no brief."""

    def test_every_member_resolves_to_the_page_covering_it(self, briefs):
        _brief_v2(
            briefs / "topics" / "unidentified-anomalous-phenomena-uap.yaml",
            nodes=[
                ("uap-node", "Unidentified Anomalous Phenomena (UAP)"),
                ("ufo-node", "Unidentified Flying Object (UFO)"),
            ],
            slug="unidentified-anomalous-phenomena-uap",
            total=2068,
            h="c" * 16,
        )
        index = pages.brief_index()
        assert index["uap-node"]["slug"] == "unidentified-anomalous-phenomena-uap"
        # The covered member resolves to the page covering it - otherwise it
        # reads as a subject nobody has written about.
        assert index["ufo-node"]["slug"] == "unidentified-anomalous-phenomena-uap"
        assert index["ufo-node"]["primary_node_id"] == "uap-node"

    def test_the_old_singular_field_still_works(self, briefs):
        _brief(
            briefs / "events" / "apollo-14.yaml",
            node_id="ev",
            node_type="event",
            slug="apollo-14",
            total=10,
            h="a" * 16,
        )
        assert pages.brief_index()["ev"]["slug"] == "apollo-14"

    def test_a_brief_naming_no_node_is_skipped_not_crashed(self, briefs):
        path = briefs / "topics" / "broken.yaml"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            "schema: anomalica/brief/2\nbrief_hash: " + "d" * 16 + "\n"
            "page:\n  kind: entity\n  nodes: []\n  slug: broken\n  claim_count_total: 0\nclaims: []\n"
        )
        assert pages.brief_index() == {}
