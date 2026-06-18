#!/usr/bin/env python3
"""_hash_to_digest_path resolves v2 records to their (unsuffixed) digest YAML.

The ingester's records/ symlinks carry a version suffix for v2+ records
(``<name>.v2.md``) but the digester writes ``<name>.yaml`` with no suffix.
Before the fix the resolver derived ``<name>.v2.yaml`` and 404'd for every v2
audio/video record, which broke claim deep-links into the video review path.
"""

import backend.server as server

HASH_V2 = "1" * 64
HASH_WEB = "2" * 64
HASH_NODIGEST = "3" * 64


def _record(content_hash: str) -> str:
    return f"---\nschema: anomalica/record/1\ncontent_hash: {content_hash}\ntitle: T\n---\nBody.\n"


def _setup(tmp_path, monkeypatch):
    records = tmp_path / "ingests" / "records"
    digests = tmp_path / "digests" / "records"
    records.mkdir(parents=True)
    digests.mkdir(parents=True)

    # A v2 video record: symlink stem is "<name>.v2", digest is "<name>.yaml".
    (records / "2026-05-08-video-bob.v2.md").write_text(_record(HASH_V2))
    (digests / "2026-05-08-video-bob.yaml").write_text("schema: anomalica/digest/1\n")

    # An unversioned web record: stem == digest stem, must still resolve.
    (records / "2020-01-01-web-thing.md").write_text(_record(HASH_WEB))
    (digests / "2020-01-01-web-thing.yaml").write_text("schema: anomalica/digest/1\n")

    # A v2 record whose digest hasn't been built yet -> None, not a wrong path.
    (records / "2026-06-01-video-nodigest.v2.md").write_text(_record(HASH_NODIGEST))

    monkeypatch.setattr(server, "ingests_path", tmp_path / "ingests")
    monkeypatch.setattr(server, "digests_path", tmp_path / "digests")
    return digests


def test_v2_record_resolves_to_unsuffixed_digest(tmp_path, monkeypatch):
    digests = _setup(tmp_path, monkeypatch)
    assert server._hash_to_digest_path(HASH_V2) == digests / "2026-05-08-video-bob.yaml"


def test_unversioned_record_still_resolves(tmp_path, monkeypatch):
    digests = _setup(tmp_path, monkeypatch)
    assert (
        server._hash_to_digest_path(HASH_WEB) == digests / "2020-01-01-web-thing.yaml"
    )


def test_missing_digest_returns_none(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    assert server._hash_to_digest_path(HASH_NODIGEST) is None
