#!/usr/bin/env python3
"""The /api/ingests/{hash}/audit endpoint: resolves a record's friendly name,
loads its variants, and returns the passage/cluster payload. Paths point at tmp
fixtures so nothing touches the real ingests/digests repos."""

import yaml
import pytest
from fastapi.testclient import TestClient

import backend.server as server

HASH = "a" * 64
NAME = "2026-01-02-video-example-record"


def _digest(model, claims):
    return {
        "schema": "anomalica/digest/1",
        "model": model,
        "ai_usage": [
            {
                "stage": "digest",
                "model": "claude-opus-4-8",
                "tokens": {"input": 200_000, "output": 10_000},
            }
        ],
        "prompts": [{"pass": "claims", "id": "claims", "version": "v3"}],
        "domain_claims": claims,
        "infrastructure_claims": [],
    }


@pytest.fixture
def audit_client(tmp_path, monkeypatch):
    ingests = tmp_path / "ingests"
    (ingests / "records").mkdir(parents=True)
    # A record file the friendly-name resolver reads (a plain file resolves to
    # itself; the v-suffix strip still applies to the stem).
    (ingests / "records" / f"{NAME}.v2.md").write_text(
        f"---\nschema: anomalica/record/1\ncontent_hash: {HASH}\ntitle: T\n---\nBody.\n"
    )
    digests = tmp_path / "digests"
    vdir = digests / "variants" / NAME
    vdir.mkdir(parents=True)
    (vdir / "opus.yaml").write_text(
        yaml.safe_dump(
            _digest(
                "opus",
                [
                    {
                        "id": "o1",
                        "location": "00:00:00-00:00:30",
                        "quote": "Q",
                        "text": "Jon ran for governor",
                    },
                    {
                        "id": "o2",
                        "location": "00:00:00-00:00:30",
                        "quote": "Q",
                        "text": "Only opus saw this",
                    },
                ],
            )
        )
    )
    (vdir / "haiku.yaml").write_text(
        yaml.safe_dump(
            _digest(
                "haiku",
                [
                    {
                        "id": "h1",
                        "location": "00:00:00-00:00:30",
                        "quote": "Q",
                        "text": "Jon ran for governor",
                    },
                ],
            )
        )
    )
    monkeypatch.setattr(server, "ingests_path", ingests)
    monkeypatch.setattr(server, "digests_path", digests)
    # Hermetic clustering: point the embedding endpoint at a dead port so the
    # suite never depends on whether the assimilator's service happens to be
    # running on the developer's machine (connection-refused is immediate, so
    # this costs nothing). The embedding path is exercised explicitly below with
    # a stub. Also clear the process-wide payload cache so one test's build can
    # never be served to another.
    monkeypatch.setenv("ANOMALICA_EMBED_ENDPOINT", "http://127.0.0.1:1")
    server._AUDIT_PAYLOAD_CACHE.clear()
    # The audit view is reviewer-gated; grant the test user that role.
    (ingests / "roles.yaml").write_text("rev: reviewer\n")
    monkeypatch.setattr(
        server,
        "_require_user",
        lambda request: {"login": "rev", "name": "Rev", "email": "rev@x.invalid"},
    )
    return TestClient(server.app)


def test_returns_variants_with_cost(audit_client):
    res = audit_client.get(f"/api/ingests/{HASH}/audit")
    assert res.status_code == 200
    body = res.json()
    assert body["record"]["friendly_name"] == NAME
    models = {v["model"]: v for v in body["variants"]}
    assert set(models) == {"opus", "haiku"}
    assert models["opus"]["cost_usd"] == 1.25  # (200k x $5 + 10k x $25) / 1M
    assert models["opus"]["claim_count"] == 2


def test_clusters_shared_and_singleton_claims(audit_client):
    body = audit_client.get(f"/api/ingests/{HASH}/audit").json()
    assert len(body["passages"]) == 1
    clusters = body["passages"][0]["clusters"]
    shared = [c for c in clusters if not c["singleton"]]
    singles = [c for c in clusters if c["singleton"]]
    assert len(shared) == 1
    assert set(shared[0]["variants"]) == {"opus", "haiku"}
    assert {m["model"] for m in shared[0]["members"]} == {"opus", "haiku"}
    assert len(singles) == 1
    assert singles[0]["members"][0]["text"] == "Only opus saw this"


def test_members_carry_source_text_and_location(audit_client):
    body = audit_client.get(f"/api/ingests/{HASH}/audit").json()
    member = body["passages"][0]["clusters"][0]["members"][0]
    assert member["location"] == "00:00:00-00:00:30"
    assert "quote" in member and "text" in member


