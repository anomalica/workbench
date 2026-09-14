"""Report-only account chronology gold backed by the digester evaluator."""

from __future__ import annotations

import hashlib
import importlib.util
import fcntl
import os
import sys
import tempfile
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

import yaml


class AccountChronologyError(ValueError):
    """The manifest, digest, or submitted review is unsafe or invalid."""


class AccountChronologyNotConfigured(AccountChronologyError):
    """The manifest has no review entry for this record."""


_WRITE_LOCK = threading.Lock()


@contextmanager
def _cross_process_write_lock(manifest_path: Path, full_hash: str):
    identity = hashlib.sha256(
        f"{manifest_path.resolve()}:{full_hash}".encode()
    ).hexdigest()
    lock_path = (
        Path(tempfile.gettempdir()) / f"anomalica-account-chronology-{identity}.lock"
    )
    with lock_path.open("a+") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def _mapping(path: Path) -> dict:
    try:
        value = yaml.safe_load(path.read_text())
    except (OSError, ValueError, yaml.YAMLError) as exc:
        raise AccountChronologyError(f"Cannot read {path}") from exc
    if not isinstance(value, dict):
        raise AccountChronologyError(f"{path} is not a mapping")
    return value


def _evaluator(manifest_path: Path):
    module_path = manifest_path.with_name("account_chronology_eval.py")
    workspace = manifest_path.parent.parent
    if not module_path.is_file():
        raise AccountChronologyError("Account chronology evaluator is unavailable")
    workspace_text = str(workspace)
    if workspace_text not in sys.path:
        sys.path.insert(0, workspace_text)
    spec = importlib.util.spec_from_file_location(
        "_workbench_account_chronology_eval", module_path
    )
    if spec is None or spec.loader is None:
        raise AccountChronologyError("Account chronology evaluator cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _confined_path(base: Path, raw: object, root: Path, field: str) -> Path:
    if not isinstance(raw, str) or not raw or Path(raw).is_absolute():
        raise AccountChronologyError(f"{field} must be a relative path")
    allowed = (base / root).resolve()
    resolved = (base / raw).resolve()
    if not resolved.is_relative_to(allowed):
        raise AccountChronologyError(f"{field} escapes {root}")
    return resolved


def _entry(manifest: dict, full_hash: str) -> dict:
    wanted = f"sha256:{full_hash}"
    for entry in manifest.get("records") or []:
        if isinstance(entry, dict) and entry.get("record_content_hash") == wanted:
            return entry
    raise AccountChronologyNotConfigured(
        "No account chronology review is configured for this record"
    )


def _paths_and_claims(manifest_path: Path, full_hash: str):
    manifest_path = manifest_path.resolve()
    manifest = _mapping(manifest_path)
    if manifest.get("schema") != "anomalica/account-chronology-evaluation-manifest/1":
        raise AccountChronologyError("Unsupported account chronology manifest")
    if manifest.get("canonical_activation") != "forbidden":
        raise AccountChronologyError("Account chronology must remain report-only")
    if (manifest.get("gold_contract") or {}).get("schema") != (
        "anomalica/account-chronology-evaluation/1"
    ):
        raise AccountChronologyError("Unsupported account chronology gold contract")

    evaluator = _evaluator(manifest_path)
    try:
        evaluator.audit_manifest(manifest_path)
    except evaluator.EvaluationError as exc:
        raise AccountChronologyError(str(exc)) from exc

    entry = _entry(manifest, full_hash)
    digest_binding = entry.get("claim_digest")
    gold_binding = entry.get("authenticated_gold")
    prediction_binding = entry.get("scoreable_prediction")
    if not all(
        isinstance(value, dict)
        for value in (digest_binding, gold_binding, prediction_binding)
    ):
        raise AccountChronologyError("Account chronology paths are not settled")

    digest_path = _confined_path(
        manifest_path.parent,
        digest_binding.get("path"),
        Path("../../../digests"),
        "claim_digest.path",
    )
    gold_path = _confined_path(
        manifest_path.parent,
        gold_binding.get("path"),
        Path("private"),
        "authenticated_gold.path",
    )
    digest = _mapping(digest_path)
    digest_sha = hashlib.sha256(digest_path.read_bytes()).hexdigest()
    record_hash = f"sha256:{full_hash}"
    pre_digest_sha = (digest.get("pre_digest") or {}).get("sha256")
    expected = {
        "record_content_hash": record_hash,
        "pre_digest_sha256": pre_digest_sha,
        "digest_sha256": digest_sha,
    }
    if (digest.get("record") or {}).get("content_hash") != record_hash:
        raise AccountChronologyError("Configured digest targets a different record")
    if digest_binding.get("coordinate_system") != "media_time_ms":
        raise AccountChronologyError("Manifest coordinate_system is not media_time_ms")
    for name, value in expected.items():
        if (
            digest_binding.get(name) != value
            or gold_binding.get(name) != value
            or prediction_binding.get(name) != value
        ):
            raise AccountChronologyError(f"Manifest {name} does not match the digest")

    try:
        materialised = evaluator.materialise_claims_from_digest(digest_path)
    except evaluator.EvaluationError as exc:
        raise AccountChronologyError(str(exc)) from exc
    display_claims = []
    index = 0
    for section in ("domain_claims", "infrastructure_claims"):
        for claim in digest.get(section) or []:
            exact = materialised[index]
            display_claims.append(
                {
                    **exact,
                    "section": section,
                    "location": claim.get("location"),
                    "text": claim.get("text", ""),
                    "quote": claim.get("quote", ""),
                }
            )
            index += 1
    return (
        manifest,
        entry,
        evaluator,
        gold_path,
        expected,
        materialised,
        display_claims,
        prediction_binding,
    )


def _legacy_suggestions(manifest_path: Path, entry: dict) -> list[dict]:
    raw = entry.get("legacy_gold_path")
    if not isinstance(raw, str):
        return []
    path = _confined_path(
        manifest_path.parent,
        raw,
        Path("../../reports/accounts"),
        "legacy_gold_path",
    )
    return [
        {
            key: item.get(key)
            for key in (
                "title",
                "subject",
                "summary",
                "nested_within",
                "approx_when",
                "approx_where",
                "approx_line_start",
                "approx_line_end",
            )
            if item.get(key) not in (None, "")
        }
        for item in (_mapping(path).get("accounts") or [])
        if isinstance(item, dict)
    ]


def _gold_sha(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def load_review(manifest_path: Path, full_hash: str) -> dict:
    (
        manifest,
        entry,
        evaluator,
        gold_path,
        expected,
        _materialised,
        claims,
        prediction,
    ) = _paths_and_claims(manifest_path, full_hash)
    gold = None
    if gold_path.is_file():
        gold = _mapping(gold_path)
        if (
            any(gold.get(name) != value for name, value in expected.items())
            or gold.get("coordinate_system") != "media_time_ms"
            or gold.get("claims") != _materialised
        ):
            raise AccountChronologyError(
                "Stored gold does not match its manifest binding"
            )
        try:
            evaluator.validate_document(gold, gold=True)
        except evaluator.EvaluationError as exc:
            raise AccountChronologyError(f"Stored gold is invalid: {exc}") from exc
    return {
        "schema": "anomalica/account-chronology-review-view/1",
        "report_only": True,
        "canonical_activation": manifest.get("canonical_activation"),
        "record_name": entry.get("name"),
        "record_status": entry.get("status"),
        "record_content_hash": expected["record_content_hash"],
        "pre_digest_sha256": expected["pre_digest_sha256"],
        "digest_sha256": expected["digest_sha256"],
        "coordinate_system": (entry.get("claim_digest") or {}).get("coordinate_system"),
        "prediction": {
            "status": prediction.get("status"),
            "reason": prediction.get("reason"),
        },
        "claims": claims,
        "suggestions": _legacy_suggestions(manifest_path.resolve(), entry),
        "gold": gold,
        "gold_sha256": _gold_sha(gold_path),
    }


def _normalise_accounts(raw: object) -> list[dict]:
    if not isinstance(raw, list):
        raise AccountChronologyError("accounts must be a list")
    accounts = []
    for item in raw:
        if not isinstance(item, dict):
            raise AccountChronologyError("account is not a mapping")
        if not isinstance(item.get("id"), str) or not item["id"]:
            raise AccountChronologyError("every account needs an id")
        if item.get("title") is not None and not isinstance(item["title"], str):
            raise AccountChronologyError("account title must be text")
        account = {"id": item.get("id"), "spans": item.get("spans")}
        if item.get("title"):
            account["title"] = item["title"]
        if item.get("parent_account_id"):
            account["parent_account_id"] = item["parent_account_id"]
        accounts.append(account)
    return accounts


def _assign_claims(accounts: list[dict], claims: list[dict]) -> list[dict]:
    assignments = []
    for claim in claims:
        position = claim["position"]
        if position is None:
            assignments.append(
                {
                    "claim_id": claim["id"],
                    "account_id": None,
                    "status": "unlocatable",
                }
            )
            continue
        containing = []
        for account in accounts:
            spans = account.get("spans")
            if not isinstance(spans, list):
                continue
            if any(
                isinstance(span, dict)
                and isinstance(span.get("start"), int)
                and isinstance(span.get("end"), int)
                and span["start"] <= position < span["end"]
                for span in spans
            ):
                width = sum(
                    span["end"] - span["start"]
                    for span in spans
                    if isinstance(span, dict)
                    and isinstance(span.get("start"), int)
                    and isinstance(span.get("end"), int)
                )
                containing.append((width, account.get("id")))
        if containing:
            _width, account_id = min(containing)
            assignments.append(
                {"claim_id": claim["id"], "account_id": account_id, "status": "bound"}
            )
        else:
            assignments.append(
                {"claim_id": claim["id"], "account_id": None, "status": "outside"}
            )
    return assignments


def save_review(
    manifest_path: Path, full_hash: str, body: dict, reviewer_email: str
) -> dict:
    with _WRITE_LOCK, _cross_process_write_lock(manifest_path, full_hash):
        (
            _manifest,
            _entry_data,
            evaluator,
            gold_path,
            expected,
            claims,
            _display_claims,
            _prediction,
        ) = _paths_and_claims(manifest_path, full_hash)
        if body.get("base_gold_sha256") != _gold_sha(gold_path):
            raise AccountChronologyError(
                "Stored account chronology gold changed; reload"
            )
        accounts = _normalise_accounts(body.get("accounts"))
        gold = {
            "schema": "anomalica/account-chronology-evaluation/1",
            **expected,
            "coordinate_system": "media_time_ms",
            "reviewed_by": reviewer_email,
            "reviewed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "accounts": accounts,
            "claims": claims,
            "claim_assignments": _assign_claims(accounts, claims),
            "before_pairs": body.get("before_pairs", []),
            "unknown_pairs": body.get("unknown_pairs", []),
            "simultaneous_pairs": body.get("simultaneous_pairs", []),
        }
        try:
            evaluator.validate_document(gold, gold=True)
        except evaluator.EvaluationError as exc:
            raise AccountChronologyError(str(exc)) from exc

        payload = yaml.safe_dump(gold, sort_keys=False, allow_unicode=True)
        gold_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(
                "w", dir=gold_path.parent, prefix=f".{gold_path.name}.", delete=False
            ) as output:
                temporary = Path(output.name)
                output.write(payload)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, gold_path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    return load_review(manifest_path, full_hash)
