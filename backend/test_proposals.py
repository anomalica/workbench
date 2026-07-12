#!/usr/bin/env python3
"""Proposal store: enqueue a contributor's edit, list/get/remove, id safety."""

from backend import proposals

AUTHOR = {"login": "newbie", "name": "New Bie", "email": "new@example.invalid"}


def test_enqueue_stores_a_pending_snapshot(tmp_path):
    entry = proposals.enqueue(
        tmp_path, "a" * 64, "the edited body", AUTHOR, notes="fixed a typo"
    )
    assert entry["status"] == "pending"
    assert entry["record_hash"] == "a" * 64
    assert entry["content"] == "the edited body"
    assert entry["author_login"] == "newbie"
    assert entry["notes"] == "fixed a typo"
    assert (tmp_path / "proposals" / f"{entry['id']}.json").is_file()


def test_list_pending_omits_content(tmp_path):
    proposals.enqueue(tmp_path, "a" * 64, "body one", AUTHOR)
    proposals.enqueue(tmp_path, "b" * 64, "body two", AUTHOR)
    listed = proposals.list_pending(tmp_path)
    assert len(listed) == 2
    assert all("content" not in e for e in listed)
    assert {e["record_hash"] for e in listed} == {"a" * 64, "b" * 64}


def test_get_returns_full_content(tmp_path):
    pid = proposals.enqueue(tmp_path, "a" * 64, "full body", AUTHOR)["id"]
    got = proposals.get(tmp_path, pid)
    assert got["content"] == "full body"


def test_remove(tmp_path):
    pid = proposals.enqueue(tmp_path, "a" * 64, "x", AUTHOR)["id"]
    assert proposals.remove(tmp_path, pid) is True
    assert proposals.get(tmp_path, pid) is None
    assert proposals.remove(tmp_path, pid) is False


def test_list_empty_when_no_dir(tmp_path):
    assert proposals.list_pending(tmp_path) == []
    assert proposals.count_pending(tmp_path) == 0


def test_invalid_id_rejected_no_traversal(tmp_path):
    # An id must be uuid4 hex; a path-y id never reads outside the store.
    assert proposals.get(tmp_path, "../../etc/passwd") is None
    assert proposals.get(tmp_path, "not-a-uuid") is None
    assert proposals.remove(tmp_path, "../x") is False
