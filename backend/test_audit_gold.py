#!/usr/bin/env python3
"""audit_gold v2: claim quality/irrelevant verdicts + cluster best-of.

The properties pinned are the contract ones (converged with anomalica/digester,
bus 2026-07-23): identity by gold_id with (variant, claim_id) fallback so
re-judging updates rather than duplicates; strict enums because the eval scores
on what is stored; absent quality = unjudged, never fine; skipped best-of never
stored as a loss; v1 documents read as empty (clean slate, zero existed)."""

import json

from backend import audit_gold


def _claim(**over):
    base = {
        "variant": "haiku.d161b1ed",
        "model": "haiku",
        "prompt_sha": "d161b1ed",
        "claim_id": "c-1",
        "location": "00:01:00.0-00:01:10.0",
        "text": "the claim as written",
        "quote": "verbatim source words",
        "quality": "good",
    }
    base.update(over)
    return base


class TestReadWrite:
    def test_read_empty_when_absent(self, tmp_path):
        gold = audit_gold.read(tmp_path, "a" * 64)
        assert gold == {
            "schema": "anomalica/audit/2",
            "record_hash": "a" * 64,
            "models": [],
            "claims": [],
            "clusters": [],
        }

    def test_write_then_read_roundtrips(self, tmp_path):
        gold = audit_gold.empty("a" * 64)
        audit_gold.upsert_claim(gold, _claim())
        audit_gold.write(tmp_path, "a" * 64, gold)
        assert audit_gold.read(tmp_path, "a" * 64) == gold

    def test_malformed_file_reads_empty(self, tmp_path):
        (tmp_path / f"{'a' * 64}.audit.json").write_text("{ not json")
        assert audit_gold.read(tmp_path, "a" * 64)["claims"] == []

    def test_a_v1_document_reads_empty(self, tmp_path):
        # Clean slate was CONFIRMED (zero v1 files on disk) - but if one ever
        # appears, it must read as empty rather than crash or half-parse.
        v1 = {
            "schema": "anomalica/audit/1",
            "record_hash": "a" * 64,
            "adjudications": [{}],
        }
        (tmp_path / f"{'a' * 64}.audit.json").write_text(json.dumps(v1))
        assert audit_gold.read(tmp_path, "a" * 64)["claims"] == []


class TestClaimUpsert:
    def test_mints_a_gold_id(self):
        gold = audit_gold.empty("a" * 64)
        e = audit_gold.upsert_claim(gold, _claim())
        assert e["gold_id"]

    def test_rejudging_the_same_claim_updates_one_entry(self):
        # The bulk-grading path: press 3 then change your mind to 2. Identity
        # falls back to (variant, claim_id), so no duplicate accumulates.
        gold = audit_gold.empty("a" * 64)
        audit_gold.upsert_claim(gold, _claim(quality="good"))
        audit_gold.upsert_claim(gold, _claim(quality="okay"))
        assert len(gold["claims"]) == 1
        assert gold["claims"][0]["quality"] == "okay"

    def test_same_claim_id_under_another_variant_is_a_different_entry(self):
        gold = audit_gold.empty("a" * 64)
        audit_gold.upsert_claim(gold, _claim())
        audit_gold.upsert_claim(gold, _claim(variant="opus.d161b1ed", model="opus"))
        assert len(gold["claims"]) == 2

    def test_remove(self):
        gold = audit_gold.empty("a" * 64)
        e = audit_gold.upsert_claim(gold, _claim())
        assert audit_gold.remove(gold, e["gold_id"]) is True
        assert gold["claims"] == []
        assert audit_gold.remove(gold, "nope") is False


class TestClaimValidation:
    def test_valid(self):
        assert audit_gold.validate_claim(_claim()) is None

    def test_quality_enum_is_strict(self):
        # Stored as given and scored by the eval - "great" must never land.
        assert audit_gold.validate_claim(_claim(quality="great")) is not None

    def test_irrelevant_alone_is_a_verdict(self):
        c = _claim()
        del c["quality"]
        c["irrelevant"] = True
        assert audit_gold.validate_claim(c) is None

    def test_neither_quality_nor_irrelevant_is_not_a_verdict(self):
        c = _claim()
        del c["quality"]
        assert audit_gold.validate_claim(c) is not None

    def test_variant_identity_fields_required(self):
        for field in ("variant", "model", "prompt_sha", "claim_id"):
            c = _claim()
            del c[field]
            assert audit_gold.validate_claim(c) is not None, field


class TestClusters:
    def _cluster(self, best="opus.d161b1ed"):
        entry = {
            "members": [
                {"variant": "haiku.d161b1ed", "claim_id": "c-1"},
                {"variant": "opus.d161b1ed", "claim_id": "c-9"},
            ],
        }
        if best is not None:
            entry["best_variant"] = best
        return entry

    def test_valid(self):
        assert audit_gold.validate_cluster(self._cluster()) is None

    def test_best_must_be_a_member(self):
        assert (
            audit_gold.validate_cluster(self._cluster(best="sonnet.d161b1ed"))
            is not None
        )

    def test_needs_two_members(self):
        c = self._cluster()
        c["members"] = c["members"][:1]
        assert audit_gold.validate_cluster(c) is not None

    def test_rechoosing_updates_by_member_overlap(self):
        # Clusterings drift between runs; sharing any member means the same
        # underlying fact group, so the choice updates instead of duplicating.
        gold = audit_gold.empty("a" * 64)
        audit_gold.upsert_cluster(gold, self._cluster())
        again = self._cluster(best="haiku.d161b1ed")
        again["members"] = [
            {"variant": "haiku.d161b1ed", "claim_id": "c-1"},
            {"variant": "sonnet.aaaa1111", "claim_id": "c-5"},
        ]
        audit_gold.upsert_cluster(gold, again)
        assert len(gold["clusters"]) == 1
        assert gold["clusters"][0]["best_variant"] == "haiku.d161b1ed"

    def test_skip_is_representable_as_absence_only(self):
        # A skipped cluster is simply not sent/stored - validate allows an entry
        # without best_variant (members recorded, no winner), and nothing forces
        # a client to write one.
        assert audit_gold.validate_cluster(self._cluster(best=None)) is None


class TestSpecHardening:
    def test_empty_carries_the_required_models_field(self):
        # Without the model set, "absent from a cluster" cannot be told from
        # "never run on this record" - missed-fact rate becomes uncomputable.
        assert audit_gold.empty("a" * 64)["models"] == []

    def test_tie_is_explicit_and_exclusive_with_best(self):
        members = [
            {"variant": "haiku.d161b1ed", "claim_id": "c-1"},
            {"variant": "opus.d161b1ed", "claim_id": "c-9"},
        ]
        assert audit_gold.validate_cluster({"members": members, "tie": True}) is None
        assert (
            audit_gold.validate_cluster(
                {"members": members, "tie": True, "best_variant": "opus.d161b1ed"}
            )
            is not None
        )