def test_unknown_hash_404(audit_client):
    assert audit_client.get(f"/api/ingests/{'b' * 64}/audit").status_code == 404


def test_malformed_hash_404(audit_client):
    assert audit_client.get("/api/ingests/not-a-hash/audit").status_code == 404


def test_record_without_variants_404(audit_client, tmp_path, monkeypatch):
    # A record that resolves but has no digest/variants at all.
    other = "c" * 64
    (tmp_path / "ingests" / "records" / "2026-01-02-video-empty.v2.md").write_text(
        f"---\nschema: anomalica/record/1\ncontent_hash: {other}\ntitle: T\n---\nB\n"
    )
    assert audit_client.get(f"/api/ingests/{other}/audit").status_code == 404


def test_put_claim_verdict_writes_v2_gold(audit_client, tmp_path, monkeypatch):
    # The chips' save path end to end: validate, stamp reviewer + models set,
    # compute the fingerprint from the raw digest-shaped claim, upsert, save.
    # save_audit is faked - the REAL one commits to the ingests repo.
    store = tmp_path / "store"
    store.mkdir()
    written = {}
    monkeypatch.setattr(server.source, "audit_store_dir", lambda h: store)
    monkeypatch.setattr(
        server.source,
        "save_audit",
        lambda h, gold, name, email: written.update(gold=gold) or True,
    )
    entry = {
        "variant": "haiku.d161b1ed",
        "model": "haiku",
        "prompt_sha": "d161b1ed",
        "claim_id": "h1",
        "location": "00:00:00-00:00:30",
        "text": "Jon ran for governor",
        "quote": "Q",
        "claim_type": "domain",
        "quality": "good",
        "claim": {
            "text": "Jon ran for governor",
            "type": "domain",
            "quote": "Q",
            "location": "00:00:00-00:00:30",
        },
    }
    res = audit_client.put(f"/api/ingests/{HASH}/audit/claim", json=entry)
    assert res.status_code == 200, res.text
    gold = written["gold"]
    assert gold["schema"] == "anomalica/audit/2"
    [claim] = gold["claims"]
    assert claim["quality"] == "good"
    assert claim["reviewed_by"] == "rev@x.invalid"
    assert claim["gold_id"]
    # The raw claim is hashed then POPPED - never stored (anchors carry the text).
    assert "claim" not in claim
    assert len(claim.get("claim_fingerprint", "")) == 64
    # Spec-required models set, stamped from the variants on disk.
    assert {m["variant"] for m in gold["models"]} == {"opus", "haiku"}

    # Re-judging the same claim updates ONE entry (the press-3-then-2 path).
    entry["quality"] = "okay"
    res = audit_client.put(f"/api/ingests/{HASH}/audit/claim", json=entry)
    assert res.status_code == 200
    [claim] = written["gold"]["claims"]
    assert claim["quality"] == "okay"


def test_put_claim_rejects_bad_quality(audit_client, tmp_path, monkeypatch):
    monkeypatch.setattr(server.source, "audit_store_dir", lambda h: tmp_path)
    res = audit_client.put(
        f"/api/ingests/{HASH}/audit/claim",
        json={
            "variant": "v",
            "model": "m",
            "prompt_sha": "s",
            "claim_id": "c",
            "text": "t",
            "quality": "great",
        },
    )
    assert res.status_code == 400


def test_nodes_compared_across_models(audit_client, tmp_path):
    # Pass A's entities are the other half of the two-pass output; comparing
    # WHICH entities each model found was invisible until they were surfaced.
    vdir = tmp_path / "digests" / "variants" / NAME
    opus = yaml.safe_load((vdir / "opus.yaml").read_text())
    opus["nodes"] = [
        {"id": "n1", "type": "person", "name": "Jon Stewart"},
        {"id": "n2", "type": "organisation", "name": "NASA"},
    ]
    (vdir / "opus.yaml").write_text(yaml.safe_dump(opus))
    haiku = yaml.safe_load((vdir / "haiku.yaml").read_text())
    haiku["nodes"] = [{"id": "h1", "type": "person", "name": "jon stewart"}]
    (vdir / "haiku.yaml").write_text(yaml.safe_dump(haiku))

    body = audit_client.get(f"/api/ingests/{HASH}/audit").json()
    by_name = {n["name"].casefold(): n for n in body["nodes"]}
    # Case differs between the models; the entity is still one row.
    assert sorted(by_name["jon stewart"]["found_by"]) == ["haiku", "opus"]
    assert by_name["jon stewart"]["singleton"] is False
    # An entity only one model extracted stays visible as a singleton.
    assert by_name["nasa"]["found_by"] == ["opus"]
    assert by_name["nasa"]["singleton"] is True
    counts = {v["model"]: v["node_count"] for v in body["variants"]}
    assert counts == {"opus": 2, "haiku": 1}


