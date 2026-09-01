#!/usr/bin/env python3
"""Pre-render (serverless online plan): the graph + curation reads -> static JSON.
A tiny graph DB, render it, check the JSON tree + content (the live-API parity is
verified separately; here it's the file layout + that it reuses graph/curation)."""

import json
import os
import sqlite3

import pytest
import yaml

from backend import prerender

NID = "11111111-1111-1111-1111-111111111111"

H_PUB = "a" * 64
H_GATED = "b" * 64


@pytest.fixture
def graph_db(tmp_path, monkeypatch):
    db = tmp_path / "knowledge.db"
    con = sqlite3.connect(db)
    con.executescript(
        """
        CREATE TABLE nodes (id TEXT PRIMARY KEY, node_type TEXT, name TEXT,
            metadata TEXT, created_at TEXT, retired_at TEXT);
        CREATE TABLE aliases (alias TEXT, node_id TEXT);
        CREATE TABLE records (id TEXT, title TEXT, reference TEXT, date TEXT,
            producer_id TEXT, content_hash TEXT, friendly_name TEXT, metadata TEXT,
            created_at TEXT);
        CREATE TABLE claims (id TEXT, content TEXT, original_excerpt TEXT,
            claim_type TEXT, attestation TEXT, record_id TEXT, speaker_id TEXT,
            location_in_record TEXT, date TEXT, date_end TEXT, confidence REAL,
            metadata TEXT, created_at TEXT, claim_role TEXT);
        CREATE TABLE claim_node_refs (claim_id TEXT, node_id TEXT);
        CREATE TABLE corroborations (claim_a TEXT, claim_b TEXT, similarity REAL);
        CREATE TABLE node_merges (merge_id TEXT, survivor_id TEXT, victim_id TEXT,
            victim_prior_name TEXT, canonical_name TEXT, created_at TEXT,
            created_by TEXT, undone_at TEXT);
        """
    )
    con.execute(
        "INSERT INTO nodes (id, node_type, name) VALUES (?,?,?)",
        (NID, "person", "Lazar, Bob"),
    )
    con.commit()
    con.close()
    monkeypatch.setenv("GRAPH_DB_PATH", str(db))
    monkeypatch.setenv("ANOMALICA_MERGE_CANDIDATES", str(tmp_path / "absent.json"))

    # Isolate the graph/curation render from the live ingests: stub an empty
    # records source so prerender()'s records pass writes nothing here.
    class _EmptySource:
        def list_ingests(self):
            return []

    from backend import server

    monkeypatch.setattr(server, "source", _EmptySource())
    monkeypatch.setattr(server, "ingests_path", tmp_path / "empty-ingests")
    monkeypatch.setattr(server, "digests_path", tmp_path / "empty-digests")
    # Isolate the articles walk too: absent content dir -> [] (the real content
    # repo must not bleed into this graph/curation render test).
    monkeypatch.setattr(server, "content_path", tmp_path / "empty-content")
    return db


def test_prerender_writes_graph_and_curation_json(graph_db, tmp_path):
    out = tmp_path / "snap"
    counts = prerender.prerender(out)
    assert counts == {
        "nodes": 1,
        "node_detail": 1,
        "ego": 1,
        "media": 0,
        "articles": 0,
        "records": 0,
        "record_public": 0,
        "digests": 0,
        "coverage": 0,
        # A graph built before page proposals existed has no such table. The
        # snapshot must still render - a whole build failing for a feature that
        # has never run is the wrong trade.
        "topics": 0,
        "briefs": 0,
    }

    api = out / "api"
    # Topics travel with the snapshot: the deployed workbench has no database
    # to ask, and without this the tab fetched topics.json, got a 404 and
    # showed an empty list - which reads as "the corpus proposes nothing".
    topics = json.loads((api / "topics.json").read_text())
    assert topics["topics"] == []
    assert "seeded" in topics and "published" in topics
    assert json.loads((api / "articles.json").read_text()) == []
    assert json.loads((api / "graph" / "stats.json").read_text())["total_nodes"] == 1
    nodes = json.loads((api / "graph" / "nodes.json").read_text())
    assert [n["name"] for n in nodes] == ["Lazar, Bob"]
    detail = json.loads((api / "graph" / "nodes" / f"{NID}.json").read_text())
    assert detail["name"] == "Lazar, Bob"
    assert (api / "graph" / "ego" / f"{NID}.json").exists()
    assert json.loads((api / "curation" / "candidates.json").read_text()) == {
        "candidates": []
    }
    assert json.loads((api / "curation" / "merges.json").read_text()) == {"merges": []}


def test_prerender_no_db_raises(tmp_path, monkeypatch):
    monkeypatch.setenv("GRAPH_DB_PATH", str(tmp_path / "absent.db"))
    with pytest.raises(RuntimeError):
        prerender.prerender(tmp_path / "snap")


