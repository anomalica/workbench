from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from backend import evaluations


def _entry(evaluation_id: str, provider_id: str, capability: str) -> dict:
    return {
        "id": evaluation_id,
        "evidence": {
            "provider_id": provider_id,
            "detail_capability": capability,
        },
        "artifacts": [
            {"id": provider_id, "role": "state", "visibility": "private"},
            {
                "id": f"{evaluation_id}-result",
                "role": "result",
                "visibility": "private",
            },
            {
                "id": (
                    "audio-community1-exclusive-reviewed-attribution"
                    if evaluation_id == evaluations.AUDIO_EXCLUSIVE_ID
                    else "pdf-native-text-extraction-reviewed-reference"
                ),
                "role": "gold",
                "visibility": "private",
            },
        ],
    }


def _metric(matched: int, wrong: int, turns: int, wrong_turns: int) -> dict:
    return {
        "matched_words": matched,
        "wrong_words": wrong,
        "word_error_pct": 100 * wrong / matched,
        "turns": turns,
        "wrong_turns": wrong_turns,
        "turn_error_pct": 100 * wrong_turns / turns,
        "labels": 2,
    }


def test_audio_adapter_derives_state_and_returns_sanitised_detail(tmp_path: Path):
    reviewed_path = tmp_path / "reviewed.md"
    reviewed_path.write_text("Reviewed attribution")
    reviewed_sha = hashlib.sha256(reviewed_path.read_bytes()).hexdigest()
    report_path = tmp_path / "report.json"
    regular = _metric(100, 10, 20, 2)
    exclusive = _metric(100, 8, 20, 3)
    report = {
        "records": {
            "a" * 64: {
                "regular": {**regular, "private_path": "/private/audio"},
                "exclusive": exclusive,
                "reviewed_ingest_sha256": reviewed_sha,
            }
        },
        "aggregate": {
            "regular": regular,
            "exclusive": exclusive,
            "adopt_exclusive": False,
            "production_decision": {
                "code": "retain-regular",
                "summary": "Retain regular Community-1 tracks for speaker attribution.",
            },
        },
    }
    report_path.write_text(json.dumps(report))
    attribution_path = tmp_path / "reviewed-attribution.json"
    attribution_path.write_text(
        json.dumps(
            {
                "schema": "anomalica/audio-community1-exclusive-reviewed-attribution/1",
                "evaluation_id": evaluations.AUDIO_EXCLUSIVE_ID,
                "records": [{"record_id": "a" * 64, "sha256": reviewed_sha}],
            }
        )
    )
    detail_path = tmp_path / "detail.json"
    detail_path.write_text(
        json.dumps(
            {
                "schema": "anomalica/audio-community1-exclusive-detail/1",
                "evaluation_id": evaluations.AUDIO_EXCLUSIVE_ID,
                "comparison_note": "Same model output; only the track changes.",
                "production_note": "Production retains regular tracks.",
            }
        )
    )

    detail = evaluations.audio_exclusive_detail(
        _entry(
            evaluations.AUDIO_EXCLUSIVE_ID,
            "audio-community1-exclusive-state",
            "audio-community1-exclusive-detail",
        ),
        attribution_path,
        {"a" * 64: reviewed_path},
        report_path,
        detail_path,
    )

    assert detail["state"]["status"] == "rejected"
    assert detail["state"]["gold"] == {
        "status": "source-reviewed",
        "reviewed": 1,
        "total": 1,
        "unit": "records",
    }
    assert detail["records"][0]["regular"]["wrong_words"] == 10
    assert str(tmp_path) not in json.dumps(detail)
    assert "/private/audio" not in json.dumps(detail)


