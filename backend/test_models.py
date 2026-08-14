#!/usr/bin/env python3
"""Model-comparison (ADR 0039 Layer 1) - the Digests tab. Covers the
provenance-overlap alignment, the comparison shape, the judgment store, and the
cost of opening a comparison (which is what made the tab unusable once the
corpus grew past a handful of records)."""

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


def _variants_repo(tmp_path, monkeypatch, active=True):
    """Variant digests plus, by default, the record they describe.

    The record matters: the comparable list only offers records in the ACTIVE
    corpus, resolved by content hash against store/. Archiving moves a record to
    store/v1/ and deletes its by-name/ symlink, so a variants directory can
    outlive the record it is named for - and offering it produces a list entry
    that 404s when opened. `active=False` models that archived state.
    """
    store = tmp_path / "ingests" / "store"
    (store / "v1").mkdir(parents=True)
    (store / f"{'a' * 64}.md").write_text("x") if active else (
        store / "v1" / f"{'a' * 64}.md"
    ).write_text("x")
    monkeypatch.setenv("INGESTS_PATH", str(tmp_path / "ingests"))

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


def test_list_comparable_omits_an_archived_record(tmp_path, monkeypatch):
    """Mark archived pantex while its variants stayed on disk; the list kept
    offering it and opening it 404'd. A record only in store/v1/ is not on offer."""
    _variants_repo(tmp_path, monkeypatch, active=False)
    assert models.list_comparable() == []

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


class TestComparisonCost:
    """Opening a comparison must not read the whole corpus.

    _find_variants used to fully parse EVERY variant YAML in a directory just to
    test whether the FIRST one's content_hash matched, then discard the lot and
    move to the next directory. A record late in the scan paid for parsing every
    variant of every record before it: 43 documents and ~12s for the smallest
    record in the corpus, which is what made the Digests tab unusable.
    """

    def _variant(self, content_hash, model, n):
        return {
            "model": model,
            "record": {"content_hash": f"sha256:{content_hash}", "title": "T"},
            "domain_claims": [
                {"id": f"{model}{i}", "location": "00:00:00-00:00:30", "text": f"c{i}"}
                for i in range(n)
            ],
            "infrastructure_claims": [],
        }

    def _corpus(self, tmp_path, monkeypatch, records=6, variants=3):
        import yaml as _yaml

        base = tmp_path / "variants"
        hashes = []
        for r in range(records):
            h = f"{r:064x}"
            hashes.append(h)
            d = base / f"2026-01-0{r}-rec-{r}"
            d.mkdir(parents=True)
            for m in ("haiku", "opus", "sonnet")[:variants]:
                (d / f"{m}.yaml").write_text(_yaml.safe_dump(self._variant(h, m, 5)))
        monkeypatch.setenv("DIGESTS_VARIANTS", str(base))
        return hashes

    def test_parses_only_the_matching_record(self, tmp_path, monkeypatch):
        hashes = self._corpus(tmp_path, monkeypatch)
        parsed: list[str] = []
        real_load = models._load

        def counting_load(path):
            parsed.append(str(path))
            return real_load(path)

        monkeypatch.setattr(models, "_load", counting_load)
        # The LAST record - worst case for a scan that parses as it goes.
        assert models.load_comparison(hashes[-1]) is not None
        yaml_parsed = [p for p in parsed if p.endswith(".yaml")]
        # Only the matching directory's own variants, not the five before it.
        assert len(yaml_parsed) == 3, yaml_parsed

    def test_a_directory_whose_first_file_has_no_hash_still_resolves(
        self, tmp_path, monkeypatch
    ):
        # The old code skipped unloadable files and used the first that parsed;
        # peeking must fall through the same way rather than abandon the dir.
        hashes = self._corpus(tmp_path, monkeypatch, records=2)
        d = tmp_path / "variants" / "2026-01-01-rec-1"
        (d / "aaa-broken.yaml").write_text("not: [a, valid, digest\n")
        assert models.load_comparison(hashes[1]) is not None

    def test_unknown_hash_returns_none(self, tmp_path, monkeypatch):
        self._corpus(tmp_path, monkeypatch, records=2)
        assert models.load_comparison("f" * 64) is None


class TestIntervalMemoisation:
    def test_repeated_locations_parse_once(self):
        models._interval_of.cache_clear()
        for _ in range(50):
            models._interval("00:01:02.3-00:01:10.0")
        info = models._interval_of.cache_info()
        assert info.misses == 1 and info.hits == 49

    def test_memoised_values_match_a_fresh_parse(self):
        for loc in (
            "00:01:02.3-00:01:10.0",
            "page 21",
            "p21-23",
            "not a location",
            "",
            None,
        ):
            first = models._interval(loc)
            models._interval_of.cache_clear()
            assert models._interval(loc) == first
