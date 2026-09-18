#!/usr/bin/env python3
"""Human-gold unit parsing, batching, persistence and API tests."""

import json
import subprocess

import pytest
from fastapi.testclient import TestClient

import backend.server as server
from backend.server import LocalIngestSource
from backend.tuning import (
    GOLD_SCHEMA,
    body_sha256,
    parse_units,
    proposals_for_units,
    units_in_range,
)

CONTENT_HASH = "b" * 64
BODY = """
{{highlight-start: h1}}The object{{highlight-end: h1}} was
{{highlight-start: h1}}intact{{highlight-end: h1}}.

{{highlight-start: h2}}It moved north{{highlight-end: h2}}.
{{highlight-start: h3}}A sensor detected it{{highlight-end: h3}}.
{{highlight-start: h4}}The weather was clear{{highlight-end: h4}}.
{{highlight-start: h5}}The operator took notes{{highlight-end: h5}}.
{{highlight-start: h6}}The event ended{{highlight-end: h6}}.
{{highlight-context: [h2, h1]}}
"""
RECORD = f"""---
schema: anomalica/record/1
content_hash: {CONTENT_HASH}
title: Gold Record
---
{BODY}"""


def digest_claim(text: str, quote: str) -> dict:
    return {"id": text, "type": "observation", "text": text, "quote": quote}


DIGESTS = [
    {
        "domain_claims": [
            digest_claim("The object was intact.", "The object was intact"),
            digest_claim("The object was intact.", "intact"),
            digest_claim("It moved north.", "It moved north"),
            digest_claim("A hidden whole-record claim.", "The event ended"),
        ]
    }
]


@pytest.fixture
def ingests_repo(tmp_path):
    repo = tmp_path / "ingests"
    store = repo / "store"
    store.mkdir(parents=True)
    (store / f"{CONTENT_HASH}.md").write_text(RECORD)
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.invalid"], cwd=repo, check=True
    )
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "initial"], cwd=repo, check=True)
    return repo


@pytest.fixture
def client(ingests_repo, monkeypatch):
    monkeypatch.setattr(server, "source", LocalIngestSource(ingests_repo))
    monkeypatch.setattr(server, "ingests_path", ingests_repo)
    monkeypatch.setattr(server, "_gold_digest_documents", lambda _hash: DIGESTS)
    (ingests_repo / "roles.yaml").write_text("rev: reviewer\n")
    monkeypatch.setattr(
        server,
        "_require_user",
        lambda request: {
            "id": "1234567",
            "login": "rev",
            "email": "reviewer@example.invalid",
            "name": "Reviewer",
        },
    )
    return TestClient(server.app)


def decisions_for(batch: list[dict], *, deferred: str | None = None) -> list[dict]:
    return [
        {
            "highlight_id": unit["highlight_id"],
            "decision": "defer" if unit["highlight_id"] == deferred else "reject",
        }
        for unit in batch
    ]


def save(client: TestClient, view: dict, decisions: list[dict], complete=False):
    return client.post(
        f"/api/ingests/{CONTENT_HASH}/gold/batches",
        json={
            "body_sha256": view["body_sha256"],
            "range": {
                "id": view["range"]["id"],
                "start": view["range"]["start"],
                "end": view["range"]["end"],
            },
            "decisions": decisions,
            "complete": complete,
        },
    )


def test_parser_keeps_multipart_parts_and_transitive_ancestor_context():
    body = (
        "{{highlight-start: a}}one{{highlight-end: a}} "
        "{{highlight-start: a}}two{{highlight-end: a}} "
        "{{highlight-start: b}}it{{highlight-end: b}} "
        "{{highlight-start: c}}then{{highlight-end: c}}\n"
        "{{highlight-context: [b, a]}}\n{{highlight-context: [c, b]}}\n"
    )
    units = parse_units(body)
    assert [part["text"] for part in units[0]["parts"]] == ["one", "two"]
    assert [item["highlight_id"] for item in units[2]["context"]] == ["a", "b"]


def test_parser_applies_canonical_orphan_semantics():
    units = parse_units("before {{highlight-start: open}}to the end")
    assert units[0]["parts"][0]["text"] == "to the end"
    assert parse_units("before {{highlight-end: orphan}}after") == []


@pytest.mark.parametrize(
    ("edge", "message"),
    [("[a, missing]", "dangling"), ("[a, b]", "forward")],
)
def test_parser_reports_context_that_must_be_deferred(edge, message):
    body = (
        "{{highlight-start: a}}one{{highlight-end: a}} "
        "{{highlight-start: b}}two{{highlight-end: b}}\n"
        f"{{{{highlight-context: {edge}}}}}\n"
    )
    assert message in parse_units(body)[0]["context_issue"]


def test_bounded_range_excludes_a_multipart_boundary_case():
    units = parse_units(BODY)
    h1 = units[0]
    contained, boundary = units_in_range(
        units, h1["parts"][0]["start"], h1["parts"][0]["end"]
    )
    assert contained == []
    assert [unit["highlight_id"] for unit in boundary] == ["h1"]


def test_proposals_are_overlap_filtered_and_deduplicated():
    proposals = proposals_for_units(BODY, parse_units(BODY)[:2], DIGESTS)
    assert [item["text"] for item in proposals["h1"]] == ["The object was intact."]
    assert [item["text"] for item in proposals["h2"]] == ["It moved north."]
    assert "A hidden whole-record claim." not in json.dumps(proposals)


