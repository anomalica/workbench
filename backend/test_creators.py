#!/usr/bin/env python3
"""The API exposes the spec field `creators`, falling back to legacy `authors`."""

import subprocess

import pytest

from backend.server import LocalIngestSource

CREATORS_HASH = "c" * 64
AUTHORS_HASH = "a" * 64
PROVENANCE_HASH = "d" * 64
POSTED_HASH = "9" * 64
STALE_HASH = "8" * 64

CREATORS_RECORD = f"""---
schema: anomalica/record/1
content_hash: {CREATORS_HASH}
title: Has Creators
publisher: The Debrief
creators:
  - "Ramsey, Chris"
  - "Doe, Jane"
---
Body.
"""

# A record that predates the rename still carries `authors:`.
AUTHORS_RECORD = f"""---
schema: anomalica/record/1
content_hash: {AUTHORS_HASH}
title: Has Legacy Authors
authors:
  - "Old, Author"
---
Body.
"""

# record/3 keeps work origin in the provenance block (0043), not flat fields.
PROVENANCE_RECORD = f"""---
schema: anomalica/record/3
content_hash: {PROVENANCE_HASH}
title: Has Provenance Block
assets:
  - asset_hash: sha256:{"b" * 64}
    file_format: html
    acquisition:
      acquired_at: '2026-09-23T21:50:37Z'
      fetched_url: https://web.archive.org/web/20260812id_/https://example.com/a
provenance:
  publisher: Daily Mail
  creators:
    - Josh Boswell
  published_date: '2023-12-11'
  source_url: https://example.com/a
---
Body.
"""

# record/3 with no work locators but a recoverable copy origin: the asset's
# fetched_url (often a Wayback wrapper).
NO_ORIGIN_RECORD = f"""---
schema: anomalica/record/3
content_hash: {"e" * 64}
title: No Origin
assets:
  - asset_hash: sha256:{"f" * 64}
    file_format: pdf
    acquisition:
      acquired_at: '2026-09-23T21:50:37Z'
      fetched_url: https://web.archive.org/web/20260812id_/https://example.com/a
---
Body.
"""

# The copy axis: the channel this copy came from and when it posted it. Distinct
# from publisher and date - an archival re-upload has both.
POSTED_RECORD = f"""---
schema: anomalica/record/2
content_hash: {POSTED_HASH}
title: Posted By Only
posted_by: Eyes On Cinema
posted_date: '2026-06-24T08:45:30+00:00'
source_url: https://www.youtube.com/watch?v=ylgNYkrj55o
---
Body.
"""

# A record/3 carrying both spellings: the flat one is a stale duplicate, and
# the canonical provenance home must win.
STALE_RECORD = f"""---
schema: anomalica/record/3
content_hash: {STALE_HASH}
title: Stale Duplicate
assets:
  - asset_hash: sha256:{"7" * 64}
    file_format: opus
    acquisition:
      acquired_at: '2026-09-23T21:50:37Z'
provenance:
  publisher: Canonical Publisher
  posted_by: A Channel
  posted_date: '2026-06-04'
publisher: Stale Flat Publisher
---
Body.
"""


@pytest.fixture
def ingests_repo(tmp_path):
    repo = tmp_path / "ingests"
    store = repo / "store"
    store.mkdir(parents=True)
    (store / "creators.md").write_text(CREATORS_RECORD)
    (store / "authors.md").write_text(AUTHORS_RECORD)
    (store / "provenance.md").write_text(PROVENANCE_RECORD)
    (store / "no_origin.md").write_text(NO_ORIGIN_RECORD)
    (store / "posted.md").write_text(POSTED_RECORD)
    (store / "stale.md").write_text(STALE_RECORD)
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.invalid"], cwd=repo, check=True
    )
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "initial"], cwd=repo, check=True)
    return repo


def test_list_ingests_exposes_creators(ingests_repo):
    by_hash = {
        i["content_hash"]: i for i in LocalIngestSource(ingests_repo).list_ingests()
    }
    assert by_hash[CREATORS_HASH]["creators"] == ["Ramsey, Chris", "Doe, Jane"]
    assert "authors" not in by_hash[CREATORS_HASH]


def test_list_ingests_falls_back_to_authors(ingests_repo):
    by_hash = {
        i["content_hash"]: i for i in LocalIngestSource(ingests_repo).list_ingests()
    }
    assert by_hash[AUTHORS_HASH]["creators"] == ["Old, Author"]


def test_list_ingests_reads_the_record_3_provenance_block(ingests_repo):
    # The yellow-triangle bug: the origin lives at provenance.source_url, so a
    # flat-field read left every record/3 "untraceable: no recoverable source".
    by_hash = {
        i["content_hash"]: i for i in LocalIngestSource(ingests_repo).list_ingests()
    }
    row = by_hash[PROVENANCE_HASH]
    assert row["source_url"] == "https://example.com/a"
    assert row["publisher"] == "Daily Mail"
    assert row["creators"] == ["Josh Boswell"]
    assert row["date"] == "2023-12-11"


def test_list_ingests_falls_back_to_the_asset_fetched_url(ingests_repo):
    # A record with no work URL still has a recoverable copy origin.
    by_hash = {
        i["content_hash"]: i for i in LocalIngestSource(ingests_repo).list_ingests()
    }
    row = by_hash["e" * 64]
    assert row["source_url"].startswith("https://web.archive.org/")
    assert row["publisher"] == ""
    assert row["creators"] == []


def test_list_ingests_carries_the_copy_axis(ingests_repo):
    # The channel and the post date of THIS COPY travel with the row, so a
    # record whose work metadata is not evidenced still reads as what it is
    # rather than as blank.
    by_hash = {
        i["content_hash"]: i for i in LocalIngestSource(ingests_repo).list_ingests()
    }
    row = by_hash[POSTED_HASH]
    assert row["posted_by"] == "Eyes On Cinema"
    assert row["posted_date"] == "2026-06-24T08:45:30+00:00"
    # Not folded into the work axis: the publisher and date stay empty.
    assert row["publisher"] == ""
    assert row["date"] == ""


def test_list_ingests_reads_the_copy_axis_from_provenance(ingests_repo):
    by_hash = {
        i["content_hash"]: i for i in LocalIngestSource(ingests_repo).list_ingests()
    }
    row = by_hash[STALE_HASH]
    assert row["posted_by"] == "A Channel"
    assert row["posted_date"] == "2026-06-04"


def test_list_ingests_prefers_the_canonical_home_over_a_stale_flat_duplicate(
    ingests_repo,
):
    # record/3 keeps these in `provenance`; a flat spelling beside it is stale
    # migration input and must not win.
    by_hash = {
        i["content_hash"]: i for i in LocalIngestSource(ingests_repo).list_ingests()
    }
    assert by_hash[STALE_HASH]["publisher"] == "Canonical Publisher"


def test_get_ingest_exposes_creators_and_strips_keys(ingests_repo):
    detail = LocalIngestSource(ingests_repo).get_ingest(CREATORS_HASH)
    assert detail["creators"] == ["Ramsey, Chris", "Doe, Jane"]
    # Neither key should remain in the generic frontmatter panel.
    assert "creators" not in detail["frontmatter"]
    assert "authors" not in detail["frontmatter"]


def test_get_ingest_falls_back_to_authors(ingests_repo):
    detail = LocalIngestSource(ingests_repo).get_ingest(AUTHORS_HASH)
    assert detail["creators"] == ["Old, Author"]
    assert "authors" not in detail["frontmatter"]
