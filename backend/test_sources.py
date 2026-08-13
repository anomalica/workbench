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