def test_reports_lexical_fallback_when_endpoint_is_down(audit_client):
    # The endpoint is unreachable in tests, so the build degrades - and SAYS so.
    # A reviewer must never be shown approximate clustering as if it were the
    # embedding space's verdict.
    body = audit_client.get(f"/api/ingests/{HASH}/audit").json()
    assert body["similarity"]["method"] == "lexical"
    assert body["similarity"]["degraded"] is True
    assert body["similarity"]["model_id"] is None
    # The threshold is reported even when it did not run, so the payload always
    # says what "same fact" would have meant.
    assert body["similarity"]["threshold"] > 0


def test_uses_embeddings_and_stamps_the_space(audit_client, monkeypatch):
    # With the endpoint reachable, clustering runs in the assimilator's vector
    # space and the payload records WHICH space and WHICH cut produced it - a
    # human verdict is not reproducible without both.
    class StubCache:
        model_id = "stub-embedder:v1"

        def __init__(self, *a, **kw):
            pass

        def warm(self, texts):
            list(texts)

    monkeypatch.setattr("anomalica_common.embedding_client.EmbeddingCache", StubCache)
    monkeypatch.setattr(
        "anomalica_common.embedding_client.embedding_similar",
        lambda threshold=None, cache=None: (
            lambda a, b: a.text.strip().lower() == b.text.strip().lower()
        ),
    )
    body = audit_client.get(f"/api/ingests/{HASH}/audit").json()
    assert body["similarity"] == {
        "method": "embedding",
        "model_id": "stub-embedder:v1",
        "threshold": 0.83,
        "degraded": False,
    }
    # And it still clusters: the shared fact collapsed across both models.
    shared = [c for c in body["passages"][0]["clusters"] if not c["singleton"]]
    assert len(shared) == 1


def test_repeat_open_is_served_from_cache(audit_client, monkeypatch):
    # "Slow to load" was a full re-parse + re-cluster on every open. An unchanged
    # record must not rebuild.
    first = audit_client.get(f"/api/ingests/{HASH}/audit")
    assert first.status_code == 200
    calls = []
    import backend.audit_load as audit_load

    original = audit_load.load_record_variants
    monkeypatch.setattr(
        audit_load,
        "load_record_variants",
        lambda *a, **kw: calls.append(1) or original(*a, **kw),
    )
    second = audit_client.get(f"/api/ingests/{HASH}/audit")
    assert second.status_code == 200
    assert calls == []  # never re-read the variant files
    assert second.json()["passages"] == first.json()["passages"]


def test_cache_rebuilds_when_a_variant_changes(audit_client, tmp_path):
    before = audit_client.get(f"/api/ingests/{HASH}/audit").json()
    assert len(before["passages"][0]["clusters"]) == 2

    vdir = tmp_path / "digests" / "variants" / NAME
    doc = yaml.safe_load((vdir / "haiku.yaml").read_text())
    doc["domain_claims"].append(
        {
            "id": "h2",
            "location": "00:00:00-00:00:30",
            "quote": "Q",
            "text": "A brand new haiku claim",
        }
    )
    (vdir / "haiku.yaml").write_text(yaml.safe_dump(doc))

    after = audit_client.get(f"/api/ingests/{HASH}/audit").json()
    assert len(after["passages"][0]["clusters"]) == 3


def test_gold_is_attached_fresh_not_cached(audit_client, tmp_path, monkeypatch):
    # The clustered payload caches; the reviewer's gold must NOT, or a verdict
    # written between two opens would not show until the record changed.
    store = tmp_path / "store"
    store.mkdir()
    monkeypatch.setattr(server.source, "audit_store_dir", lambda h: store)
    assert audit_client.get(f"/api/ingests/{HASH}/audit").json()["gold"]["claims"] == []

    # The real save_audit commits to the ingests repo; this one only persists to
    # the tmp store, so the read-back path is exercised for real.
    monkeypatch.setattr(
        server.source,
        "save_audit",
        lambda h, gold, name, email: bool(server.audit_gold.write(store, h, gold)),
    )
    audit_client.put(
        f"/api/ingests/{HASH}/audit/claim",
        json={
            "variant": "haiku",
            "model": "haiku",
            "prompt_sha": "s",
            "claim_id": "h1",
            "location": "00:00:00-00:00:30",
            "text": "Jon ran for governor",
            "quality": "good",
        },
    )
    served = audit_client.get(f"/api/ingests/{HASH}/audit").json()
    assert [c["claim_id"] for c in served["gold"]["claims"]] == ["h1"]