def test_audio_adapter_rejects_a_decision_that_disagrees_with_metrics(tmp_path: Path):
    reviewed_path = tmp_path / "reviewed.md"
    reviewed_path.write_text("Reviewed attribution")
    reviewed_sha = hashlib.sha256(reviewed_path.read_bytes()).hexdigest()
    report_path = tmp_path / "report.json"
    regular = _metric(100, 10, 20, 2)
    exclusive = _metric(100, 8, 20, 2)
    report_path.write_text(
        json.dumps(
            {
                "records": {
                    "a" * 64: {
                        "regular": regular,
                        "exclusive": exclusive,
                        "reviewed_ingest_sha256": reviewed_sha,
                    }
                },
                "aggregate": {
                    "regular": regular,
                    "exclusive": exclusive,
                    "adopt_exclusive": False,
                    "production_decision": {
                        "code": "retain-regular",
                        "summary": "Retain regular Community-1 tracks for speaker attribution.",
                    },
                },
            }
        )
    )
    attribution_path = tmp_path / "reviewed-attribution.json"
    attribution_path.write_text(
        json.dumps(
            {
                "schema": "anomalica/audio-community1-exclusive-reviewed-attribution/1",
                "evaluation_id": evaluations.AUDIO_EXCLUSIVE_ID,
                "records": [{"record_id": "a" * 64, "sha256": reviewed_sha}],
            }
        )
    )
    detail_path = tmp_path / "detail.json"
    detail_path.write_text(
        json.dumps(
            {
                "schema": "anomalica/audio-community1-exclusive-detail/1",
                "evaluation_id": evaluations.AUDIO_EXCLUSIVE_ID,
                "comparison_note": "Same model.",
                "production_note": "Regular remains live.",
            }
        )
    )

    with pytest.raises(evaluations.EvaluationError, match="adoption result"):
        evaluations.audio_exclusive_detail(
            _entry(
                evaluations.AUDIO_EXCLUSIVE_ID,
                "audio-community1-exclusive-state",
                "audio-community1-exclusive-detail",
            ),
            attribution_path,
            {"a" * 64: reviewed_path},
            report_path,
            detail_path,
        )


def test_pdf_adapter_binds_examples_to_page_metrics_and_hashes_evidence(tmp_path: Path):
    reviewed_path = tmp_path / "reviewed.md"
    reviewed_path.write_text("Reviewed PDF reference")
    reviewed_sha = hashlib.sha256(reviewed_path.read_bytes()).hexdigest()
    report_path = tmp_path / "result.json"
    page = {
        "file_page": 1,
        "reference_words": 10,
        "candidate_words": 10,
        "word_errors": 0,
        "word_error_pct": 0.0,
        "word_precision_pct": 100.0,
        "word_recall_pct": 100.0,
    }
    report_path.write_text(
        json.dumps(
            {
                "page_count": 1,
                "pages": [page],
                "aggregate": {
                    "candidate_words": 10,
                    "pages_with_candidate_text": 1,
                    "reference_words": 10,
                    "word_error_pct": 0.0,
                    "word_errors": 0,
                    "word_precision_pct": 100.0,
                    "word_recall_pct": 100.0,
                },
                "method": "pymupdf-native-text-geometric-sort",
                "inputs": {"reviewed_ingest_sha256": reviewed_sha},
                "production_decision": {
                    "code": "supplement-only",
                    "summary": "Use native text extraction as a supplement; do not replace AI transcription.",
                    "role": "supplement",
                    "replace_ai_transcription": False,
                },
            }
        )
    )
    detail_path = tmp_path / "detail.json"
    detail_path.write_text(
        json.dumps(
            {
                "schema": "anomalica/pdf-native-text-extraction-detail/1",
                "evaluation_id": evaluations.PDF_NATIVE_ID,
                "rights": "public-domain",
                "examples": [
                    {
                        "kind": "normal-page",
                        "file_page": 1,
                        "native": "Extracted public-domain words.",
                        "reviewed": "Extracted public-domain words.",
                        "private_path": "/private/pdf",
                    }
                ],
                "production_note": "Native extraction supplements AI transcription.",
            }
        )
    )

    detail = evaluations.pdf_native_detail(
        _entry(
            evaluations.PDF_NATIVE_ID,
            "pdf-native-text-extraction-state",
            "pdf-native-text-extraction-detail",
        ),
        reviewed_path,
        report_path,
        detail_path,
    )

    state = detail["state"]
    raw_sha = hashlib.sha256(report_path.read_bytes()).hexdigest()
    assert state["status"] == "reviewed"
    assert state["decision"]["code"] == "supplement-only"
    assert state["evidence"] == [
        {
            "artifact_id": "pdf-native-text-extraction-reviewed-reference",
            "sha256": f"sha256:{reviewed_sha}",
        },
        {
            "artifact_id": "pdf-native-text-extraction-result",
            "sha256": f"sha256:{raw_sha}",
        },
    ]
    canonical = json.dumps(
        state["evidence"], ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode()
    assert state["evidence_sha256"] == (
        f"sha256:{hashlib.sha256(canonical).hexdigest()}"
    )
    assert detail["examples"][0]["metrics"]["word_precision_pct"] == 100.0
    assert str(tmp_path) not in json.dumps(detail)
    assert "/private/pdf" not in json.dumps(detail)


def test_ingester_adapter_requires_the_exact_private_provider(tmp_path: Path):
    with pytest.raises(evaluations.EvaluationError, match="allowlisted"):
        evaluations.audio_exclusive_detail(
            _entry(evaluations.AUDIO_EXCLUSIVE_ID, "wrong", "wrong"),
            tmp_path / "missing-attribution.json",
            {},
            tmp_path / "missing.json",
            tmp_path / "missing-detail.json",
        )
