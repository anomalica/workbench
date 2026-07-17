#!/usr/bin/env python3
"""The comparable/Digests list offers only records in the ACTIVE corpus.

The bug this pins: Mark archived pantex (ingests d4cd610 - the record moves to
store/v1/ and its records/ symlink is deleted) while its variant digests stayed
on disk. The list walks the variants directory, so it kept advertising the
record; opening it then 404'd, because the audit resolves a record by NAME
through records/ - and the symlink is precisely what archiving removes.

So the rule is: resolve by CONTENT HASH against store/, never by directory name.
A variants directory is named for a record and keeps that name after the record
is archived out from under it.
"""


import pytest

from backend import models


@pytest.fixture
def corpus(tmp_path, monkeypatch):
    store = tmp_path / "ingests" / "store"
    (store / "v1").mkdir(parents=True)
    monkeypatch.setenv("INGESTS_PATH", str(tmp_path / "ingests"))
    return store


def test_active_record_is_offered(corpus):
    (corpus / "aaa.md").write_text("x")
    assert models._is_active("aaa") is True


def test_archived_record_is_not_offered(corpus):
    # The live shape: present ONLY under store/v1/.
    (corpus / "v1" / "bbb.md").write_text("x")
    assert models._is_active("bbb") is False


def test_a_v2_record_is_still_active(corpus):
    # Records land as {hash}.v2.md too - the version suffix is not an archive.
    (corpus / "ccc.v2.md").write_text("x")
    assert models._is_active("ccc") is True


def test_unknown_hash_is_not_active(corpus):
    assert models._is_active("nope") is False


def test_empty_hash_is_not_active(corpus):
    # A variant with no resolvable content_hash must not be offered: it cannot be
    # opened, so listing it can only waste a click.
    assert models._is_active("") is False