def test_batch_verdicts_write_once(audit_client, tmp_path, monkeypatch):
    # Grading happens in bursts, so the natural unit is the burst. A request and
    # a commit per keystroke made the git log a keystroke log and put a round
    # trip between the reviewer and their next decision.
    store = tmp_path / "store"
    store.mkdir()
    saves = []
    monkeypatch.setattr(server.source, "audit_store_dir", lambda h: store)
    monkeypatch.setattr(
        server.source,
        "save_audit",
        lambda h, gold, name, email: saves.append(gold) is None or True,
    )

    def entry(claim_id, quality):
        return {
            "variant": "haiku",
            "model": "haiku",
            "prompt_sha": "s",
            "claim_id": claim_id,
            "text": f"claim {claim_id}",
            "quality": quality,
        }

    res = audit_client.put(
        f"/api/ingests/{HASH}/audit/claims",
        json={"claims": [entry("a", "bad"), entry("b", "good"), entry("c", "okay")]},
    )
    assert res.status_code == 200, res.text
    assert res.json()["saved"] == 3
    assert len(saves) == 1  # ONE write for the batch
    assert {c["claim_id"] for c in saves[0]["claims"]} == {"a", "b", "c"}
    assert {c["quality"] for c in saves[0]["claims"]} == {"bad", "good", "okay"}


def test_a_bad_entry_rejects_the_whole_batch(audit_client, tmp_path, monkeypatch):
    # Half-writing a burst would leave the reviewer unable to tell which of
    # their verdicts survived.
    store = tmp_path / "store"
    store.mkdir()
    saves = []
    monkeypatch.setattr(server.source, "audit_store_dir", lambda h: store)
    monkeypatch.setattr(
        server.source, "save_audit", lambda h, g, n, e: saves.append(g) is None or True
    )
    res = audit_client.put(
        f"/api/ingests/{HASH}/audit/claims",
        json={
            "claims": [
                {
                    "variant": "h",
                    "model": "h",
                    "prompt_sha": "s",
                    "claim_id": "a",
                    "text": "t",
                    "quality": "good",
                },
                {
                    "variant": "h",
                    "model": "h",
                    "prompt_sha": "s",
                    "claim_id": "b",
                    "text": "t",
                    "quality": "splendid",
                },
            ]
        },
    )
    assert res.status_code == 400
    assert saves == []


def test_faithfulness_and_value_are_independent(audit_client, tmp_path, monkeypatch):
    # The point of splitting them: a claim can be faultlessly extracted and
    # still worthless, so both answers must be recordable on one claim.
    store = tmp_path / "store"
    store.mkdir()
    written = {}
    monkeypatch.setattr(server.source, "audit_store_dir", lambda h: store)
    monkeypatch.setattr(
        server.source, "save_audit", lambda h, g, n, e: written.update(g=g) or True
    )
    res = audit_client.put(
        f"/api/ingests/{HASH}/audit/claim",
        json={
            "variant": "haiku",
            "model": "haiku",
            "prompt_sha": "s",
            "claim_id": "c1",
            "text": "t",
            "quality": "good",
            "value": "irrelevant",
        },
    )
    assert res.status_code == 200, res.text
    [claim] = written["g"]["claims"]
    assert claim["quality"] == "good" and claim["value"] == "irrelevant"


def test_rejects_a_value_outside_the_scale(audit_client, tmp_path, monkeypatch):
    monkeypatch.setattr(server.source, "audit_store_dir", lambda h: tmp_path)
    res = audit_client.put(
        f"/api/ingests/{HASH}/audit/claim",
        json={
            "variant": "h",
            "model": "h",
            "prompt_sha": "s",
            "claim_id": "c",
            "text": "t",
            "value": "priceless",
        },
    )
    assert res.status_code == 400
    assert "value must be" in res.json()["detail"]


def test_gold_is_an_accepted_value(audit_client, tmp_path, monkeypatch):
    store = tmp_path / "store"
    store.mkdir()
    monkeypatch.setattr(server.source, "audit_store_dir", lambda h: store)
    monkeypatch.setattr(server.source, "save_audit", lambda h, g, n, e: True)
    res = audit_client.put(
        f"/api/ingests/{HASH}/audit/claim",
        json={
            "variant": "haiku",
            "model": "haiku",
            "prompt_sha": "s",
            "claim_id": "g1",
            "text": "t",
            "value": "gold",
        },
    )
    assert res.status_code == 200, res.text
