#!/usr/bin/env python3
"""Model-comparison (ADR 0039 Layer 1) - DORMANT feature (built, not wired into
the nav; shelved per Mark, resumes when un-paused). Smoke tests so it doesn't rot:
the provenance-overlap alignment, the comparison shape, and the judgment store."""

import yaml

from backend import models


def test_overlap_alignment():
    # timestamp ranges that overlap / don't
    assert models._overlaps("00:00:01-00:00:10", "00:00:08-00:00:20") is True
    assert models._overlaps("00:00:01-00:00:05", "00:00:09-00:00:20") is False
    # page ranges
    assert models._overlaps("page 21", "p20-23") is True
    assert models._overlaps("page 21", "page 40") is False
    # unparseable -> exact-string fallback
    assert models._overlaps("intro", "intro") is True
    assert models._overlaps("intro", "outro") is False


def _variant(model, prompt, claims, nodes):
    return {
        "model": model,
        "prompt_variant": prompt,
        "record": {"content_hash": "sha256:" + "a" * 64, "title": "Example"},
        "domain_claims": [
            {
                "id": f"{model}-{i}",
                "type": "fact",
                "location": f"00:00:{i:02d}-00:00:{i + 1:02d}",
                "text": f"claim {i}",
            }
            for i in range(claims)
        ],
        "infrastructure_claims": [],
        "nodes": [
            {"id": str(i), "type": "person", "name": f"Person {i}"}
            for i in range(nodes)
        ],
    }


def _variants_repo(tmp_path, monkeypatch):
    vdir = tmp_path / "variants" / "example-slug"
    vdir.mkdir(parents=True)
    (vdir / "claude-opus-4-8-default.yaml").write_text(
        yaml.safe_dump(_variant("claude-opus-4-8", "default", 6, 5))
    )
    (vdir / "claude-haiku-4-5-tuned.yaml").write_text(
        yaml.safe_dump(_variant("claude-haiku-4-5", "tuned", 3, 3))
    )
    monkeypatch.setenv("DIGESTS_VARIANTS", str(tmp_path / "variants"))


def test_list_comparable_and_compare(tmp_path, monkeypatch):
    monkeypatch.setenv("DIGESTS_VARIANTS", str(tmp_path / "none"))
    assert models.list_comparable() == []  # no variants dir

    _variants_repo(tmp_path, monkeypatch)
    comp = models.list_comparable()
    assert len(comp) == 1
    assert comp[0]["variant_count"] == 2
    assert set(comp[0]["models"]) == {"claude-opus-4-8", "claude-haiku-4-5"}

    cmp = models.load_comparison("a" * 64)
    by_model = {m["model"]: m for m in cmp["per_model"]}
    assert by_model["claude-opus-4-8"]["claim_count"] == 6
    assert by_model["claude-haiku-4-5"]["claim_count"] == 3
    assert by_model["claude-opus-4-8"]["prompt_variant"] == "default"
    # the haiku claims (0-2) overlap opus claims (0-5) -> shared; opus 3-5 unique
    assert by_model["claude-opus-4-8"]["unique_count"] >= 1
    # entities aligned: 3 shared (both have Person 0-2), 2 opus-only
    assert sum(1 for e in cmp["entities"] if len(e["models"]) > 1) == 3


def test_judgment_store(tmp_path, monkeypatch):
    monkeypatch.setenv("RUNNER_STATE_DIR", str(tmp_path / "state"))
    assert models.latest_judgment("h1") is None
    bad = models.save_judgment("h1", ["a", "b"], "c")  # chosen not in compared
    assert bad["ok"] is False
    ok = models.save_judgment("h1", ["a", "b"], "a", judged_by="mark@x", notes="a wins")
    assert ok["ok"] is True
    latest = models.latest_judgment("h1")
    assert latest["chosen_model"] == "a" and latest["models_compared"] == ["a", "b"]
    assert latest["judged_by"] == "mark@x"
