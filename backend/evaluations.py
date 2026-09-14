"""Admin-only adapters for the central evaluation registry."""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import subprocess
import tempfile
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

import yaml


class EvaluationError(ValueError):
    """Registry or evaluation data cannot be served safely."""


class EvaluationNotFound(EvaluationError):
    """No supported detail adapter exists for this evaluation."""


SCHEMA = "anomalica/evaluation-registry/2"
STATUSES = [
    "proposed",
    "ready-for-human-review",
    "reviewed",
    "adopted",
    "rejected",
    "blocked",
]
GOLD_STATUSES = [
    "unavailable",
    "source-reviewed",
    "provisional",
    "ready-for-human-review",
    "human-reviewed",
    "reviewed-derived",
]
SEARCH_ID = "search-reranker-minilm-vs-granite"
SEARCH_JUDGEMENT_ARTIFACT = "search-reranker-minilm-vs-granite-human-judgements"
ACCOUNT_ID = "account-chronology"
DIGEST_ID = "digest-evaluation-corpus"
AUDIO_EXCLUSIVE_ID = "audio-community1-exclusive"
PDF_NATIVE_ID = "pdf-native-text-extraction"
STATE_SCHEMA = "anomalica/evaluation-state/1"
JUDGEMENT_SCHEMA = "anomalica/search-reranker-human-judgements/1"
JUDGEMENTS = {"minilm", "granite", "tie", "defer"}
EXPECTED_MODELS = {
    "minilm": (
        "cross-encoder/ms-marco-MiniLM-L-6-v2",
        "c5ee24cb16019beea0893ab7796b1df96625c6b8",
    ),
    "granite": (
        "ibm-granite/granite-embedding-english-r2",
        "47ea694b257b703fee9253d75c2b1f2985180498",
    ),
}
_WRITE_LOCK = threading.Lock()
_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_SHA = re.compile(r"^sha256:[0-9a-f]{64}$")


def _mapping(path: Path) -> dict:
    try:
        value = yaml.safe_load(path.read_text())
    except (OSError, ValueError, yaml.YAMLError) as exc:
        raise EvaluationError(f"Cannot read evaluation data: {path.name}") from exc
    if not isinstance(value, dict):
        raise EvaluationError(f"Evaluation data is not a mapping: {path.name}")
    return value


def _json_mapping(path: Path) -> dict:
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        raise EvaluationError(f"Cannot read evaluation data: {path.name}") from exc
    if not isinstance(value, dict):
        raise EvaluationError(f"Evaluation data is not a mapping: {path.name}")
    return value


def load_registry(path: Path) -> dict:
    registry = _mapping(path)
    if registry.get("schema") != SCHEMA:
        raise EvaluationError("Unsupported evaluation registry")
    if (
        registry.get("state_schema") != STATE_SCHEMA
        or registry.get("statuses") != STATUSES
        or registry.get("gold_statuses") != GOLD_STATUSES
    ):
        raise EvaluationError(
            "Evaluation registry vocabularies do not match the contract"
        )
    evaluations = registry.get("evaluations")
    if not isinstance(evaluations, list):
        raise EvaluationError("Evaluation registry has no evaluations")

    evaluation_ids: set[str] = set()
    artifact_ids: set[str] = set()
    for entry in evaluations:
        if not isinstance(entry, dict):
            raise EvaluationError("Evaluation registry entry is not a mapping")
        evaluation_id = entry.get("id")
        if (
            not isinstance(evaluation_id, str)
            or not _ID.fullmatch(evaluation_id)
            or evaluation_id in evaluation_ids
        ):
            raise EvaluationError("Evaluation registry IDs are missing or duplicated")
        evaluation_ids.add(evaluation_id)
        if any(name in entry for name in ("status", "gold", "decision")):
            raise EvaluationError(
                f"Evaluation {evaluation_id} copies dynamic state into the registry"
            )
        evidence = entry.get("evidence")
        limits = entry.get("limits")
        if (
            not isinstance(evidence, dict)
            or set(evidence)
            != {
                "provider_id",
                "detail_capability",
            }
            or not all(isinstance(value, str) and value for value in evidence.values())
        ):
            raise EvaluationError(f"Evaluation {evaluation_id} has invalid evidence")
        if not isinstance(limits, dict) or not all(
            isinstance(limits.get(name), str) for name in ("rights", "routes")
        ):
            raise EvaluationError(f"Evaluation {evaluation_id} has invalid limits")
        for artifact in entry.get("artifacts") or []:
            if not isinstance(artifact, dict):
                raise EvaluationError(
                    f"Evaluation {evaluation_id} has an invalid artifact"
                )
            artifact_id = artifact.get("id")
            visibility = artifact.get("visibility")
            if not isinstance(artifact_id, str) or artifact_id in artifact_ids:
                raise EvaluationError(
                    "Evaluation artifact IDs are missing or duplicated"
                )
            artifact_ids.add(artifact_id)
            if visibility == "private":
                if "repository" in artifact or "path" in artifact:
                    raise EvaluationError(
                        "Private evaluation artifacts must not expose locators"
                    )
            elif visibility == "public":
                repository = artifact.get("repository")
                raw_path = artifact.get("path")
                if (
                    not isinstance(repository, str)
                    or not isinstance(raw_path, str)
                    or Path(raw_path).is_absolute()
                    or ".." in Path(raw_path).parts
                ):
                    raise EvaluationError(
                        "Public evaluation artifact locator is invalid"
                    )
            else:
                raise EvaluationError("Evaluation artifact visibility is invalid")
        provider = next(
            (
                artifact
                for artifact in entry.get("artifacts") or []
                if artifact.get("id") == evidence["provider_id"]
            ),
            None,
        )
        if not provider or provider.get("role") != "state":
            raise EvaluationError(
                f"Evaluation {evaluation_id} has no registered state provider"
            )
    return registry


