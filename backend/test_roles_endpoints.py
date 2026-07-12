#!/usr/bin/env python3
"""Role-management endpoints (roles phase 3): admin-only CRUD over roles.yaml
with a last-admin lockout guard. A fake source captures the write instead of
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
    # boss is an admin (manages roles); rev is a reviewer.
    (ingests / "roles.yaml").write_text("boss: admin\nrev: reviewer\n")
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


def test_list_requires_admin(client):
    client.login("rev")  # reviewer, not admin
    assert client.get("/api/roles").status_code == 403


def test_editor_cannot_manage_roles(client):
    # An editor is the top CONTENT role but not admin - role management is admin-only.
    (client.ingests / "roles.yaml").write_text("boss: admin\ned: editor\n")
    client.login("ed")
    assert client.get("/api/roles").status_code == 403
    assert client.put("/api/roles/x", json={"role": "reviewer"}).status_code == 403


def test_list_returns_map_options_and_self(client):
    res = client.get("/api/roles")
    assert res.status_code == 200
    body = res.json()
    assert body["roles"] == {"boss": "admin", "rev": "reviewer"}
    assert body["options"] == ["contributor", "reviewer", "editor", "admin"]
    assert body["self"] == "boss"


def test_set_role_adds_and_persists(client):
    res = client.put("/api/roles/newperson", json={"role": "editor"})
    assert res.status_code == 200
    assert res.json()["roles"]["newperson"] == "editor"
    assert roles.load_roles(client.ingests)["newperson"] == "editor"


def test_set_role_rejects_unknown_role(client):
    assert client.put("/api/roles/x", json={"role": "superuser"}).status_code == 400


def test_set_role_requires_admin(client):
    client.login("rev")
    assert client.put("/api/roles/x", json={"role": "reviewer"}).status_code == 403


def test_cannot_demote_the_last_admin(client):
    # boss is the only admin; demoting to editor would leave zero admins.
    res = client.put("/api/roles/boss", json={"role": "editor"})
    assert res.status_code == 400
    assert roles.load_roles(client.ingests)["boss"] == "admin"  # unchanged


def test_cannot_remove_the_last_admin(client):
    res = client.delete("/api/roles/boss")
    assert res.status_code == 400
    assert "boss" in roles.load_roles(client.ingests)


def test_can_demote_an_admin_when_another_remains(client):
    client.put("/api/roles/second", json={"role": "admin"})  # now two admins
    res = client.put("/api/roles/boss", json={"role": "editor"})
    assert res.status_code == 200
    assert roles.load_roles(client.ingests)["boss"] == "editor"


def test_remove_role_reverts_to_default(client):
    res = client.delete("/api/roles/rev")
    assert res.status_code == 200
    assert "rev" not in roles.load_roles(client.ingests)


def test_remove_unlisted_login_404(client):
    assert client.delete("/api/roles/ghost").status_code == 404
