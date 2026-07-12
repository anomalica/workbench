#!/usr/bin/env python3
"""Write endpoints are role-gated. The security fix: a contributor (the default
for any authenticated-but-unlisted login) cannot commit to live data - their
submit is queued as a proposal, and the other write endpoints 403."""

import pytest
from fastapi.testclient import TestClient

import backend.server as server
from backend import proposals

HASH = "a" * 64


class StubSource:
    """Records whether the committing write path was reached."""

    def __init__(self):
        self.saved = False
        self.committed = False
        self.archived = False

    def save_ingest(self, full_hash, content):
        self.saved = True
        return True

    def append_coverage(self, **kw):
        return True

    def commit_review(self, **kw):
        self.committed = True

    def archive_ingest(self, full_hash, user):
        self.archived = True
        return True


@pytest.fixture
def env(tmp_path, monkeypatch):
    (tmp_path / "roles.yaml").write_text("boss: editor\nrev: reviewer\n")
    monkeypatch.setattr(server, "ingests_path", tmp_path)
    stub = StubSource()
    monkeypatch.setattr(server, "source", stub)

    def client_as(login):
        monkeypatch.setattr(
            server,
            "_require_user",
            lambda request, _l=login: {
                "login": _l,
                "name": _l,
                "email": f"{_l}@x.invalid",
            },
        )
        return TestClient(server.app)

    return client_as, stub, tmp_path


def test_contributor_submit_is_queued_not_committed(env):
    client_as, stub, ingests = env
    client = client_as("newbie")  # unlisted -> contributor
    res = client.put(
        f"/api/ingests/{HASH}", json={"content": "edited body", "notes": "typo"}
    )
    assert res.status_code == 202
    assert res.json()["status"] == "pending"
    assert stub.saved is False and stub.committed is False  # never touched live data
    pending = proposals.list_pending(ingests)
    assert len(pending) == 1 and pending[0]["author_login"] == "newbie"


def test_reviewer_submit_commits_directly(env):
    client_as, stub, ingests = env
    client = client_as("rev")
    res = client.put(
        f"/api/ingests/{HASH}", json={"content": "edited body", "notes": ""}
    )
    assert res.status_code == 200
    assert stub.saved is True and stub.committed is True
    assert proposals.list_pending(ingests) == []  # not queued


def test_editor_submit_commits_directly(env):
    client_as, stub, _ = env
    res = client_as("boss").put(
        f"/api/ingests/{HASH}", json={"content": "b", "notes": ""}
    )
    assert res.status_code == 200
    assert stub.committed is True


def test_contributor_cannot_archive(env):
    client_as, stub, _ = env
    res = client_as("newbie").post(f"/api/ingests/{HASH}/archive")
    assert res.status_code == 403
    assert stub.archived is False


def test_reviewer_can_archive(env):
    client_as, stub, _ = env
    res = client_as("rev").post(f"/api/ingests/{HASH}/archive")
    assert res.status_code == 200
    assert stub.archived is True


def test_contributor_cannot_write_highlights(env):
    client_as, _, _ = env
    res = client_as("newbie").put(
        f"/api/ingests/{HASH}/highlights",
        json={"complete": True, "spans": [], "rejected": []},
    )
    assert res.status_code == 403


def test_my_role_anonymous_defaults_contributor(env):
    # /api/me/role reads the session; with none set it returns the safe default.
    client_as, _, _ = env
    assert client_as("x").get("/api/me/role").json()["role"] == "contributor"
