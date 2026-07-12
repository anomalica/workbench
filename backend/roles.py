"""Contribution roles: who may write to live data.

A `roles.yaml` at the ingests root maps a GitHub login to a role. Anyone
authenticated but unlisted is a `contributor` - the safe default - so a new
login can propose edits but never commit to main. The file is editor-edited
(a UI comes later); absent or malformed, everyone is a contributor.

    # ingests/roles.yaml
    markhedleyjones: editor
    somereviewer: reviewer

Roles are ordered contributor < reviewer < editor:
- contributor: propose edits (queued, never committed directly).
- reviewer: + approve/reject proposals; own edits commit directly.
- editor: + manage roles.
"""

from __future__ import annotations

from pathlib import Path

import yaml

ROLES = ("contributor", "reviewer", "editor")
DEFAULT_ROLE = "contributor"


def load_roles(ingests_path: Path) -> dict[str, str]:
    """The login -> role map from `ingests/roles.yaml`. Logins are lowercased;
    entries with an unknown role are dropped. Empty on any read/parse error."""
    path = ingests_path / "roles.yaml"
    if not path.exists():
        return {}
    try:
        data = yaml.safe_load(path.read_text())
    except (OSError, yaml.YAMLError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {
        login.lower(): role
        for login, role in data.items()
        if isinstance(login, str) and role in ROLES
    }


def role_of(login: str | None, ingests_path: Path) -> str:
    """A login's role, defaulting to contributor when unlisted or absent."""
    if not login:
        return DEFAULT_ROLE
    return load_roles(ingests_path).get(login.lower(), DEFAULT_ROLE)


def at_least(role: str, minimum: str) -> bool:
    """True when `role` ranks at or above `minimum` in the hierarchy."""
    rank = ROLES.index(role) if role in ROLES else 0
    floor = ROLES.index(minimum) if minimum in ROLES else 0
    return rank >= floor