def validate_state(
    entry: dict,
    state: dict,
    public_artifacts: dict[str, Path] | None = None,
) -> dict:
    """Validate one owner state and, for public providers, its exact evidence."""
    evaluation_id = entry["id"]
    if (
        state.get("schema") != STATE_SCHEMA
        or state.get("evaluation_id") != evaluation_id
    ):
        raise EvaluationError(f"State identity does not match {evaluation_id}")
    evidence = state.get("evidence")
    if not isinstance(evidence, list) or not evidence:
        raise EvaluationError(f"State evidence is missing for {evaluation_id}")
    seen: set[str] = set()
    for item in evidence:
        if not isinstance(item, dict) or set(item) != {"artifact_id", "sha256"}:
            raise EvaluationError(f"State evidence is malformed for {evaluation_id}")
        artifact_id = item.get("artifact_id")
        sha = item.get("sha256")
        if (
            not isinstance(artifact_id, str)
            or not artifact_id
            or artifact_id in seen
            or not isinstance(sha, str)
            or not _SHA.fullmatch(sha)
        ):
            raise EvaluationError(f"State evidence is malformed for {evaluation_id}")
        seen.add(artifact_id)
        if public_artifacts is not None:
            path = public_artifacts.get(artifact_id)
            if path is None or not path.is_file():
                raise EvaluationError(
                    f"State evidence is unavailable for {evaluation_id}"
                )
            actual = f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"
            if actual != sha:
                raise EvaluationError(f"State evidence is stale for {evaluation_id}")
    canonical = json.dumps(
        evidence, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode()
    expected_evidence_sha = f"sha256:{hashlib.sha256(canonical).hexdigest()}"
    if state.get("evidence_sha256") != expected_evidence_sha:
        raise EvaluationError(f"State evidence hash is invalid for {evaluation_id}")

    status = state.get("status")
    gold = state.get("gold")
    if (
        status not in STATUSES
        or not isinstance(gold, dict)
        or set(gold)
        != {
            "status",
            "reviewed",
            "total",
            "unit",
        }
    ):
        raise EvaluationError(f"State lifecycle is malformed for {evaluation_id}")
    reviewed, total = gold.get("reviewed"), gold.get("total")
    if (
        gold.get("status") not in GOLD_STATUSES
        or isinstance(reviewed, bool)
        or not isinstance(reviewed, int)
        or isinstance(total, bool)
        or not isinstance(total, int)
        or reviewed < 0
        or total < reviewed
        or not isinstance(gold.get("unit"), str)
        or not gold["unit"]
    ):
        raise EvaluationError(f"State gold is malformed for {evaluation_id}")
    blocker = state.get("blocked_reason")
    if (status == "blocked") != (isinstance(blocker, str) and bool(blocker.strip())):
        raise EvaluationError(f"State blocker is malformed for {evaluation_id}")
    decision = state.get("decision")
    if decision is not None and (
        not isinstance(decision, dict)
        or set(decision) != {"code", "summary"}
        or not isinstance(decision.get("code"), str)
        or not _ID.fullmatch(decision["code"])
        or not isinstance(decision.get("summary"), str)
        or not decision["summary"].strip()
    ):
        raise EvaluationError(f"State decision is malformed for {evaluation_id}")
    items = state.get("items")
    if items is not None:
        if not isinstance(items, list):
            raise EvaluationError(f"State items are malformed for {evaluation_id}")
        item_ids: set[str] = set()
        for item in items:
            if not isinstance(item, dict):
                raise EvaluationError(f"State items are malformed for {evaluation_id}")
            item_id = item.get("id")
            item_gold = item.get("gold")
            if (
                not isinstance(item_id, str)
                or not item_id
                or item_id in item_ids
                or item.get("status") not in STATUSES
                or not isinstance(item_gold, dict)
            ):
                raise EvaluationError(f"State items are malformed for {evaluation_id}")
            item_ids.add(item_id)
            item_reviewed = item_gold.get("reviewed")
            item_total = item_gold.get("total")
            if (
                item_gold.get("status") not in GOLD_STATUSES
                or isinstance(item_reviewed, bool)
                or not isinstance(item_reviewed, int)
                or isinstance(item_total, bool)
                or not isinstance(item_total, int)
                or item_reviewed < 0
                or item_total < item_reviewed
                or not isinstance(item_gold.get("unit"), str)
                or not item_gold["unit"]
            ):
                raise EvaluationError(
                    f"State item gold is malformed for {evaluation_id}"
                )
            item_blocker = item.get("blocked_reason")
            if (item["status"] == "blocked") != (
                isinstance(item_blocker, str) and bool(item_blocker.strip())
            ):
                raise EvaluationError(
                    f"State item blocker is malformed for {evaluation_id}"
                )
            item_decision = item.get("decision")
            if item_decision is not None and (
                not isinstance(item_decision, dict)
                or set(item_decision) != {"code", "summary"}
                or not isinstance(item_decision.get("code"), str)
                or not _ID.fullmatch(item_decision["code"])
                or not isinstance(item_decision.get("summary"), str)
                or not item_decision["summary"].strip()
            ):
                raise EvaluationError(
                    f"State item decision is malformed for {evaluation_id}"
                )
    return state


def public_state(entry: dict, repository_roots: dict[str, Path]) -> dict:
    provider_id = entry["evidence"]["provider_id"]
    provider = next(
        artifact
        for artifact in entry.get("artifacts") or []
        if artifact.get("id") == provider_id
    )
    if provider.get("visibility") != "public":
        raise EvaluationError(f"State provider is not public for {entry['id']}")
    root = repository_roots.get(provider.get("repository"))
    if root is None:
        raise EvaluationError(f"State repository is unavailable for {entry['id']}")
    state = _json_mapping(root / provider["path"])
    public_artifacts = {
        artifact["id"]: repository_roots[artifact["repository"]] / artifact["path"]
        for artifact in entry.get("artifacts") or []
        if artifact.get("visibility") == "public"
        and artifact.get("repository") in repository_roots
    }
    return validate_state(entry, state, public_artifacts)


def digest_corpus_detail(entry: dict, digester_root: Path) -> dict:
    if entry.get("evidence") != {
        "provider_id": "digest-evaluation-corpus-state",
        "detail_capability": "digest-evaluation-corpus-detail",
    }:
        raise EvaluationError("Digest evaluation adapter is not allowlisted")
    provider = next(
        (
            item
            for item in entry.get("artifacts") or []
            if item.get("id") == "digest-evaluation-corpus-state"
        ),
        None,
    )
    if provider != {
        "id": "digest-evaluation-corpus-state",
        "role": "state",
        "visibility": "private",
    }:
        raise EvaluationError("Digest evaluation provider is not registered safely")
    script = digester_root / "workspace" / "benchmarks" / "evaluation_corpus.py"
    try:
        process = subprocess.run(
            ["python", "workspace/benchmarks/evaluation_corpus.py", "--state-only"],
            cwd=digester_root,
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        )
        state = json.loads(process.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        raise EvaluationError("Digest evaluation state is unavailable") from exc
    if not script.is_file() or not isinstance(state, dict):
        raise EvaluationError("Digest evaluation state is unavailable")
    return {"state": validate_state(entry, state), "items": state.get("items", [])}


def account_state(entry: dict, manifest_path: Path, views: list[dict]) -> dict:
    """Derive report-only account-review readiness from validated local inputs."""
    if entry.get("evidence") != {
        "provider_id": "account-chronology-state",
        "detail_capability": "account-chronology-review",
    }:
        raise EvaluationError("Account chronology adapter is not allowlisted")
    provider = next(
        (
            item
            for item in entry.get("artifacts") or []
            if item.get("id") == "account-chronology-state"
        ),
        None,
    )
    if provider != {
        "id": "account-chronology-state",
        "role": "state",
        "visibility": "private",
    }:
        raise EvaluationError("Account chronology provider is not registered safely")
    manifest = _mapping(manifest_path)
    evidence = [
        {
            "artifact_id": "account-chronology-manifest",
            "sha256": f"sha256:{hashlib.sha256(manifest_path.read_bytes()).hexdigest()}",
        }
    ]
    total = sum(len(view.get("claims") or []) for view in views)
    reviewed = 0
    all_reviewed = bool(views)
    records = manifest.get("records") or []
    if len(records) != len(views):
        raise EvaluationError("Account chronology manifest and review views disagree")
    for configured, view in zip(records, views, strict=True):
        digest_binding = configured.get("claim_digest") or {}
        digest_path = (
            manifest_path.parent / str(digest_binding.get("path", ""))
        ).resolve()
        if not digest_path.is_file():
            raise EvaluationError("Account chronology digest evidence is unavailable")
        record_id = str(configured.get("record_content_hash", "")).removeprefix(
            "sha256:"
        )
        evidence.append(
            {
                "artifact_id": f"account-chronology:{record_id}:digest",
                "sha256": f"sha256:{hashlib.sha256(digest_path.read_bytes()).hexdigest()}",
            }
        )
        if view.get("gold") is None:
            all_reviewed = False
            continue
        gold_path = (
            manifest_path.parent
            / str((configured.get("authenticated_gold") or {}).get("path", ""))
        ).resolve()
        if not gold_path.is_file():
            raise EvaluationError("Account chronology gold evidence is unavailable")
        evidence.append(
            {
                "artifact_id": f"account-chronology:{record_id}:gold",
                "sha256": f"sha256:{hashlib.sha256(gold_path.read_bytes()).hexdigest()}",
            }
        )
        reviewed += len(view.get("claims") or [])
    canonical = json.dumps(
        evidence, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode()
    state = {
        "schema": STATE_SCHEMA,
        "evaluation_id": ACCOUNT_ID,
        "evidence": evidence,
        "evidence_sha256": f"sha256:{hashlib.sha256(canonical).hexdigest()}",
        "status": "reviewed" if all_reviewed else "ready-for-human-review",
        "gold": {
            "status": "human-reviewed" if all_reviewed else "ready-for-human-review",
            "reviewed": reviewed,
            "total": total,
            "unit": "claims",
        },
        "decision": {
            "code": "retain-report-only" if all_reviewed else "await-account-review",
            "summary": (
                "Retain the account chronology evaluation as report-only gold."
                if all_reviewed
                else "Await authenticated account-boundary and chronology review."
            ),
        },
    }
    return validate_state(entry, state)


def registry_entry(registry: dict, evaluation_id: str) -> dict:
    for entry in registry["evaluations"]:
        if entry["id"] == evaluation_id:
            return entry
    raise EvaluationNotFound("No such evaluation")


def index_entry(entry: dict, state: dict | None, sync_error: str | None = None) -> dict:
    """Public-safe descriptor plus aggregate state; private item detail is omitted."""
    row = {
        key: entry[key] for key in ("id", "title", "purpose", "owner_repo", "limits")
    }
    row["detail_capability"] = entry["evidence"]["detail_capability"]
    row["detail_available"] = sync_error is None
    if state is not None:
        row["state"] = {
            key: value for key, value in state.items() if key not in {"items"}
        }
    else:
        row["sync_error"] = sync_error or "Current evaluation state is unavailable"
    return row


def require_private_artifact(entry: dict, artifact_id: str) -> None:
    artifact = next(
        (
            item
            for item in entry.get("artifacts") or []
            if item.get("id") == artifact_id
        ),
        None,
    )
    if artifact != {"id": artifact_id, "role": "gold", "visibility": "private"}:
        raise EvaluationError("Private evaluation artifact is not registered safely")


def _require_ingester_adapter(
    entry: dict,
    provider_id: str,
    capability: str,
    result_id: str,
    reference_id: str,
) -> None:
    if entry.get("evidence") != {
        "provider_id": provider_id,
        "detail_capability": capability,
    }:
        raise EvaluationError("Ingester evaluation adapter is not allowlisted")
    artifact = next(
        (
            item
            for item in entry.get("artifacts") or []
            if item.get("id") == provider_id
        ),
        None,
    )
    if artifact != {"id": provider_id, "role": "state", "visibility": "private"}:
        raise EvaluationError(
            "Private evaluation state provider is not registered safely"
        )
    result = next(
        (item for item in entry.get("artifacts") or [] if item.get("id") == result_id),
        None,
    )
    if result != {"id": result_id, "role": "result", "visibility": "private"}:
        raise EvaluationError("Private evaluation result is not registered safely")
    reference = next(
        (
            item
            for item in entry.get("artifacts") or []
            if item.get("id") == reference_id
        ),
        None,
    )
    if reference != {
        "id": reference_id,
        "role": "gold",
        "visibility": "private",
    }:
        raise EvaluationError("Private evaluation reference is not registered safely")


def _evidence_state(
    evaluation_id: str,
    evidence_paths: list[tuple[str, Path]],
    status: str,
    gold: dict,
    decision: dict,
) -> dict:
    evidence = []
    for artifact_id, path in evidence_paths:
        if not path.is_file():
            raise EvaluationError(
                f"Current evidence is unavailable for {evaluation_id}"
            )
        evidence.append(
            {
                "artifact_id": artifact_id,
                "sha256": f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}",
            }
        )
    canonical = json.dumps(
        evidence,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    return {
        "schema": STATE_SCHEMA,
        "evaluation_id": evaluation_id,
        "evidence": evidence,
        "evidence_sha256": f"sha256:{hashlib.sha256(canonical).hexdigest()}",
        "status": status,
        "gold": gold,
        "decision": decision,
    }


def _metric_set(value: object) -> dict:
    if not isinstance(value, dict):
        raise EvaluationError("Evaluation metrics are malformed")
    required = {
        "matched_words",
        "wrong_words",
        "word_error_pct",
        "turns",
        "wrong_turns",
        "turn_error_pct",
        "labels",
    }
    if not required.issubset(value) or any(
        isinstance(value[key], bool) or not isinstance(value[key], (int, float))
        for key in required
    ):
        raise EvaluationError("Evaluation metrics are malformed")
    return {key: value[key] for key in required}


def audio_exclusive_detail(
    entry: dict,
    reviewed_attribution_path: Path,
    reviewed_record_paths: dict[str, Path],
    report_path: Path,
    detail_path: Path,
) -> dict:
    """Sanitise private Community-1 evidence for the admin adapter."""
    _require_ingester_adapter(
        entry,
        "audio-community1-exclusive-state",
        "audio-community1-exclusive-detail",
        "audio-community1-exclusive-result",
        "audio-community1-exclusive-reviewed-attribution",
    )
    report = _json_mapping(report_path)
    attribution = _json_mapping(reviewed_attribution_path)
    descriptor = _json_mapping(detail_path)
    if (
        descriptor.get("schema") != "anomalica/audio-community1-exclusive-detail/1"
        or descriptor.get("evaluation_id") != AUDIO_EXCLUSIVE_ID
    ):
        raise EvaluationError("Unsupported audio evaluation detail")
    if (
        attribution.get("schema")
        != "anomalica/audio-community1-exclusive-reviewed-attribution/1"
        or attribution.get("evaluation_id") != AUDIO_EXCLUSIVE_ID
        or not isinstance(attribution.get("records"), list)
    ):
        raise EvaluationError("Unsupported audio reviewed attribution")
    records = report.get("records")
    aggregate = report.get("aggregate")
    if not isinstance(records, dict) or not records or not isinstance(aggregate, dict):
        raise EvaluationError("Audio evaluation result is malformed")

    expected_references = {}
    for reference in attribution["records"]:
        if (
            not isinstance(reference, dict)
            or not isinstance(reference.get("record_id"), str)
            or not isinstance(reference.get("sha256"), str)
        ):
            raise EvaluationError("Audio reviewed attribution is malformed")
        expected_references[reference["record_id"]] = reference["sha256"]
    if (
        len(expected_references) != len(attribution["records"])
        or set(expected_references) != set(records)
        or set(reviewed_record_paths) != set(records)
    ):
        raise EvaluationError("Audio reviewed attribution does not cover its records")
    for record_id, expected_sha in expected_references.items():
        reviewed_path = reviewed_record_paths[record_id]
        if not reviewed_path.is_file():
            raise EvaluationError("Current audio reviewed attribution is unavailable")
        actual_sha = hashlib.sha256(reviewed_path.read_bytes()).hexdigest()
        if (
            actual_sha != expected_sha
            or records[record_id].get("reviewed_ingest_sha256") != expected_sha
        ):
            raise EvaluationError("Audio reviewed attribution is out of sync")

    safe_records = []
    totals = {
        strategy: {
            key: 0
            for key in (
                "matched_words",
                "wrong_words",
                "turns",
                "wrong_turns",
                "labels",
            )
        }
        for strategy in ("regular", "exclusive")
    }
    for record_id, result in records.items():
        if (
            not isinstance(record_id, str)
            or len(record_id) != 64
            or not set(record_id) <= set("0123456789abcdef")
            or not isinstance(result, dict)
        ):
            raise EvaluationError("Audio evaluation record is malformed")
        safe = {strategy: _metric_set(result.get(strategy)) for strategy in totals}
        for strategy in totals:
            for key in totals[strategy]:
                totals[strategy][key] += safe[strategy][key]
        safe_records.append({"record_id": record_id, **safe})

    safe_aggregate = {
        strategy: _metric_set(aggregate.get(strategy)) for strategy in totals
    }
    for strategy in totals:
        if any(
            safe_aggregate[strategy][key] != value
            for key, value in totals[strategy].items()
        ):
            raise EvaluationError("Audio aggregate does not match its records")
    adopt = (
        safe_aggregate["exclusive"]["wrong_words"]
        < safe_aggregate["regular"]["wrong_words"]
        and safe_aggregate["exclusive"]["wrong_turns"]
        <= safe_aggregate["regular"]["wrong_turns"]
    )
    if aggregate.get("adopt_exclusive") is not adopt:
        raise EvaluationError("Audio adoption result does not match its metrics")
    expected_decision = (
        {
            "code": "adopt-exclusive",
            "summary": "Adopt Community-1 exclusive tracks for speaker attribution.",
        }
        if adopt
        else {
            "code": "retain-regular",
            "summary": "Retain regular Community-1 tracks for speaker attribution.",
        }
    )
    if aggregate.get("production_decision") != expected_decision:
        raise EvaluationError("Audio owner decision does not match its metrics")
    notes = {key: descriptor.get(key) for key in ("comparison_note", "production_note")}
    if any(not isinstance(value, str) or not value.strip() for value in notes.values()):
        raise EvaluationError("Audio evaluation explanation is malformed")

    state = _evidence_state(
        AUDIO_EXCLUSIVE_ID,
        [
            (
                "audio-community1-exclusive-reviewed-attribution",
                reviewed_attribution_path,
            ),
            ("audio-community1-exclusive-result", report_path),
        ],
        "adopted" if adopt else "rejected",
        {
            "status": "source-reviewed",
            "reviewed": len(safe_records),
            "total": len(safe_records),
            "unit": "records",
        },
        expected_decision,
    )
    return {
        "state": state,
        "comparison_note": notes["comparison_note"],
        "production_note": notes["production_note"],
        "aggregate": safe_aggregate,
        "records": safe_records,
    }


def pdf_native_detail(
    entry: dict, reviewed_path: Path, report_path: Path, detail_path: Path
) -> dict:
    """Sanitise private native-PDF evidence and public-domain examples."""
    _require_ingester_adapter(
        entry,
        "pdf-native-text-extraction-state",
        "pdf-native-text-extraction-detail",
        "pdf-native-text-extraction-result",
        "pdf-native-text-extraction-reviewed-reference",
    )
    report = _json_mapping(report_path)
    descriptor = _json_mapping(detail_path)
    if (
        descriptor.get("schema") != "anomalica/pdf-native-text-extraction-detail/1"
        or descriptor.get("evaluation_id") != PDF_NATIVE_ID
        or descriptor.get("rights") != "public-domain"
    ):
        raise EvaluationError("Unsupported PDF evaluation detail")
    page_count = report.get("page_count")
    pages = report.get("pages")
    aggregate = report.get("aggregate")
    if (
        not isinstance(page_count, int)
        or page_count < 1
        or not isinstance(pages, list)
        or len(pages) != page_count
        or not isinstance(aggregate, dict)
        or report.get("method") != "pymupdf-native-text-geometric-sort"
    ):
        raise EvaluationError("PDF evaluation result is malformed")
    by_page = {}
    metric_keys = {
        "reference_words",
        "candidate_words",
        "word_errors",
        "word_error_pct",
        "word_precision_pct",
        "word_recall_pct",
    }
    for page in pages:
        if (
            not isinstance(page, dict)
            or not isinstance(page.get("file_page"), int)
            or any(not isinstance(page.get(key), (int, float)) for key in metric_keys)
        ):
            raise EvaluationError("PDF page metrics are malformed")
        by_page[page["file_page"]] = {key: page[key] for key in metric_keys}
    if set(by_page) != set(range(1, page_count + 1)):
        raise EvaluationError("PDF page metrics do not cover the source")
    if not reviewed_path.is_file():
        raise EvaluationError("Current PDF reviewed reference is unavailable")
    reviewed_sha = hashlib.sha256(reviewed_path.read_bytes()).hexdigest()
    if (report.get("inputs") or {}).get("reviewed_ingest_sha256") != reviewed_sha:
        raise EvaluationError("PDF reviewed reference is out of sync")

    aggregate_keys = {
        "candidate_words",
        "pages_with_candidate_text",
        "reference_words",
        "word_error_pct",
        "word_errors",
        "word_precision_pct",
        "word_recall_pct",
    }
    if not aggregate_keys.issubset(aggregate) or any(
        isinstance(aggregate[key], bool) or not isinstance(aggregate[key], (int, float))
        for key in aggregate_keys
    ):
        raise EvaluationError("PDF aggregate metrics are malformed")
    safe_aggregate = {key: aggregate[key] for key in aggregate_keys}

    owner_decision = report.get("production_decision")
    if not isinstance(owner_decision, dict):
        raise EvaluationError("PDF owner decision is unavailable")
    if (
        owner_decision.get("role") != "supplement"
        or owner_decision.get("replace_ai_transcription") is not False
        or owner_decision.get("code") != "supplement-only"
        or not isinstance(owner_decision.get("summary"), str)
        or not owner_decision["summary"].strip()
    ):
        raise EvaluationError("PDF owner decision is malformed")
    decision = {
        "code": owner_decision["code"],
        "summary": owner_decision["summary"],
    }

    examples = descriptor.get("examples")
    if not isinstance(examples, list) or not examples:
        raise EvaluationError("PDF evaluation examples are unavailable")
    safe_examples = []
    for example in examples:
        if (
            not isinstance(example, dict)
            or example.get("kind") not in {"normal-page", "two-column-failure"}
            or not isinstance(example.get("file_page"), int)
            or example["file_page"] not in by_page
            or not isinstance(example.get("native"), str)
            or not isinstance(example.get("reviewed"), str)
        ):
            raise EvaluationError("PDF evaluation example is malformed")
        safe_examples.append(
            {
                "kind": example["kind"],
                "file_page": example["file_page"],
                "native": example["native"],
                "reviewed": example["reviewed"],
                "metrics": by_page[example["file_page"]],
            }
        )
    production_note = descriptor.get("production_note")
    if not isinstance(production_note, str) or not production_note.strip():
        raise EvaluationError("PDF production note is malformed")

    state = _evidence_state(
        PDF_NATIVE_ID,
        [
            ("pdf-native-text-extraction-reviewed-reference", reviewed_path),
            ("pdf-native-text-extraction-result", report_path),
        ],
        "reviewed",
        {
            "status": "source-reviewed",
            "reviewed": page_count,
            "total": page_count,
            "unit": "pages",
        },
        decision,
    )
    return {
        "state": state,
        "method": "pymupdf-native-text-geometric-sort",
        "aggregate": safe_aggregate,
        "examples": safe_examples,
        "production_note": production_note,
    }


def _file_sha(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def _read_judgements(path: Path, fixture_sha: str, query_ids: set[str]) -> dict | None:
    if not path.is_file():
        return None
    doc = _json_mapping(path)
    if (
        doc.get("schema") != JUDGEMENT_SCHEMA
        or doc.get("fixture_sha256") != fixture_sha
        or not isinstance(doc.get("judgements"), dict)
        or not set(doc["judgements"]).issubset(query_ids)
    ):
        raise EvaluationError("Stored search judgements do not match the fixture")
    return doc


def search_detail(
    registry_path: Path,
    fixture_path: Path,
    minilm_path: Path,
    granite_path: Path,
    comparison_path: Path,
    judgement_path: Path,
) -> dict:
    registry = load_registry(registry_path)
    entry = registry_entry(registry, SEARCH_ID)
    require_private_artifact(entry, SEARCH_JUDGEMENT_ARTIFACT)
    fixture = _json_mapping(fixture_path)
    minilm = _json_mapping(minilm_path)
    granite = _json_mapping(granite_path)
    comparison = _json_mapping(comparison_path)
    fixture_sha = hashlib.sha256(fixture_path.read_bytes()).hexdigest()
    if fixture.get("schema") != "anomalica/search-reranker-benchmark/1":
        raise EvaluationError("Unsupported search fixture")
    if any(
        result.get("schema") != "anomalica/search-reranker-controlled-result/1"
        or (result.get("fixture") or {}).get("sha256") != fixture_sha
        for result in (minilm, granite)
    ) or (
        comparison.get("schema") != "anomalica/search-reranker-comparison/1"
        or comparison.get("fixture_sha256") != fixture_sha
    ):
        raise EvaluationError("Search results do not match the registered fixture")
    for name, result in (("minilm", minilm), ("granite", granite)):
        model = result.get("model") or {}
        expected_repo, expected_revision = EXPECTED_MODELS[name]
        if (
            model.get("repo") != expected_repo
            or model.get("revision") != expected_revision
        ):
            raise EvaluationError(
                f"Configured {name} result has the wrong model identity"
            )

    fixture_queries = {query["id"]: query for query in fixture.get("queries") or []}
    model_queries = {
        "minilm": {query["id"]: query for query in minilm.get("queries") or []},
        "granite": {query["id"]: query for query in granite.get("queries") or []},
    }
    query_ids = set(fixture_queries)
    judgements = _read_judgements(judgement_path, fixture_sha, query_ids)

    queries = []
    for query_id, query in fixture_queries.items():
        candidates = {
            candidate["claim_id"]: candidate
            for candidate in query.get("candidates") or []
        }
        rankings = {}
        for model, by_id in model_queries.items():
            ranked = []
            for result in (by_id.get(query_id) or {}).get("top_10") or []:
                candidate = candidates.get(result.get("claim_id"))
                if not candidate:
                    raise EvaluationError("Search result contains an unknown claim")
                ranked.append(
                    {
                        "rank": result.get("rank"),
                        "claim_id": result.get("claim_id"),
                        "text": candidate.get("text"),
                        "relevance": candidate.get("relevance"),
                    }
                )
            rankings[model] = ranked
        queries.append(
            {
                "id": query_id,
                "query": query.get("query"),
                "target": query.get("target"),
                "total_graph_relevant": query.get("total_graph_relevant"),
                "rankings": rankings,
            }
        )

    return {
        "evaluation": entry,
        "fixture": {
            "sha256": fixture_sha,
            "license": fixture.get("license"),
            "source": fixture.get("source"),
        },
        "models": {
            "minilm": {
                "name": "MiniLM",
                "quality": minilm.get("quality"),
                "performance": {
                    "query_latency_median_ms": (minilm.get("performance") or {}).get(
                        "query_latency_median_ms"
                    ),
                    "cuda_peak_allocated_mib": (minilm.get("performance") or {}).get(
                        "cuda_peak_allocated_mib"
                    ),
                },
            },
            "granite": {
                "name": "Granite English R2",
                "quality": granite.get("quality"),
                "performance": {
                    "query_latency_median_ms": (granite.get("performance") or {}).get(
                        "query_latency_median_ms"
                    ),
                    "cuda_peak_allocated_mib": (granite.get("performance") or {}).get(
                        "cuda_peak_allocated_mib"
                    ),
                },
            },
        },
        "comparison": {
            "quality_delta_granite_minus_minilm": comparison.get(
                "quality_delta_granite_minus_minilm"
            ),
            "resource_ratios_granite_over_minilm": comparison.get(
                "resource_ratios_granite_over_minilm"
            ),
            "criteria": comparison.get("criteria"),
            "replace_minilm": comparison.get("replace_minilm"),
        },
        "queries": queries,
        "judgements": (judgements or {}).get("judgements", {}),
        "judgement_provenance": (
            {
                "reviewer": (judgements or {}).get("reviewer"),
                "updated_at": (judgements or {}).get("updated_at"),
            }
            if judgements
            else None
        ),
        "judgements_sha256": _file_sha(judgement_path),
    }


@contextmanager
def _write_lock(path: Path):
    identity = hashlib.sha256(str(path.resolve()).encode()).hexdigest()
    lock_path = Path(tempfile.gettempdir()) / f"anomalica-evaluation-{identity}.lock"
    with _WRITE_LOCK, lock_path.open("a+") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def save_search_judgements(
    path: Path,
    fixture_path: Path,
    body: dict,
    reviewer: dict,
) -> None:
    fixture = _json_mapping(fixture_path)
    fixture_sha = hashlib.sha256(fixture_path.read_bytes()).hexdigest()
    if body.get("fixture_sha256") != fixture_sha:
        raise EvaluationError("Search fixture changed; reload")
    query_ids = {query.get("id") for query in fixture.get("queries") or []}
    raw = body.get("judgements")
    if not isinstance(raw, dict) or not set(raw).issubset(query_ids):
        raise EvaluationError("Search judgements contain an unknown query")
    clean = {}
    for query_id, value in raw.items():
        if not isinstance(value, dict) or value.get("decision") not in JUDGEMENTS:
            raise EvaluationError(f"Search judgement for {query_id} is invalid")
        note = value.get("note", "")
        if not isinstance(note, str) or len(note) > 2000:
            raise EvaluationError(f"Search judgement note for {query_id} is invalid")
        clean[query_id] = {"decision": value["decision"], "note": note.strip()}

    with _write_lock(path):
        if body.get("base_sha256") != _file_sha(path):
            raise EvaluationError("Stored search judgements changed; reload")
        payload = {
            "schema": JUDGEMENT_SCHEMA,
            "fixture_sha256": fixture_sha,
            "reviewer": {
                "issuer": "github",
                "subject": str(reviewer.get("id") or reviewer.get("login") or ""),
                "name": reviewer.get("name") or reviewer.get("login") or "",
            },
            "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "judgements": clean,
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(
                "w", dir=path.parent, prefix=f".{path.name}.", delete=False
            ) as output:
                temporary = Path(output.name)
                json.dump(payload, output, indent=2)
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
