"""Admin-only adapters for the central evaluation registry."""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
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


SCHEMA = "anomalica/evaluation-registry/1"
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
        registry.get("statuses") != STATUSES
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
        if not isinstance(evaluation_id, str) or evaluation_id in evaluation_ids:
            raise EvaluationError("Evaluation registry IDs are missing or duplicated")
        evaluation_ids.add(evaluation_id)
        if entry.get("status") not in STATUSES:
            raise EvaluationError(f"Evaluation {evaluation_id} has an invalid status")
        gold = entry.get("gold")
        limits = entry.get("limits")
        if not isinstance(gold, dict) or gold.get("status") not in GOLD_STATUSES:
            raise EvaluationError(
                f"Evaluation {evaluation_id} has invalid gold provenance"
            )
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
    return registry


def registry_entry(registry: dict, evaluation_id: str) -> dict:
    for entry in registry["evaluations"]:
        if entry["id"] == evaluation_id:
            return entry
    raise EvaluationNotFound("No such evaluation")


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
