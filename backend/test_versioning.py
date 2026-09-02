#!/usr/bin/env python3
"""list_ingests applies pipeline versioning + supersession (decision 0040).

Covers the workbench integration: hiding superseded records, the source_url
newest-wins dedup safety net, exposing processing.pipeline_version against the
store/_pipeline_versions.yaml manifest, and the absent-is-not-stale rule.
"""

import pytest

from backend.server import LocalIngestSource

A = "a" * 64
B = "b" * 64
C = "c" * 64
D = "d" * 64
E = "e" * 64
F = "0" * 64
SUPERSEDER = "f" * 64


def _rec(
    content_hash: str,
    *,
    source_url: str = "",
    date_extracted: str = "",
    source_type: str = "video",
    pipeline_version: int | None = None,
    superseded_by: str = "",
    refresh_refused: str = "",
) -> str:
    lines = [
        "---",
        "schema: anomalica/record/1",
        f"content_hash: {content_hash}",
        "title: T",
        f"source_type: {source_type}",
    ]
    if source_url:
        lines.append(f"source_url: {source_url}")
    if date_extracted:
        lines.append(f"date_extracted: {date_extracted}")
    if superseded_by:
        lines.append(f"superseded_by: {superseded_by}")
    if pipeline_version is not None:
        lines.append("processing:")
        lines.append(f"  pipeline_version: {pipeline_version}")
    if refresh_refused:
        # The ingester's own shape: a quoted reason carrying a colon and
        # brackets, written for a person.
        lines.append("refresh_refused:")
        lines.append("  at: 2026-09-02T04:56:15Z")
        lines.append(f'  reason: "{refresh_refused}"')
    lines.append("---")
    lines.append("Body.\n")
    return "\n".join(lines)


@pytest.fixture
def repo(tmp_path):
    store = tmp_path / "ingests" / "store"
    store.mkdir(parents=True)
    # A and B share a source_url (two downloads of one video); A is newer. Note
    # the mixed ISO forms - A uses +00:00, B uses Z - the dedup must compare them
    # as instants, not strings.
    (store / "a.md").write_text(
        _rec(
            A,
            source_url="u://1",
            date_extracted="2026-06-26T16:34:35.904120+00:00",
            pipeline_version=1,
        )
    )
    (store / "b.md").write_text(
        _rec(B, source_url="u://1", date_extracted="2026-06-05T22:30:02.226460Z")
    )
    # C is superseded - hidden regardless of its source_url being unique.
    (store / "c.md").write_text(
        _rec(
            C,
            source_url="u://2",
            date_extracted="2026-06-20T00:00:00Z",
            superseded_by=SUPERSEDER,
        )
    )
    # D: a media type absent from the manifest -> pipeline_current is None.
    (store / "d.md").write_text(
        _rec(D, source_url="u://3", source_type="pdf", pipeline_version=1)
    )
    # E: no source_url (passthrough), no pipeline_version (not stale).
    (store / "e.md").write_text(_rec(E, source_type="web"))
    # F: stale, and the pipeline tried to refresh it and would not.
    (store / "f.md").write_text(
        _rec(
            F,
            source_url="u://4",
            source_type="web",
            pipeline_version=0,
            refresh_refused=(
                "refused: 2 word(s) of the stored body are absent from the fresh "
                "extraction (a reviewed record keeps every word): june 5"
            ),
        )
    )

    (store / "_pipeline_versions.yaml").write_text(
        "# current generation per media type\nvideo: 2\naudio: 1\nweb: 1\n"
    )
    return tmp_path / "ingests"


def test_superseded_records_are_hidden(repo):
    hashes = {i["content_hash"] for i in LocalIngestSource(repo).list_ingests()}
    assert C not in hashes


def test_source_url_dedup_keeps_newest_extraction(repo):
    hashes = {i["content_hash"] for i in LocalIngestSource(repo).list_ingests()}
    # A (26 Jun) and B (5 Jun) share a source_url; only the newer A survives,
    # proving the +00:00 vs Z forms compared as instants not strings.
    assert A in hashes
    assert B not in hashes


def test_pipeline_version_and_current_exposed(repo):
    by_hash = {i["content_hash"]: i for i in LocalIngestSource(repo).list_ingests()}
    # A: video pipeline_version 1, manifest video=2 -> stale (frontend badges).
    assert by_hash[A]["pipeline_version"] == 1
    assert by_hash[A]["pipeline_current"] == 2
    # D: pdf not in the manifest -> current is None (no badge possible).
    assert by_hash[D]["pipeline_version"] == 1
    assert by_hash[D]["pipeline_current"] is None
    # E: no pipeline_version declared -> None, never badged ("not stale").
    assert by_hash[E]["pipeline_version"] is None


def test_records_without_source_url_pass_through(repo):
    hashes = {i["content_hash"] for i in LocalIngestSource(repo).list_ingests()}
    assert E in hashes


def test_a_refused_refresh_is_told_apart_from_one_never_tried(repo):
    """Both are stale. Without the stamp the list shows them identically, and
    the refused one waits forever for a refresh that already declined."""
    by_hash = {i["content_hash"]: i for i in LocalIngestSource(repo).list_ingests()}
    refused = by_hash[F]["refresh_refused"]
    assert refused["at"] == "2026-09-02T04:56:15Z"
    assert refused["reason"].endswith("june 5")
    assert "absent from the fresh extraction" in refused["reason"]
    # A is stale too, and simply has not been tried.
    assert by_hash[A]["refresh_refused"] is None
