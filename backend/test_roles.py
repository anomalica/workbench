#!/usr/bin/env python3
"""Roles: the login -> role map, default contributor, and the hierarchy."""

from backend.roles import load_roles, role_of, at_least, DEFAULT_ROLE


def test_default_contributor_when_no_file(tmp_path):
    assert role_of("anyone", tmp_path) == "contributor"
    assert role_of(None, tmp_path) == "contributor"


def test_reads_roles_yaml(tmp_path):
    (tmp_path / "roles.yaml").write_text("markhedleyjones: editor\nrev: reviewer\n")
    assert role_of("markhedleyjones", tmp_path) == "editor"
    assert role_of("rev", tmp_path) == "reviewer"
    assert role_of("stranger", tmp_path) == "contributor"


def test_login_is_case_insensitive(tmp_path):
    (tmp_path / "roles.yaml").write_text("MarkHedleyJones: editor\n")
    assert role_of("markhedleyjones", tmp_path) == "editor"


def test_unknown_role_value_dropped(tmp_path):
    (tmp_path / "roles.yaml").write_text("someone: superadmin\n")
    assert load_roles(tmp_path) == {}
    assert role_of("someone", tmp_path) == DEFAULT_ROLE


def test_malformed_file_is_all_contributor(tmp_path):
    (tmp_path / "roles.yaml").write_text(": : not yaml : :\n[")
    assert role_of("markhedleyjones", tmp_path) == "contributor"


def test_hierarchy(tmp_path):
    assert at_least("editor", "reviewer") is True
    assert at_least("reviewer", "reviewer") is True
    assert at_least("contributor", "reviewer") is False
    assert at_least("reviewer", "editor") is False
    assert at_least("editor", "contributor") is True
