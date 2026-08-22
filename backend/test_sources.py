#!/usr/bin/env python3
"""The /api/sources/{hash} endpoint serves the source media file, not a sidecar
sitting beside it. Regression: a `{hash}.transcript.json` companion also matches
`{hash}.*`, and glob order is arbitrary, so the endpoint served the transcript
JSON (unplayable) for every source that had one - the NASA .ogg records."""

import pytest
from fastapi.testclient import TestClient

import backend.server as server

HASH = "5" * 64


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "records_path", tmp_path)
    return TestClient(server.app)


def test_serves_the_media_not_the_transcript_sidecar(client, tmp_path):
    # Both files share the hash; the transcript sorts before the .ogg by name.
    (tmp_path / f"{HASH}.transcript.json").write_text('{"segments": []}')
    (tmp_path / f"{HASH}.ogg").write_bytes(b"OggS-fake-audio-bytes")
    res = client.get(f"/api/sources/{HASH}")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("audio/ogg")
    assert res.content == b"OggS-fake-audio-bytes"


def test_serves_a_lone_source_file(client, tmp_path):
    (tmp_path / f"{HASH}.opus").write_bytes(b"opus-bytes")
    res = client.get(f"/api/sources/{HASH}")
    assert res.status_code == 200
    assert res.content == b"opus-bytes"


def test_404_when_only_a_sidecar_exists(client, tmp_path):
    # A transcript with no media is not a servable source.
    (tmp_path / f"{HASH}.transcript.json").write_text("{}")
    assert client.get(f"/api/sources/{HASH}").status_code == 404


def test_404_for_missing_and_malformed_hash(client):
    assert client.get(f"/api/sources/{'a' * 64}").status_code == 404
    assert client.get("/api/sources/not-a-hash").status_code == 404


# An ebook or web record does NOT hash its own source file: those types hash the
# EXTRACTED BODY, so the record's content hash and its file's hash differ and the
# file is archived under `source_hash`. Asking for a book by its content hash
# found nothing, and the reviewer was told the original was unavailable while it
# sat on disk - the one thing they need to check an extraction against.

BODY_HASH = "b" * 64
FILE_HASH = "f" * 64


@pytest.fixture
def store(monkeypatch):
    """A stand-in ingest source, so nothing reads or writes the real corpus."""
    records: dict[str, dict] = {}

    class FakeSource:
        def get_ingest(self, full_hash):
            return records.get(full_hash)

    monkeypatch.setattr(server, "source", FakeSource())
    return records


def test_finds_an_ebook_archived_under_its_source_hash(client, tmp_path, store):
    store[BODY_HASH] = {"frontmatter": {"source_hash": f"sha256:{FILE_HASH}"}}
    (tmp_path / f"{FILE_HASH}.epub").write_bytes(b"PK-fake-epub")
    res = client.get(f"/api/sources/{BODY_HASH}")
    assert res.status_code == 200
    assert res.content == b"PK-fake-epub"


def test_prefers_the_file_under_the_asked_hash(client, tmp_path, store):
    # Audio, video and PDF are archived under the content hash itself. The
    # fallback must never shadow that, or a record whose source_hash is stale
    # serves the wrong file.
    store[HASH] = {"frontmatter": {"source_hash": f"sha256:{FILE_HASH}"}}
    (tmp_path / f"{HASH}.opus").write_bytes(b"the-right-one")
    (tmp_path / f"{FILE_HASH}.epub").write_bytes(b"the-wrong-one")
    assert client.get(f"/api/sources/{HASH}").content == b"the-right-one"


def test_404_when_the_source_hash_names_nothing(client, store):
    store[BODY_HASH] = {"frontmatter": {"source_hash": f"sha256:{FILE_HASH}"}}
    assert client.get(f"/api/sources/{BODY_HASH}").status_code == 404


def test_404_when_the_record_has_no_source_hash(client, store):
    store[BODY_HASH] = {"frontmatter": {}}
    assert client.get(f"/api/sources/{BODY_HASH}").status_code == 404


def test_404_when_there_is_no_record_at_all(client, store):
    assert client.get(f"/api/sources/{BODY_HASH}").status_code == 404
