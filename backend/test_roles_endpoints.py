#!/usr/bin/env python3
"""Role-management endpoints (roles phase 3): editor-only CRUD over roles.yaml
with a last-editor lockout guard. A fake source captures the write instead of
committing to git."""

import pytest
from fastapi.testclient import TestClient

import backend.server as server
from backend import roles


class FakeSource:
    def __init__(self, ingests):
        self.ingests = ingests
        self.writes = []

    def save_roles(self, roles_map, author_name, author_email):
        # Mirror the real behaviour: persist to roles.yaml so a follow-up read
        # reflects the change, and record the call.
        roles.save_roles(self.ingests, roles_map)
        self.writes.append((dict(roles_map), author_name, author_email))
        return True


@pytest.fixture
def client(tmp_path, monkeypatch):
    ingests = tmp_path / "ingests"
    ingests.mkdir()
    # Start with one editor and one reviewer.
    (ingests / "roles.yaml").write_text("boss: editor\nrev: reviewer\n")
    monkeypatch.setattr(server, "ingests_path", ingests)
    monkeypatch.setattr(server, "source", FakeSource(ingests))

    state = {"user": {"login": "boss", "name": "Boss", "email": "boss@x.invalid"}}
    monkeypatch.setattr(server, "_require_user", lambda request: state["user"])

    tc = TestClient(server.app)
    tc.ingests = ingests
    tc.login = lambda login: state.update(
        user={"login": login, "name": login.title(), "email": f"{login}@x.invalid"}
    )
    return tc


def test_list_requires_editor(client):
    client.login("rev")  # reviewer, not editor
    assert client.get("/api/roles").status_code == 403


def test_list_returns_map_options_and_self(client):
    res = client.get("/api/roles")
    assert res.status_code == 200
    body = res.json()
    assert body["roles"] == {"boss": "editor", "rev": "reviewer"}
    assert body["options"] == ["contributor", "reviewer", "editor"]
    assert body["self"] == "boss"


def test_set_role_adds_and_persists(client):
    res = client.put("/api/roles/newperson", json={"role": "reviewer"})
    assert res.status_code == 200
    assert res.json()["roles"]["newperson"] == "reviewer"
    # Persisted so a re-read reflects it.
    assert roles.load_roles(client.ingests)["newperson"] == "reviewer"


def test_set_role_rejects_unknown_role(client):
    assert client.put("/api/roles/x", json={"role": "admin"}).status_code == 400


def test_set_role_requires_editor(client):
    client.login("rev")
    assert client.put("/api/roles/x", json={"role": "reviewer"}).status_code == 403


def test_cannot_demote_the_last_editor(client):
    # boss is the only editor; demoting to reviewer would leave zero editors.
    res = client.put("/api/roles/boss", json={"role": "reviewer"})
    assert res.status_code == 400
    assert roles.load_roles(client.ingests)["boss"] == "editor"  # unchanged


def test_cannot_remove_the_last_editor(client):
    res = client.delete("/api/roles/boss")
    assert res.status_code == 400
    assert "boss" in roles.load_roles(client.ingests)


def test_can_demote_an_editor_when_another_remains(client):
    client.put("/api/roles/second", json={"role": "editor"})  # now two editors
    res = client.put("/api/roles/boss", json={"role": "reviewer"})
    assert res.status_code == 200
    assert roles.load_roles(client.ingests)["boss"] == "reviewer"


def test_remove_role_reverts_to_default(client):
    res = client.delete("/api/roles/rev")
    assert res.status_code == 200
    assert "rev" not in roles.load_roles(client.ingests)


def test_remove_unlisted_login_404(client):
    assert client.delete("/api/roles/ghost").status_code == 404