def test_view_returns_five_existing_units_with_parts_context_and_only_their_proposals(
    client,
):
    response = client.get(f"/api/ingests/{CONTENT_HASH}/gold")
    assert response.status_code == 200
    view = response.json()
    assert len(view["batch"]) == 5
    assert [part["text"] for part in view["batch"][0]["parts"]] == [
        "The object",
        "intact",
    ]
    assert view["batch"][1]["context"][0]["highlight_id"] == "h1"
    assert view["batch"][0]["proposals"] == [
        {"text": "The object was intact.", "quote": "The object was intact"}
    ]
    assert "A hidden whole-record claim." not in response.text


def test_batch_save_is_authenticated_atomic_and_resumes_never_reviewed_before_deferred(
    client, ingests_repo
):
    view = client.get(f"/api/ingests/{CONTENT_HASH}/gold").json()
    response = save(client, view, decisions_for(view["batch"], deferred="h2"))
    assert response.status_code == 200
    resumed = response.json()
    assert [unit["highlight_id"] for unit in resumed["batch"]] == ["h6", "h2"]

    sidecar = json.loads(
        (ingests_repo / "store" / f"{CONTENT_HASH}.gold.json").read_text()
    )
    assert sidecar["schema"] == GOLD_SCHEMA
    assert sidecar["record_hash"] == f"sha256:{CONTENT_HASH}"
    assert sidecar["body_sha256"] == f"sha256:{body_sha256(BODY)}"
    assert sidecar["ranges"][0]["reviewer"] == {
        "issuer": "github",
        "subject": "1234567",
        "name": "Reviewer",
    }
    assert "parts" not in json.dumps(sidecar)
    assert "proposals" not in json.dumps(sidecar)

    log = subprocess.run(
        ["git", "log", "-1", "--format=%s|%an"],
        cwd=ingests_repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert log == "gold review: Gold Record|Reviewer"


def test_accept_must_be_one_displayed_proposal_and_invalid_batch_writes_nothing(
    client, ingests_repo
):
    view = client.get(f"/api/ingests/{CONTENT_HASH}/gold").json()
    decisions = decisions_for(view["batch"])
    decisions[0] = {
        "highlight_id": "h1",
        "decision": "accept",
        "facts": ["Invented fact"],
    }
    response = save(client, view, decisions)
    assert response.status_code == 400
    assert "unchanged proposed fact" in response.json()["detail"]
    assert not (ingests_repo / "store" / f"{CONTENT_HASH}.gold.json").exists()


def test_adjust_split_reject_and_complete_attestation(client, ingests_repo):
    view = client.get(f"/api/ingests/{CONTENT_HASH}/gold").json()
    decisions = decisions_for(view["batch"])
    decisions[0] = {
        "highlight_id": "h1",
        "decision": "adjust",
        "facts": ["The object was reported intact."],
    }
    decisions[1] = {
        "highlight_id": "h2",
        "decision": "split",
        "facts": ["The object moved.", "The movement was north."],
    }
    second = save(client, view, decisions).json()
    third = save(client, second, decisions_for(second["batch"])).json()
    assert third["batch"] == []

    attested = save(client, third, [], complete=True)
    assert attested.status_code == 200
    assert attested.json()["range"]["complete"] is True
    sidecar = json.loads(
        (ingests_repo / "store" / f"{CONTENT_HASH}.gold.json").read_text()
    )
    assert sidecar["ranges"][0]["attested_at"].endswith("Z")


def test_deferred_unit_prevents_completeness(client):
    view = client.get(f"/api/ingests/{CONTENT_HASH}/gold").json()
    current = save(client, view, decisions_for(view["batch"], deferred="h2")).json()
    current = save(
        client, current, decisions_for(current["batch"], deferred="h2")
    ).json()
    response = save(
        client, current, decisions_for(current["batch"], deferred="h2"), complete=True
    )
    assert response.status_code == 400
    assert "cannot be completed" in response.json()["detail"]


def test_get_resumes_latest_incomplete_range(client):
    first = client.get(f"/api/ingests/{CONTENT_HASH}/gold?start=0&end=100").json()
    save(client, first, decisions_for(first["batch"]))
    resumed = client.get(f"/api/ingests/{CONTENT_HASH}/gold").json()
    assert resumed["range"]["id"] == first["range"]["id"]


def test_stale_body_binding_is_reported_not_reanchored(client, ingests_repo):
    view = client.get(f"/api/ingests/{CONTENT_HASH}/gold").json()
    assert save(client, view, decisions_for(view["batch"])).status_code == 200
    path = ingests_repo / "store" / f"{CONTENT_HASH}.md"
    path.write_text(RECORD + "changed\n")
    stale = client.get(f"/api/ingests/{CONTENT_HASH}/gold").json()
    assert stale["stale"] is True
    assert stale["batch"] == []


def test_missing_durable_github_subject_is_refused(client, monkeypatch):
    monkeypatch.setattr(
        server,
        "_require_user",
        lambda request: {"login": "rev", "email": "x@example.invalid", "name": "R"},
    )
    response = client.get(f"/api/ingests/{CONTENT_HASH}/gold")
    assert response.status_code == 400
    assert "log out and log in again" in response.json()["detail"]


def test_invalid_range_is_refused(client):
    response = client.get(f"/api/ingests/{CONTENT_HASH}/gold?start=20&end=10")
    assert response.status_code == 400


def test_malformed_hash_is_not_found(client):
    assert client.get("/api/ingests/nothex/gold").status_code == 404
