#!/usr/bin/env python3
"""The proposal review queue endpoints (roles phase 2): list / get / approve /
reject. A contributor's submit is queued (see submit_review); a reviewer lists,
diffs, and approves (commit as the contributor) or rejects (drop). Paths point at
tmp fixtures and source is a fake, so nothing touches the real repos or git."""

import pytest
from fastapi.testclient import TestClient

import backend.server as server
from backend import proposals

HASH = "a" * 64


class FakeSource:
    """Records the calls approve makes instead of touching git/disk."""

    def __init__(self):
        self.saved = []
        self.commits = []
        self.coverage = []
        self.record_exists = True

    def save_ingest(self, full_hash, content):
        self.saved.append((full_hash, content))
        return self.record_exists

    def get_ingest(self, full_hash):
        if not self.record_exists:
            return None
        return {
            "raw_frontmatter": "---\ntitle: T\n---\n",
            "body": "current body\n",
            "frontmatter": {"title": "T"},
        }

    def append_coverage(self, **kwargs):
        self.coverage.append(kwargs)
        return True

    def commit_review(self, **kwargs):
        self.commits.append(kwargs)


@pytest.fixture
def client(tmp_path, monkeypatch):
    ingests = tmp_path / "ingests"
    ingests.mkdir()
    # revuser is a reviewer; anyone else (contrib) is an unlisted contributor.
    (ingests / "roles.yaml").write_text("revuser: reviewer\n")
    monkeypatch.setattr(server, "ingests_path", ingests)

    fake = FakeSource()
    monkeypatch.setattr(server, "source", fake)

    # The acting user is settable per test via client.login(...).
    state = {"user": {"login": "revuser", "name": "Rev", "email": "rev@x.invalid"}}
    monkeypatch.setattr(server, "_require_user", lambda request: state["user"])

    tc = TestClient(server.app)
    tc.fake = fake
    tc.ingests = ingests
    tc.login = lambda login, **kw: state.update(
        user={
            "login": login,
            "name": kw.get("name", login),
            "email": kw.get("email", f"{login}@x.invalid"),
        }
    )
    return tc


def _enqueue(ingests, login="contrib", content=None, **kw):
    return proposals.enqueue(
        ingests,
        record_hash=kw.get("record_hash", HASH),
        content=content
        if content is not None
        else "---\ntitle: T\n---\nproposed body\n",
        author={"login": login, "name": login.title(), "email": f"{login}@x.invalid"},
        notes=kw.get("notes", ""),
        spans=kw.get("spans"),
        verdict=kw.get("verdict"),
    )


def test_list_requires_reviewer(client):
    client.login("contrib")
    assert client.get("/api/proposals").status_code == 403


def test_list_returns_pending_without_content(client):
    _enqueue(client.ingests, "contrib")
    client.login("revuser")
    res = client.get("/api/proposals")
    assert res.status_code == 200
    rows = res.json()["proposals"]
    assert len(rows) == 1
    assert rows[0]["author_login"] == "contrib"
    assert "content" not in rows[0]  # metadata only


def test_mine_returns_only_own_pending(client):
    _enqueue(client.ingests, "alice")
    _enqueue(client.ingests, "bob")
    client.login("alice")
    rows = client.get("/api/proposals/mine").json()["proposals"]
    assert [r["author_login"] for r in rows] == ["alice"]


def test_get_returns_proposed_and_current(client):
    entry = _enqueue(
        client.ingests, "contrib", content="---\ntitle: T\n---\nNEW body\n"
    )
    client.login("revuser")
    res = client.get(f"/api/proposals/{entry['id']}")
    assert res.status_code == 200
    body = res.json()
    assert body["proposal"]["content"] == "---\ntitle: T\n---\nNEW body\n"
    assert body["current_content"] == "---\ntitle: T\n---\ncurrent body\n"
    assert body["record_exists"] is True


def test_get_requires_reviewer(client):
    entry = _enqueue(client.ingests, "contrib")
    client.login("contrib")
    assert client.get(f"/api/proposals/{entry['id']}").status_code == 403


def test_approve_commits_as_contributor_and_removes(client):
    entry = _enqueue(
        client.ingests,
        "contrib",
        content="---\ntitle: T\n---\nPROPOSED\n",
        notes="fixed a typo",
    )
    client.login("revuser", name="Rev")
    res = client.post(f"/api/proposals/{entry['id']}/approve")
    assert res.status_code == 200
    # Saved the proposed content, committed as the contributor, approver noted.
    assert client.fake.saved == [(HASH, "---\ntitle: T\n---\nPROPOSED\n")]
    assert len(client.fake.commits) == 1
    commit = client.fake.commits[0]
    assert commit["author_email"] == "contrib@x.invalid"
    assert "fixed a typo" in commit["notes"]
    assert "Approved by Rev" in commit["notes"]
    # Queue entry removed.
    assert proposals.get(client.ingests, entry["id"]) is None


def test_approve_requires_reviewer(client):
    entry = _enqueue(client.ingests, "contrib")
    client.login("contrib")
    assert client.post(f"/api/proposals/{entry['id']}/approve").status_code == 403
    assert proposals.get(client.ingests, entry["id"]) is not None  # not removed


def test_reject_removes_without_committing(client):
    entry = _enqueue(client.ingests, "contrib")
    client.login("revuser")
    res = client.post(f"/api/proposals/{entry['id']}/reject")
    assert res.status_code == 200
    assert proposals.get(client.ingests, entry["id"]) is None
    assert client.fake.commits == []  # nothing committed


def test_approve_missing_proposal_404(client):
    client.login("revuser")
    assert client.post(f"/api/proposals/{'0' * 32}/approve").status_code == 404
