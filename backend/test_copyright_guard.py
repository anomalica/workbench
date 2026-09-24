"""Who may change who can see a record."""

import pytest
from fastapi import HTTPException

import server


class _Source:
    def __init__(self, status):
        self.status = status

    def get_ingest(self, _hash):
        return {"frontmatter": {"copyright.status": self.status}}


RECORD = "---\ntitle: A Record\ncopyright:\n  status: {status}\n---\nbody\n"


@pytest.fixture
def as_source(monkeypatch):
    def use(status):
        monkeypatch.setattr(server, "source", _Source(status))

    return use


@pytest.fixture
def as_role(monkeypatch):
    def use(role):
        monkeypatch.setattr(server, "_role_of_user", lambda _u: role)

    return use


def test_a_reviewer_may_not_publish_a_restricted_record(as_source, as_role):
    # The workbench only offers the control to admins, but a record is
    # submitted as whole markdown - so a reviewer could edit the frontmatter by
    # hand and post it. This is where that is actually refused.
    as_source("restricted")
    as_role("reviewer")
    with pytest.raises(HTTPException) as raised:
        server._guard_copyright_change(
            "a" * 64, RECORD.format(status="public_domain"), {"email": "r@x"}
        )
    assert raised.value.status_code == 403


def test_a_reviewer_may_not_restrict_a_public_one_either(as_source, as_role):
    # Narrowing is safe for copyright and unsafe for the corpus: a record
    # quietly pulled from public view is a record nobody can find.
    as_source("public_domain")
    as_role("editor")
    with pytest.raises(HTTPException):
        server._guard_copyright_change(
            "a" * 64, RECORD.format(status="restricted"), {"email": "e@x"}
        )


def test_an_admin_may(as_source, as_role):
    as_source("restricted")
    as_role("admin")
    server._guard_copyright_change(
        "a" * 64, RECORD.format(status="public_domain"), {"email": "a@x"}
    )


def test_an_ordinary_edit_is_not_a_copyright_change(as_source, as_role):
    # Every review submit goes through this. A reviewer editing the body of a
    # restricted record must not be told they are trying to publish it.
    as_source("restricted")
    as_role("reviewer")
    server._guard_copyright_change(
        "a" * 64, RECORD.format(status="restricted"), {"email": "r@x"}
    )


def test_a_record_that_is_not_there_is_not_a_change(as_source, as_role, monkeypatch):
    as_role("reviewer")
    monkeypatch.setattr(
        server, "source", type("S", (), {"get_ingest": lambda *_: None})()
    )
    server._guard_copyright_change(
        "a" * 64, RECORD.format(status="public_domain"), {"email": "r@x"}
    )


def test_content_without_a_stated_status_is_not_a_change(as_source, as_role):
    # A body-only submission does not state a copyright block. Reading that as
    # "the status was cleared" would refuse every ordinary edit; and everywhere
    # that serves a record treats an absent status as restricted, so the
    # omission fails closed rather than opening the gate.
    as_source("restricted")
    as_role("reviewer")
    server._guard_copyright_change("a" * 64, "just an edited body", {"email": "r@x"})


RECORD3 = """---
schema: anomalica/record/3
title: A Video
source_type: video
assets:
- asset_hash: sha256:aaaa
  file_format: opus
  source_type: video
  copyright:
    status: {status}
selection:
- asset_hash: sha256:aaaa
  selector:
    type: whole
---

body
"""


class _Source3:
    def __init__(self, status):
        self.status = status

    def get_ingest(self, _hash):
        raw = RECORD3.format(status=self.status)
        frontmatter, _body, raw_block = server.parse_frontmatter(raw)
        return {
            "frontmatter": frontmatter,
            "raw_frontmatter": raw_block,
            "copyright_status": server.record_copyright_status(frontmatter, raw_block),
        }


@pytest.fixture
def as_source3(monkeypatch):
    def use(status):
        monkeypatch.setattr(server, "source", _Source3(status))

    return use


def test_record_3_asset_rights_are_the_gate(as_source3, as_role):
    # record/3 states its gate on the Asset blocks (decision 0051). A reviewer
    # who edits `assets[].copyright.status` is changing who may see the record
    # and must meet the same bar as a legacy field edit - this is where that is
    # refused, since no top-level `copyright.status` exists to catch it.
    as_source3("restricted")
    as_role("reviewer")
    with pytest.raises(HTTPException) as raised:
        server._guard_copyright_change(
            "a" * 64, RECORD3.format(status="publicly_accessible"), {"email": "r@x"}
        )
    assert raised.value.status_code == 403


def test_a_record_3_body_edit_is_not_a_copyright_change(as_source3, as_role):
    as_source3("publicly_accessible")
    as_role("reviewer")
    server._guard_copyright_change(
        "a" * 64, RECORD3.format(status="publicly_accessible"), {"email": "r@x"}
    )
