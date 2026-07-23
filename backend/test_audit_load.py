#!/usr/bin/env python3
"""Loading extraction variants off disk: claim parsing, cost from frontmatter,
and the variants/{name}/ vs canonical records/{name}.yaml resolution."""

import yaml

from backend.audit_load import (
    parse_claims,
    load_variant,
    load_variant_file,
    variant_files,
    load_record_variants,
)

DIGEST = {
    "schema": "anomalica/digest/1",
    "model": "opus",
    "ai_usage": [
        # Tokens only - stored dollars were stripped from digests (2026-07-23
        # ruling): cost is DERIVED at display time from tokens x current list
        # price. opus-4-8: $5/MTok in, $25/MTok out.
        {
            "stage": "digest",
            "model": "claude-opus-4-8",
            "tokens": {"input": 1_000_000, "output": 100_000},
        },
        {
            "stage": "extra",
            "model": "claude-opus-4-8",
            "tokens": {"input": 30_000, "output": 1_000},
        },
    ],
    "prompts": [
        {"pass": "nodes", "id": "nodes", "version": "v3"},
        {"pass": "claims", "id": "claims", "version": "v3"},
    ],
    "domain_claims": [
        {
            "id": "c1",
            "location": "00:00:00-00:00:30",
            "quote": "Q1",
            "text": "Claim one",
        },
    ],
    "infrastructure_claims": [
        {
            "id": "c2",
            "location": "00:01:00-00:01:30",
            "quote": "Q2",
            "text": "Claim two",
        },
    ],
}


class TestParseClaims:
    def test_pulls_both_sections_tagged_with_variant(self):
        claims = parse_claims(DIGEST, "opus-v3", "opus")
        assert [c.claim_id for c in claims] == ["c1", "c2"]
        assert all(c.variant == "opus-v3" and c.model == "opus" for c in claims)
        assert claims[0].location == "00:00:00-00:00:30"
        assert claims[0].text == "Claim one"

    def test_missing_fields_default_empty(self):
        claims = parse_claims({"domain_claims": [{"id": "x"}]}, "v", "m")
        assert (
            claims[0].location == "" and claims[0].quote == "" and claims[0].text == ""
        )

    def test_no_claim_sections_is_empty(self):
        assert parse_claims({"model": "opus"}, "v", "m") == []

    def test_surfaces_the_epistemic_frame(self):
        doc = {
            "domain_claims": [
                {
                    "id": "c1",
                    "type": "hearsay",
                    "attestation": "third_hand",
                    "speaker": {"id": "s1", "name": "Stewart, Jon"},
                    "refs": [
                        {"id": "r1", "name": "DIA source"},
                        {"id": "r2", "name": "Tau Ceti"},
                    ],
                    "location": "0:00-0:30",
                    "quote": "Q",
                    "text": "T",
                }
            ]
        }
        c = parse_claims(doc, "opus", "opus")[0]
        assert c.claim_type == "hearsay"
        assert c.attestation == "third_hand"
        assert c.speaker == "Stewart, Jon"
        assert c.refs == ("DIA source", "Tau Ceti")

    def test_epistemic_frame_defaults_empty_when_absent(self):
        c = parse_claims(
            {"domain_claims": [{"id": "x", "text": "flat fact"}]}, "haiku", "haiku"
        )[0]
        assert (
            c.claim_type == ""
            and c.attestation == ""
            and c.speaker == ""
            and c.refs == ()
        )


class TestLoadVariant:
    def test_reads_model_cost_and_prompt_ids(self):
        v = load_variant(DIGEST, "opus-v3")
        assert v.id == "opus-v3"
        assert v.model == "opus"
        # (1M x $5 + 100k x $25)/1M + (30k x $5 + 1k x $25)/1M = 7.5 + 0.175
        assert v.cost_usd == 7.675
        assert v.prompt_ids == ["nodes:v3", "claims:v3"]
        assert len(v.claims) == 2

    def test_cost_none_when_no_usage(self):
        v = load_variant({"model": "haiku"}, "haiku")
        assert v.cost_usd is None


class TestVariantResolution:
    def test_prefers_variants_dir_when_present(self, tmp_path):
        vdir = tmp_path / "variants" / "rec"
        vdir.mkdir(parents=True)
        (vdir / "opus.yaml").write_text(yaml.safe_dump(DIGEST))
        (vdir / "haiku.yaml").write_text(yaml.safe_dump({**DIGEST, "model": "haiku"}))
        files = variant_files(tmp_path, "rec")
        assert [f.name for f in files] == ["haiku.yaml", "opus.yaml"]

    def test_falls_back_to_canonical_when_no_variants_dir(self, tmp_path):
        records = tmp_path / "records"
        records.mkdir(parents=True)
        (records / "rec.yaml").write_text(yaml.safe_dump(DIGEST))
        files = variant_files(tmp_path, "rec")
        assert [f.name for f in files] == ["rec.yaml"]

    def test_empty_when_neither_exists(self, tmp_path):
        assert variant_files(tmp_path, "missing") == []

    def test_load_variant_file_uses_stem_as_id(self, tmp_path):
        p = tmp_path / "opus-v3.yaml"
        p.write_text(yaml.safe_dump(DIGEST))
        v = load_variant_file(p)
        assert v.id == "opus-v3" and len(v.claims) == 2

    def test_load_record_variants_end_to_end(self, tmp_path):
        vdir = tmp_path / "variants" / "rec"
        vdir.mkdir(parents=True)
        (vdir / "opus.yaml").write_text(yaml.safe_dump(DIGEST))
        (vdir / "haiku.yaml").write_text(
            yaml.safe_dump(
                {
                    **DIGEST,
                    "model": "haiku",
                    "domain_claims": [
                        {
                            "id": "h1",
                            "location": "00:00:00-00:00:30",
                            "quote": "Q",
                            "text": "Claim one",
                        },
                    ],
                    "infrastructure_claims": [],
                }
            )
        )
        variants = load_record_variants(tmp_path, "rec")
        assert {v.model for v in variants} == {"opus", "haiku"}
        assert sum(len(v.claims) for v in variants) == 3


def test_cost_reads_the_closed_ai_usage_shape():
    # The closed shape (digest-format.md#ai_usage, anomalica-common 4e5f512):
    # flat tokens_in/tokens_out, model = bare alias, model_version = versioned
    # id. The ALIAS must never key the price - "opus" prices via model_version.
    from backend.audit_load import _variant_cost

    doc = {
        "ai_usage": [
            {
                "stage": "digest",
                "model": "opus",
                "model_version": "claude-opus-4-8",
                "tokens_in": 1_000_000,
                "tokens_out": 100_000,
            }
        ]
    }
    assert _variant_cost(doc) == 7.5  # 1M x $5 + 100k x $25, per MTok


def test_cost_old_nested_shape_is_transitional_fallback():
    # DELETE together with _stage_tokens' nested fallback once the digester's
    # one-shot migration of the 59 pre-ruling digests lands.
    from backend.audit_load import _variant_cost

    doc = {
        "ai_usage": [
            {
                "stage": "digest",
                "model": "claude-sonnet-4-6",
                "tokens": {"input": 1_000_000, "output": 100_000},
            }
        ]
    }
    assert _variant_cost(doc) == 4.5  # 1M x $3 + 100k x $15, per MTok