# --- Records pre-render: the copyright boundary -----------------------------


@pytest.mark.parametrize(
    "status,served",
    [
        ("public_domain", True),
        ("open_licence", True),
        ("publicly_accessible", True),  # opened up (Mark's call - public sources)
        ("licensed", False),  # copyrighted books stay gated
        ("restricted", False),
        ("", False),  # absent -> gated
        (None, False),  # unknown -> gated
        ("some_new_status", False),  # allow-list, not blocklist
    ],
)
def test_serves_verbatim_is_a_failsafe_allowlist(status, served):
    assert prerender.serves_verbatim(status) is served


@pytest.fixture
def records_repo(tmp_path, monkeypatch):
    """A tiny ingests store + digests with one public and one gated record."""
    ing = tmp_path / "ingests"
    (ing / "store").mkdir(parents=True)
    (ing / "by-name").mkdir()
    dig = tmp_path / "digests"
    dig.mkdir(parents=True)

    for h, status, name in [
        (H_PUB, "public_domain", "rec-pub"),
        (H_GATED, "restricted", "rec-gated"),
    ]:
        md = (
            f"---\ncontent_hash: {h}\ncopyright:\n  status: {status}\n"
            f"title: {name}\n---\nBODY of {name}\n"
        )
        (ing / "store" / f"{h}.md").write_text(md)
        os.symlink(ing / "store" / f"{h}.md", ing / "by-name" / f"{name}.md")
        (dig / f"{name}.yaml").write_text(
            yaml.safe_dump(
                {
                    "schema": "anomalica/digest/1",
                    "record": {"id": h},
                    "nodes": [],
                    "domain_claims": [
                        {
                            "id": "c1",
                            "type": "x",
                            "quote": f"VERBATIM {name}",
                            "text": f"fact {name}",
                        }
                    ],
                }
            )
        )

    class FakeSource:
        def list_ingests(self):
            return [
                {
                    "content_hash": H_PUB,
                    "copyright_status": "public_domain",
                    "title": "rec-pub",
                },
                {
                    "content_hash": H_GATED,
                    "copyright_status": "restricted",
                    "title": "rec-gated",
                },
            ]

        def get_ingest(self, h):
            status = "public_domain" if h == H_PUB else "restricted"
            return {
                "content_hash": h,
                "copyright_status": status,
                "body": f"BODY {h[:4]}",
                "raw_frontmatter": f"title: rec\ndescription: SECRET BLURB {h[:4]}\n",
                "frontmatter": {
                    "title": "rec",
                    "copyright.status": status,
                    "description": f"SECRET BLURB {h[:4]}",  # free-text, must drop when gated
                    "word_timestamps": [
                        {"word": "secret", "t": 1}
                    ],  # verbatim transcript
                },
            }

        def load_coverage(self, _h):
            return None

    # Images on BOTH records, so the media gate is exercised through the real
    # prerender path and not just its unit test: the public one must publish,
    # the gated one must not. These stand in for a licensed book's page scans.
    for h in (H_PUB, H_GATED):
        d = ing / "media" / h
        d.mkdir(parents=True, exist_ok=True)
        (d / "0123456789ab.jpg").write_bytes(b"\xff\xd8\xff" + h[:4].encode())

    from backend import server

    monkeypatch.setattr(server, "source", FakeSource())
    monkeypatch.setattr(server, "ingests_path", ing)
    monkeypatch.setattr(server, "digests_path", tmp_path / "digests")
    return tmp_path


def test_records_prerender_gates_body_keeps_short_quotes(records_repo, tmp_path):
    base = tmp_path / "out" / "api"
    counts = prerender._prerender_records(base)
    # media == 1: the public record's image copied, the gated record's withheld.
    assert counts == {
        "records": 2,
        "record_public": 1,
        "digests": 2,
        "coverage": 0,
        "media": 1,
    }

    # The gate, stated as a property of the output tree: the gated record's image
    # is nowhere in the snapshot, and the public one's is.
    assert (base / "ingests" / H_PUB / "media" / "0123456789ab.jpg").is_file()
    assert not (base / "ingests" / H_GATED / "media").exists()

    # The list ships both records as metadata.
    listed = json.loads((base / "ingests.json").read_text())
    assert {r["content_hash"] for r in listed} == {H_PUB, H_GATED}

    # PUBLIC record: body + digest quote present.
    pub = json.loads((base / "ingests" / f"{H_PUB}.json").read_text())
    assert pub["body"] == f"BODY {H_PUB[:4]}"
    pub_digest = json.loads((base / "ingests" / H_PUB / "digest.json").read_text())
    assert pub_digest["domain_claims"][0]["quote"] == "VERBATIM rec-pub"

    # PUBLIC record keeps its raw frontmatter + free-text (redistribution allowed).
    assert pub["raw_frontmatter"]
    assert pub["frontmatter"].get("description")

    # GATED record: body emptied + no verbatim frontmatter (raw dropped; free-text
    # description + the verbatim word_timestamps transcript gone; only whitelisted
    # structured metadata remains) - BUT the digest's short attributed quotes stay.
    gated = json.loads((base / "ingests" / f"{H_GATED}.json").read_text())
    assert gated["body"] == ""
    assert gated["raw_frontmatter"] == ""
    assert "description" not in gated["frontmatter"]
    assert (
        "word_timestamps" not in gated["frontmatter"]
    )  # full transcript = body, gated
    assert gated["frontmatter"]["title"] == "rec"  # structured metadata kept
    assert gated["frontmatter"]["copyright.status"] == "restricted"
    gated_digest = json.loads((base / "ingests" / H_GATED / "digest.json").read_text())
    claim = gated_digest["domain_claims"][0]
    # Quotes are gated with the body. The old policy kept them public as lawful
    # short quotation, but nothing enforced shortness: on 2026-08-19 the gated
    # record 303c2190 ("Imminent") shipped 2,190 quotes totalling 354,535 chars,
    # 41% of its body. Reassembled, that is the book.
    assert "quote" not in claim
    # Our own paraphrase survives, so the public inspection surface is intact.
    assert claim["text"] == "fact rec-gated"


