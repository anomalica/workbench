#!/usr/bin/env python3
"""Loading extraction variants off disk: claim parsing, node parsing, cost from
frontmatter, the variants/{name}/ vs canonical records/{name}.yaml resolution,
and the stat signature the payload cache keys on."""

import os

import yaml

from backend.audit_load import (
    parse_claims,
    parse_nodes,
    load_variant,
    load_variant_file,
    variant_files,
    variant_signature,
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
        (tmp_path / "rec.yaml").write_text(yaml.safe_dump(DIGEST))
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


class TestParseNodes:
    def test_pulls_entities_tagged_with_variant(self):
        doc = {
            **DIGEST,
            "nodes": [
                {"id": "n1", "type": "person", "name": "Stewart, Jon"},
                {"id": "n2", "type": "organisation", "name": "NASA"},
            ],
        }
        nodes = parse_nodes(doc, "opus-v3", "opus")
        assert [n.name for n in nodes] == ["Stewart, Jon", "NASA"]
        assert all(n.variant == "opus-v3" and n.model == "opus" for n in nodes)

    def test_drops_unnamed_entities(self):
        # An unnamed node can never be matched to another model's, so it would
        # only ever render as a phantom singleton.
        doc = {**DIGEST, "nodes": [{"id": "n1", "type": "person", "name": "  "}]}
        assert parse_nodes(doc, "v", "m") == []

    def test_no_nodes_section_is_empty(self):
        assert parse_nodes(DIGEST, "v", "m") == []

    def test_load_variant_carries_nodes(self):
        doc = {**DIGEST, "nodes": [{"id": "n1", "type": "person", "name": "Ada"}]}
        assert [n.name for n in load_variant(doc, "v").nodes] == ["Ada"]


class TestVariantSignature:
    def test_changes_when_a_variant_file_changes(self, tmp_path):
        vdir = tmp_path / "variants" / "rec"
        vdir.mkdir(parents=True)
        f = vdir / "opus.yaml"
        f.write_text(yaml.safe_dump(DIGEST))
        first = variant_signature(tmp_path, "rec")
        assert first == variant_signature(tmp_path, "rec")  # stable while unchanged

        os.utime(f, ns=(0, 0))  # a rewrite the cache must notice
        assert variant_signature(tmp_path, "rec") != first

    def test_changes_when_a_variant_is_added(self, tmp_path):
        vdir = tmp_path / "variants" / "rec"
        vdir.mkdir(parents=True)
        (vdir / "opus.yaml").write_text(yaml.safe_dump(DIGEST))
        before = variant_signature(tmp_path, "rec")
        (vdir / "haiku.yaml").write_text(yaml.safe_dump(DIGEST))
        assert variant_signature(tmp_path, "rec") != before

    def test_empty_when_no_variants(self, tmp_path):
        assert variant_signature(tmp_path, "nothing-here") == ()


class TestEntailment:
    """The digester's per-claim check rides through to the payload untouched,
    and anything that is not its shape is 'not assessed' rather than a value
    the sort would trust."""

    def test_the_field_passes_through(self):
        from backend.audit_load import parse_claims

        doc = {
            "domain_claims": [
                {
                    "id": "c1",
                    "quote": "the sky was green",
                    "text": "the sky was blue",
                    "entailment": {
                        "label": "contradicts",
                        "score": 0.812,
                        "model": "MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli",
                    },
                }
            ]
        }
        [c] = parse_claims(doc, "v", "m")
        assert c.entailment.label == "contradicts"
        assert c.entailment.score == 0.812
        assert c.entailment.model.startswith("MoritzLaurer/")

    def test_premise_passes_through_and_defaults_to_the_quote(self):
        from backend.audit_load import parse_claims

        def one(ent):
            [c] = parse_claims(
                {
                    "domain_claims": [
                        {"id": "c", "quote": "q", "text": "t", "entailment": ent}
                    ]
                },
                "v",
                "m",
            )
            return c.entailment

        base = {"label": "entails", "score": 0.7, "model": "m"}
        assert one({**base, "premise": "window"}).premise == "window"
        assert one({**base, "premise": "quote"}).premise == "quote"
        # Missing or unknown: the quote, as the digester specified.
        assert one(base).premise == "quote"
        assert one({**base, "premise": "paragraph"}).premise == "quote"

    def test_absent_is_not_assessed(self):
        from backend.audit_load import parse_claims

        [c] = parse_claims(
            {"domain_claims": [{"id": "c1", "quote": "q", "text": "t"}]}, "v", "m"
        )
        assert c.entailment is None

    def test_a_shape_that_is_not_the_digester_s_is_not_trusted(self):
        from backend.audit_load import parse_claims

        for bad in (
            {"label": "supports", "score": 0.9, "model": "m"},
            {"label": "contradicts", "score": "high", "model": "m"},
            {"label": "contradicts", "score": 1.7, "model": "m"},
            "contradicts",
        ):
            [c] = parse_claims(
                {
                    "domain_claims": [
                        {"id": "c", "quote": "q", "text": "t", "entailment": bad}
                    ]
                },
                "v",
                "m",
            )
            assert c.entailment is None, bad
