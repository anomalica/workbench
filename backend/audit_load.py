"""Load extraction variants of a record off disk for the audit view.

This is the disk/YAML seam that `audit.py` deliberately does not own. A variant
is one (model, prompt) digest of a record; they live at
`digests/variants/{friendly-name}/*.yaml` keyed by the reproducibility triple
(pre-digest-hash + prompt-version + model), with the canonical digest at
`digests/records/{friendly-name}.yaml`. The 1:N variant store is not populated
yet (ADR 0039), so this loads the canonical as a single variant today and picks
up `variants/{name}/*.yaml` when the digester's variant-run lands.

A digest file is plain YAML (no frontmatter fence): top-level `model`,
`ai_usage` (per-stage tokens + `notional_cost_usd`), `prompts`, and the claim
lists `domain_claims` / `infrastructure_claims`.
"""

from __future__ import annotations

import hashlib

from pathlib import Path

import yaml

from backend.audit import (
    Claim,
    Similar,
    Variant,
    axis_confounded,
    build_passages,
    claims_of,
)

_CLAIM_SECTIONS = ("domain_claims", "infrastructure_claims")


def parse_claims(doc: dict, variant_id: str, model: str) -> list[Claim]:
    """Pull every claim (domain + infrastructure) out of a digest doc, tagged
    with the variant that produced it. Missing fields default to empty so a
    malformed claim never aborts the load."""
    claims: list[Claim] = []
    for section in _CLAIM_SECTIONS:
        for c in doc.get(section) or []:
            claims.append(
                Claim(
                    variant=variant_id,
                    model=model,
                    claim_id=str(c.get("id", "")),
                    location=str(c.get("location", "")),
                    quote=str(c.get("quote", "")),
                    text=str(c.get("text", "")),
                    claim_type=str(c.get("type", "") or ""),
                    attestation=str(c.get("attestation", "") or ""),
                    speaker=_speaker_name(c.get("speaker")),
                    refs=_ref_names(c.get("refs")),
                )
            )
    return claims


def _speaker_name(speaker) -> str:
    """The speaker's display name from a claim's `speaker` (a {id, name} map)."""
    if isinstance(speaker, dict):
        return str(speaker.get("name", "") or "")
    return str(speaker or "")


def _ref_names(refs) -> tuple[str, ...]:
    """The entity names a claim references (its `refs`, each an {id, name} map) -
    the model's take on what the claim is sourced to / about."""
    if not isinstance(refs, list):
        return ()
    out = []
    for r in refs:
        name = r.get("name") if isinstance(r, dict) else r
        if name:
            out.append(str(name))
    return tuple(out)


def _variant_cost(doc: dict) -> float | None:
    """Sum the per-stage `notional_cost_usd` recorded in the digest frontmatter.
    None when no usage was recorded."""
    usage = doc.get("ai_usage")
    if not isinstance(usage, list):
        return None
    total = 0.0
    seen = False
    for stage in usage:
        cost = stage.get("notional_cost_usd") if isinstance(stage, dict) else None
        if isinstance(cost, (int, float)):
            total += float(cost)
            seen = True
    return total if seen else None


def prompt_fingerprint(doc: dict) -> str:
    """Short digest of the prompt SHAs a variant ran, as the identity of "which
    prompt was this?".

    NOT the version label: two variants can both say `version: v3` and have
    different claims prompts (403ed351 vs 3a766d14 today), so keying on the label
    silently presents a prompt difference as a model difference. Order-stable, so
    the same prompt set always fingerprints the same."""
    shas = sorted(
        str(p.get("sha256", ""))
        for p in (doc.get("prompts") or [])
        if isinstance(p, dict) and p.get("sha256")
    )
    if not shas:
        return ""
    return hashlib.sha256("|".join(shas).encode()).hexdigest()[:8]


def load_variant(doc: dict, variant_id: str) -> Variant:
    """Build a Variant from a parsed digest doc."""
    model = str(doc.get("model", "") or "")
    prompt_ids = [
        f"{p.get('id', '')}:{p.get('version', '')}"
        for p in (doc.get("prompts") or [])
        if isinstance(p, dict)
    ]
    return Variant(
        id=variant_id,
        model=model,
        claims=parse_claims(doc, variant_id, model),
        cost_usd=_variant_cost(doc),
        prompt_ids=prompt_ids,
        prompt_fingerprint=prompt_fingerprint(doc),
    )


def load_variant_file(path: Path) -> Variant:
    """Load a single variant YAML file. The file stem is the variant id."""
    doc = yaml.safe_load(path.read_text()) or {}
    return load_variant(doc, variant_id=path.stem)


def variant_files(digests_path: Path, friendly_name: str) -> list[Path]:
    """Every variant file for a record, in stable name order: the per-variant
    files under `variants/{name}/`, else the canonical `records/{name}.yaml` as a
    lone variant while the 1:N store is unpopulated."""
    variant_dir = digests_path / "variants" / friendly_name
    if variant_dir.is_dir():
        files = sorted(variant_dir.glob("*.yaml")) + sorted(variant_dir.glob("*.md"))
        if files:
            return files
    canonical = digests_path / "records" / f"{friendly_name}.yaml"
    return [canonical] if canonical.exists() else []


def load_record_variants(digests_path: Path, friendly_name: str) -> list[Variant]:
    """Load every extraction variant of a record."""
    return [load_variant_file(p) for p in variant_files(digests_path, friendly_name)]


# --- serialisation to the audit-view payload --------------------------------


def audit_payload(variants: list[Variant], similar: Similar) -> dict:
    """The JSON the audit view renders: a variant summary (with cost) plus the
    source passages, each carrying its meaning-clusters, member phrasings, and
    the singleton flag. Clustering runs over every variant's claims together."""
    passages = build_passages(claims_of(variants), similar)
    confounded = axis_confounded(passages, len(variants))
    return {
        # Whether the singleton signal means anything at all for this record. When
        # confounded, every cluster is a singleton because the models' claims were
        # never compared - the UI must say so and refuse adjudication rather than
        # let a reviewer grade an artefact.
        "axis": {"confounded": bool(confounded), "reason": confounded},
        "variants": [
            {
                "id": v.id,
                "model": v.model,
                "cost_usd": v.cost_usd,
                "prompt_ids": v.prompt_ids,
                "prompt_fingerprint": v.prompt_fingerprint,
                "claim_count": len(v.claims),
            }
            for v in variants
        ],
        "passages": [
            {
                "index": p.index,
                "start": p.start,
                "end": p.end,
                "raw_locations": p.raw_locations,
                "clusters": [
                    {
                        "id": cl.id,
                        "singleton": cl.singleton,
                        "variants": sorted(cl.variants),
                        "members": [
                            {
                                "variant": m.variant,
                                "model": m.model,
                                "claim_id": m.claim_id,
                                "location": m.location,
                                "quote": m.quote,
                                "text": m.text,
                                "claim_type": m.claim_type,
                                "attestation": m.attestation,
                                "speaker": m.speaker,
                                "refs": list(m.refs),
                            }
                            for m in cl.members
                        ],
                    }
                    for cl in p.clusters
                ],
            }
            for p in passages
        ],
    }


def build_audit(digests_path: Path, friendly_name: str, similar: Similar) -> dict:
    """Load a record's variants and produce the full audit payload."""
    return audit_payload(load_record_variants(digests_path, friendly_name), similar)