def test_records_prerender_never_writes_a_verification_sidecar(records_repo, tmp_path):
    base = tmp_path / "out" / "api"
    prerender._prerender_records(base)
    assert not list(base.rglob("*verification*"))


def test_prerender_records_only_renders_just_the_named_record(
    records_repo, tmp_path, monkeypatch
):
    # the on-review incremental refresh: re-render ONE record, not the other.
    out = tmp_path / "out"
    monkeypatch.setenv("SNAPSHOT_DIR", str(out))
    prerender.prerender_records_only(hashes=[H_PUB])
    api = out / "api"
    # the named record's detail was (re)rendered...
    assert (api / "ingests" / f"{H_PUB}.json").exists()
    # ...the other record's detail was NOT...
    assert not (api / "ingests" / f"{H_GATED}.json").exists()
    # ...but the list (cheap, reflects review state) is always written + has both.
    listed = json.loads((api / "ingests.json").read_text())
    assert {r["content_hash"] for r in listed} == {H_PUB, H_GATED}


class TestListDoesNotLeakTheGateAnswer:
    """`source_hash` is the sha256 of the original file, and the edge accepts a
    bare matching hash as proof of possession - no upload. Publishing it for a
    gated record publishes the gate's own answer.

    It was excluded from record DETAIL by the frontmatter allow-list but never
    from the LIST, which is the easier file to read: one request, every record.
    Sixteen restricted books shipped it to the public CDN."""

    def test_a_gated_record_row_carries_no_source_hash(self):
        from backend.prerender import _gate_summary

        row = {
            "content_hash": "a" * 64,
            "title": "Communion",
            "copyright_status": "restricted",
            "source_hash": "sha256:" + "b" * 64,
        }
        gated = _gate_summary(row)
        assert "source_hash" not in gated
        # Everything else survives - this is a removal, not a whitelist.
        assert gated["title"] == "Communion"
        assert gated["content_hash"] == row["content_hash"]

    def test_only_gated_records_are_stripped(self):
        # A public record's source_hash is not a secret; nothing gates on it.
        from backend.prerender import serves_verbatim

        assert serves_verbatim("public_domain") is True
        assert serves_verbatim("publicly_accessible") is True
        assert serves_verbatim("restricted") is False
        assert serves_verbatim("licensed") is False
        # Fail-safe: an unknown or absent status is gated.
        assert serves_verbatim(None) is False
        assert serves_verbatim("something_new") is False


class TestDatesDoNotFailTheBuild:
    """One digest carrying an unquoted `release_date` aborted the entire
    prerender - `Object of type date is not JSON serializable` - taking every
    other record's snapshot with it. YAML parses a bare 2026-01-26 into a
    datetime.date and json.dumps refuses it."""

    def test_a_date_serialises_as_iso(self, tmp_path):
        import datetime
        import json

        from backend.prerender import _write

        out = tmp_path / "x.json"
        _write(out, {"release_date": datetime.date(2026, 1, 26)})
        assert json.loads(out.read_text()) == {"release_date": "2026-01-26"}

    def test_a_datetime_serialises_too(self, tmp_path):
        import datetime
        import json

        from backend.prerender import _write

        out = tmp_path / "y.json"
        _write(out, {"at": datetime.datetime(2026, 1, 26, 9, 30)})
        assert json.loads(out.read_text())["at"].startswith("2026-01-26T09:30")

    def test_something_genuinely_unserialisable_still_raises(self, tmp_path):
        # The default must not swallow a real bug by stringifying anything.
        import pytest

        from backend.prerender import _write

        with pytest.raises(TypeError):
            _write(tmp_path / "z.json", {"bad": object()})
