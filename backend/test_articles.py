#!/usr/bin/env python3
"""list_articles(): walk the assembled content repo for the Articles tab.
Entity articles link to the public site; records carry a deep-linkable
record_hash; the hand-authored static sections are excluded."""

import pytest

from backend import server

REC_HASH = "a" * 56


@pytest.fixture
def content_repo(tmp_path, monkeypatch):
    pages = tmp_path / "content" / "pages"

    def write(section, slug, frontmatter):
        d = pages / section
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{slug}.en.md").write_text(f"---\n{frontmatter}---\n\nBody.\n")

    # Entity articles (indexed, no record_hash).
    write(
        "people",
        "luis-elizondo",
        "title: Luis Elizondo\ndescription: A former intelligence officer.\n"
        "tags: [official, intelligence]\n",
    )
    write(
        "organisations", "aatip", "title: AATIP\ndescription: A Pentagon programme.\n"
    )
    # A record-class page: top-level record_hash + noindex.
    write(
        "records",
        "2020-01-01-video-some-episode",
        f"title: Some Episode\ndescription: An episode.\nnoindex: true\n"
        f"record_hash: {REC_HASH}\n",
    )
    # Static/explainer sections must be skipped.
    write("about", "index", "title: About\n")
    write("decisions", "0001", "title: A decision\n")

    monkeypatch.setattr(server, "content_path", tmp_path / "content")
    monkeypatch.setattr(server, "site_base_url", "https://anomalica.is")
    return tmp_path


def test_lists_entity_and_record_articles_excluding_static(content_repo):
    arts = server.list_articles()
    by_section = {a["section"] for a in arts}
    assert by_section == {"people", "organisations", "records"}  # no about/decisions
    assert len(arts) == 3


def test_entity_article_shape(content_repo):
    art = next(a for a in server.list_articles() if a["slug"] == "luis-elizondo")
    assert art == {
        "section": "people",
        "slug": "luis-elizondo",
        "title": "Luis Elizondo",
        "description": "A former intelligence officer.",
        "tags": ["official", "intelligence"],
        "url": "https://anomalica.is/people/luis-elizondo/",
        "record_hash": None,  # entities never carry one
    }


def test_record_article_keeps_record_hash_for_deeplink(content_repo):
    art = next(a for a in server.list_articles() if a["section"] == "records")
    assert art["record_hash"] == REC_HASH
    assert art["url"] == "https://anomalica.is/records/2020-01-01-video-some-episode/"


def test_site_base_url_is_honoured(content_repo, monkeypatch):
    monkeypatch.setattr(server, "site_base_url", "https://staging.example")
    art = next(a for a in server.list_articles() if a["slug"] == "aatip")
    assert art["url"] == "https://staging.example/organisations/aatip/"


def test_missing_content_dir_returns_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "content_path", tmp_path / "nope")
    assert server.list_articles() == []


def test_malformed_or_frontmatterless_file_falls_back_to_slug(tmp_path, monkeypatch):
    pages = tmp_path / "content" / "pages" / "concepts"
    pages.mkdir(parents=True)
    (pages / "no-frontmatter.en.md").write_text("Just a body, no frontmatter.\n")
    (pages / "broken.en.md").write_text("---\ntitle: [unterminated\n---\nx\n")
    monkeypatch.setattr(server, "content_path", tmp_path / "content")
    monkeypatch.setattr(server, "site_base_url", "https://anomalica.is")
    arts = {a["slug"]: a for a in server.list_articles()}
    assert arts["no-frontmatter"]["title"] == "no-frontmatter"  # slug fallback
    assert arts["no-frontmatter"]["record_hash"] is None
    assert "broken" in arts  # malformed YAML doesn't crash the walk
