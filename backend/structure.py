"""Server-derived ADR 0051 Record split and composition plans.

The browser names temporary parents, editable metadata and ordered selectors.
Everything authoritative - Asset descriptors, rights, canonical selectors, Record
identities, page maps, bodies and exact pre-digest source maps - is read or derived
from one committed ingests ref here.
"""

from __future__ import annotations

import hashlib
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Protocol

import yaml
from anomalica_common.identity import record_identity
from anomalica_common.pre_digest import PreparedPageRecord, prepare_page_record
from anomalica_common.records import (
    AssetDescriptor,
    PdfPageSelector,
    Record3Structure,
    RecordSelection,
    WholeSelector,
    WorkProvenance,
    canonicalise_selection,
)
from pydantic import ValidationError

SCHEMA_REQUEST = "anomalica/record-structure/1"
SCHEMA_CANDIDATES = "anomalica/structure-candidates/1"
SCHEMA_PREVIEW = "anomalica/structure-preview/1"
_REF = re.compile(r"^[0-9a-f]{40}(?:[0-9a-f]{24})?$")
_HASH = re.compile(r"^[0-9a-f]{64}$")
_PAGE_MARKER = re.compile(r"<!--\s*file_page:\s*([0-9]+)\s*-->")
_DOCUMENT_TYPES = frozenset(
    {
        "book",
        "paper",
        "report",
        "article",
        "letter",
        "email",
        "statement",
        "form",
        "transcript",
        "slide",
        "interview",
        "documentary",
        "footage",
        "podcast",
        "lecture",
        "broadcast",
        "recording",
    }
)
_METADATA_FIELDS = frozenset(
    {"title", "document_type", "provenance", "work_provenance"}
)
_PROVENANCE_FIELDS = frozenset(
    {
        "collection",
        "publisher",
        "creators",
        "published_date",
        "posted_by",
        "posted_date",
        "source_url",
        "also_published_at",
        "identifiers",
        "description",
        "audience",
        "disclosure",
    }
)
_IMAGE_FORMATS = frozenset({"jpg", "jpeg", "png", "webp"})
_AUTHORITY_SIDECARS = (
    "review.json",
    "housekeeping.json",
    "gold.json",
    "verification.json",
    "digest.json",
    "graph.json",
    "audit.json",
    "highlights.json",
)


class StructureError(ValueError):
    """The requested operation cannot be proved from its committed inputs."""


class LocalSource(Protocol):
    store: Path

    def current_ref(self) -> str: ...

    def file_at_ref(self, path: Path, ref: str) -> tuple[str, bytes] | None: ...

    def record_at_ref(
        self, full_hash: str, ref: str
    ) -> tuple[Path, str, bytes] | None: ...


@dataclass(frozen=True)
class PageSource:
    asset_hash: str
    asset_file_page: int
    text: str


@dataclass(frozen=True)
class Parent:
    bare_hash: str
    path: Path
    raw: bytes
    frontmatter: dict[str, Any]
    body: str
    structure: Record3Structure
    prepared: PreparedPageRecord
    pages: tuple[PageSource, ...]


@dataclass(frozen=True)
class StructurePlan:
    preview: dict[str, Any]
    changes: dict[Path, bytes]
    parent_paths: tuple[Path, ...]
    new_paths: tuple[Path, ...]
    existing_artifact_paths: tuple[Path, ...]
    vacant_authority_paths: tuple[Path, ...]


def _envelope(raw: bytes) -> tuple[dict[str, Any], str, str]:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise StructureError("Record is not valid UTF-8") from exc
    match = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|\Z)(.*)\Z", text, re.DOTALL)
    if match is None:
        raise StructureError("Record has no valid YAML frontmatter envelope")
    try:
        loaded = yaml.safe_load(match.group(1))
    except yaml.YAMLError as exc:
        raise StructureError("Record frontmatter is invalid YAML") from exc
    if not isinstance(loaded, dict) or not all(isinstance(key, str) for key in loaded):
        raise StructureError("Record frontmatter must be a string-keyed mapping")
    return loaded, match.group(2), text


def _bare_hash(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.startswith("sha256:"):
        raise StructureError(f"{label} must be a canonical sha256 Record identity")
    bare = value.removeprefix("sha256:")
    if not _HASH.fullmatch(bare):
        raise StructureError(f"{label} must be a canonical sha256 Record identity")
    return bare


def _validate_ref(value: object) -> str:
    if not isinstance(value, str) or not _REF.fullmatch(value):
        raise StructureError("viewed_ref must be a complete Git object id")
    return value


def _archive_path(records_root: Path, asset: AssetDescriptor) -> Path:
    return records_root / (
        f"{asset.asset_hash.removeprefix('sha256:')}.{asset.archived_ext}"
    )


def _validate_archive(records_root: Path, asset: AssetDescriptor) -> None:
    path = _archive_path(records_root, asset)
    if not path.is_file():
        raise StructureError(f"Archived Asset is missing: {asset.asset_hash}")
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    if f"sha256:{digest.hexdigest()}" != asset.asset_hash:
        raise StructureError(f"Archived Asset bytes do not match {asset.asset_hash}")

    prefix = path.read_bytes()[:16]
    if asset.source_type == "pdf":
        if asset.file_format != "pdf" or asset.archived_ext != "pdf":
            raise StructureError(
                "A PDF Asset must use pdf file_format and archived_ext"
            )
        if not prefix.startswith(b"%PDF-"):
            raise StructureError(f"Archived Asset is not a PDF: {asset.asset_hash}")
        return
    if asset.source_type != "image":
        raise StructureError("Structure editing accepts only PDF and image Assets")
    if (
        asset.file_format not in _IMAGE_FORMATS
        or asset.archived_ext not in _IMAGE_FORMATS
    ):
        raise StructureError("A standalone image Asset must be jpg, jpeg, png or webp")
    signatures = {
        "jpg": prefix.startswith(b"\xff\xd8\xff"),
        "jpeg": prefix.startswith(b"\xff\xd8\xff"),
        "png": prefix.startswith(b"\x89PNG\r\n\x1a\n"),
        "webp": prefix.startswith(b"RIFF") and prefix[8:12] == b"WEBP",
    }
    if not signatures[asset.file_format]:
        raise StructureError(
            f"Archived Asset bytes do not match image media type {asset.file_format}"
        )


def _page_sources(structure: Record3Structure, body: str) -> tuple[PageSource, ...]:
    matches = list(_PAGE_MARKER.finditer(body))
    expected = list(range(1, len(structure.page_map or []) + 1))
    if [int(match.group(1)) for match in matches] != expected:
        raise StructureError(
            "Record body must contain one ordered file_page marker for every page"
        )
    pages: list[PageSource] = []
    for index, (match, page) in enumerate(zip(matches, structure.page_map or [])):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        text = body[match.end() : end]
        if not text:
            raise StructureError(f"Record page {page.record_page} has no page text")
        pages.append(PageSource(page.asset_hash, page.asset_file_page, text))
    return tuple(pages)


def _source_map_path(source: LocalSource, prepared: PreparedPageRecord) -> Path:
    return (
        source.store.parent
        / "source-maps"
        / (f"{prepared.source_map_sha256.removeprefix('sha256:')}.json")
    )


def _load_parent(
    source: LocalSource,
    records_root: Path,
    bare_hash: str,
    ref: str,
    *,
    verify_archives: bool,
) -> Parent:
    found = source.record_at_ref(bare_hash, ref)
    if found is None:
        raise StructureError(f"Structural parent is missing: sha256:{bare_hash}")
    path, _blob, raw = found
    canonical_path = source.store / f"{bare_hash}.md"
    if path != canonical_path:
        raise StructureError(
            "A record/3 structural parent must use its canonical store path"
        )
    frontmatter, body, _text = _envelope(raw)
    if frontmatter.get("structure_status") != "temporary":
        raise StructureError(
            f"Structural parent sha256:{bare_hash} is not explicitly temporary"
        )
    if frontmatter.get("retired_into") or frontmatter.get("superseded_by"):
        raise StructureError(f"Structural parent sha256:{bare_hash} is not live")
    try:
        structure = Record3Structure.from_frontmatter(frontmatter)
    except (ValidationError, ValueError) as exc:
        raise StructureError(f"Invalid record/3 parent structure: {exc}") from exc
    if structure.content_hash != f"sha256:{bare_hash}":
        raise StructureError("Structural parent path and content_hash disagree")
    for asset in structure.assets:
        if asset.source_type not in {"pdf", "image"}:
            raise StructureError("Structure editing accepts only PDF and image Assets")
        if verify_archives:
            _validate_archive(records_root, asset)
    try:
        prepared = prepare_page_record(frontmatter, body)
    except (ValidationError, ValueError) as exc:
        raise StructureError(
            f"Cannot derive the parent's exact source map: {exc}"
        ) from exc
    stored_map = source.file_at_ref(_source_map_path(source, prepared), ref)
    if stored_map is None:
        raise StructureError(
            f"Committed source map is missing for parent sha256:{bare_hash}"
        )
    if stored_map[1] != prepared.source_map_json:
        raise StructureError(
            f"Committed source map is stale for parent sha256:{bare_hash}"
        )
    return Parent(
        bare_hash=bare_hash,
        path=path,
        raw=raw,
        frontmatter=frontmatter,
        body=body,
        structure=structure,
        prepared=prepared,
        pages=_page_sources(structure, body),
    )


def _json_metadata(value: object, path: str = "metadata") -> None:
    if value is None:
        raise StructureError(f"{path} must omit unknown values rather than use null")
    if isinstance(value, (str, bool, int)) and not isinstance(value, float):
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            _json_metadata(item, f"{path}[{index}]")
        return
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        for key, item in value.items():
            _json_metadata(item, f"{path}.{key}")
        return
    raise StructureError(f"{path} contains an unsupported value")


def _metadata(value: object) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) - _METADATA_FIELDS:
        raise StructureError(
            "metadata may contain only title, document_type, provenance and work_provenance"
        )
    title = value.get("title")
    if not isinstance(title, str) or not title.strip():
        raise StructureError("Every structural output requires a non-empty title")
    if len(title) > 1000:
        raise StructureError("Output title is too long")
    clean: dict[str, Any] = {"title": title.strip()}
    document_type = value.get("document_type")
    if document_type is not None:
        if document_type not in _DOCUMENT_TYPES:
            raise StructureError("metadata.document_type is invalid")
        clean["document_type"] = document_type
    provenance = value.get("provenance")
    if provenance is not None:
        if not isinstance(provenance, dict) or set(provenance) - _PROVENANCE_FIELDS:
            raise StructureError("metadata.provenance contains an unsupported field")
        _json_metadata(provenance, "metadata.provenance")
        clean["provenance"] = provenance
    work_provenance = value.get("work_provenance")
    if work_provenance is not None:
        try:
            clean["work_provenance"] = WorkProvenance.model_validate(
                work_provenance
            ).model_dump(mode="json")
        except ValidationError as exc:
            raise StructureError(f"metadata.work_provenance is invalid: {exc}") from exc
    return clean


def _parent_pipeline_versions(parents: list[Parent]) -> dict[str, dict[str, Any]]:
    versions: dict[str, dict[str, Any]] = {}
    for parent in parents:
        processing = parent.frontmatter.get("processing")
        if processing is None:
            continue
        if not isinstance(processing, dict):
            raise StructureError("Parent processing metadata must be a mapping")
        entries = processing.get("asset_pipeline_versions")
        if entries is None:
            continue
        if not isinstance(entries, list):
            raise StructureError("Parent asset_pipeline_versions must be a list")
        for entry in entries:
            if (
                not isinstance(entry, dict)
                or set(entry) != {"asset_hash", "source_type", "pipeline_version"}
                or not isinstance(entry.get("pipeline_version"), int)
                or isinstance(entry.get("pipeline_version"), bool)
                or entry["pipeline_version"] <= 0
            ):
                raise StructureError("Parent asset_pipeline_versions is malformed")
            asset_hash = entry.get("asset_hash")
            previous = versions.get(asset_hash)
            if previous is not None and previous != entry:
                raise StructureError("Parents disagree on an Asset pipeline version")
            versions[asset_hash] = dict(entry)
    return versions


def _retire(raw: bytes, retired_into: list[str]) -> bytes:
    frontmatter, _body, text = _envelope(raw)
    if "retired_into" in frontmatter:
        raise StructureError("Structural parent is already retired")
    closing = re.search(r"\r?\n---(?:\r?\n|\Z)", text)
    if closing is None:
        raise StructureError("Structural parent has no closing frontmatter fence")
    line_end = "\r\n" if "\r\n" in closing.group(0) else "\n"
    # Indent sequence items. Workbench's lossless compatibility parser accepts
    # nested list scalars but deliberately ignores top-level mapping entries;
    # PyYAML's default indentless sequence would make a retired parent appear
    # live to that existing discovery path.
    rendered = "retired_into:\n" + "\n".join(
        f"  - {record_hash}" for record_hash in retired_into
    )
    return (
        text[: closing.start()] + line_end + rendered + text[closing.start() :]
    ).encode("utf-8")


def _record_bytes(frontmatter: Mapping[str, Any], body: str) -> bytes:
    class QuotedTitle(str):
        pass

    class RecordDumper(yaml.SafeDumper):
        pass

    RecordDumper.add_representer(
        QuotedTitle,
        lambda dumper, value: dumper.represent_scalar(
            "tag:yaml.org,2002:str", value, style='"'
        ),
    )
    serialised = dict(frontmatter)
    serialised["title"] = QuotedTitle(serialised["title"])
    encoded = yaml.dump(
        serialised,
        sort_keys=False,
        allow_unicode=True,
        default_flow_style=False,
        width=1000,
        Dumper=RecordDumper,
    )
    return f"---\n{encoded}---\n{body}".encode("utf-8")


def _request(payload: object) -> tuple[str, list[str], list[dict[str, Any]]]:
    if not isinstance(payload, dict):
        raise StructureError("Structure request must be an object")
    allowed = {"schema", "viewed_ref", "parents", "outputs"}
    if set(payload) - allowed:
        raise StructureError("Structure request contains unsupported fields")
    if payload.get("schema") != SCHEMA_REQUEST:
        raise StructureError(f"schema must be {SCHEMA_REQUEST}")
    ref = _validate_ref(payload.get("viewed_ref"))
    raw_parents = payload.get("parents")
    if not isinstance(raw_parents, list) or not raw_parents:
        raise StructureError("parents must be a non-empty list")
    parents = [_bare_hash(value, "parent") for value in raw_parents]
    if len(parents) != len(set(parents)):
        raise StructureError("parents contains a duplicate Record")
    outputs = payload.get("outputs")
    if not isinstance(outputs, list) or not outputs:
        raise StructureError("outputs must be a non-empty list")
    for output in outputs:
        if not isinstance(output, dict) or set(output) != {"metadata", "selection"}:
            raise StructureError("Each output must contain only metadata and selection")
    if len(parents) == 1 and len(outputs) < 2:
        raise StructureError("Splitting one parent requires at least two children")
    if len(parents) > 1 and len(outputs) != 1:
        raise StructureError("Composing parents creates exactly one output Record")
    return ref, parents, outputs


def build_plan(
    source: LocalSource,
    records_root: Path,
    payload: object,
) -> StructurePlan:
    """Derive a complete immutable preview and the one-commit byte changes."""
    ref, parent_hashes, requested_outputs = _request(payload)
    parents = [
        _load_parent(source, records_root, parent_hash, ref, verify_archives=True)
        for parent_hash in parent_hashes
    ]

    assets: dict[str, AssetDescriptor] = {}
    page_sources: dict[tuple[str, int], PageSource] = {}
    parent_coordinates: list[set[tuple[str, int]]] = []
    for parent in parents:
        coordinates_for_parent: set[tuple[str, int]] = set()
        for asset in parent.structure.assets:
            previous = assets.get(asset.asset_hash)
            if previous is not None and previous != asset:
                raise StructureError(
                    f"Parents disagree on Asset descriptor or rights: {asset.asset_hash}"
                )
            assets[asset.asset_hash] = asset
        for page in parent.pages:
            coordinate = (page.asset_hash, page.asset_file_page)
            coordinates_for_parent.add(coordinate)
            previous_page = page_sources.get(coordinate)
            if previous_page is not None and previous_page != page:
                raise StructureError(
                    "Structural parents disagree on exact text for an Asset page"
                )
            page_sources[coordinate] = page
        parent_coordinates.append(coordinates_for_parent)

    if len(parents) > 1 and len({asset_hash for asset_hash, _ in page_sources}) < 2:
        raise StructureError("Composition requires at least two distinct Assets")

    pipeline_versions = _parent_pipeline_versions(parents)
    output_documents: list[dict[str, Any]] = []
    output_prepared: list[PreparedPageRecord] = []
    output_paths: list[Path] = []
    vacant_authority_paths: list[Path] = []
    selected_coordinates: set[tuple[str, int]] = set()
    identities: set[str] = set()

    for requested in requested_outputs:
        metadata = _metadata(requested["metadata"])
        try:
            selection = canonicalise_selection(requested["selection"])
        except (ValidationError, ValueError) as exc:
            raise StructureError(f"Invalid output Selection: {exc}") from exc
        coordinates: list[tuple[str, int]] = []
        for entry in selection.root:
            asset = assets.get(entry.asset_hash)
            if asset is None:
                raise StructureError(
                    f"Selection names an unavailable Asset: {entry.asset_hash}"
                )
            if isinstance(entry.selector, PdfPageSelector):
                if asset.source_type != "pdf":
                    raise StructureError("pdf_page selector requires a PDF Asset")
                coordinate = (entry.asset_hash, entry.selector.page)
            elif isinstance(entry.selector, WholeSelector):
                if asset.source_type != "image":
                    raise StructureError(
                        "Workbench whole selectors accept only standalone image Assets"
                    )
                coordinate = (entry.asset_hash, 1)
            else:  # canonicalise_selection has already closed this union.
                raise StructureError("Unsupported selector")
            if coordinate not in page_sources:
                raise StructureError(
                    "Selection names a page outside its structural parents"
                )
            coordinates.append(coordinate)
        selected_coordinates.update(coordinates)
        first_use = list(dict.fromkeys(entry.asset_hash for entry in selection.root))
        selected_assets = [assets[asset_hash] for asset_hash in first_use]
        page_map = [
            {
                "record_page": record_page,
                "asset_hash": asset_hash,
                "asset_file_page": asset_page,
            }
            for record_page, (asset_hash, asset_page) in enumerate(coordinates, 1)
        ]
        try:
            validated = RecordSelection.model_validate(
                {
                    "assets": [
                        asset.model_dump(mode="json", exclude_none=True)
                        for asset in selected_assets
                    ],
                    "selection": selection.model_dump(mode="json"),
                    "page_map": page_map,
                }
            )
        except (ValidationError, ValueError) as exc:
            raise StructureError(f"Invalid derived output structure: {exc}") from exc
        content_hash = record_identity(validated.selection)
        if content_hash in identities:
            raise StructureError(
                "Two requested outputs have the same canonical Selection"
            )
        identities.add(content_hash)
        bare_output = content_hash.removeprefix("sha256:")
        if source.record_at_ref(bare_output, ref) is not None:
            raise StructureError(f"Output Record already exists: {content_hash}")
        for suffix in _AUTHORITY_SIDECARS:
            authority_path = source.store / f"{bare_output}.{suffix}"
            if source.file_at_ref(authority_path, ref) is not None:
                raise StructureError(
                    f"Output Record already has authority state: {authority_path.name}"
                )
            vacant_authority_paths.append(authority_path)

        source_types = list(
            dict.fromkeys(asset.source_type for asset in selected_assets)
        )
        frontmatter: dict[str, Any] = {
            "schema": "anomalica/record/3",
            "content_hash": content_hash,
            **metadata,
            "source_types": source_types,
        }
        if len(source_types) == 1:
            frontmatter["source_type"] = source_types[0]
        if len(selected_assets) == 1:
            frontmatter["file_format"] = selected_assets[0].file_format
        frontmatter.update(
            {
                "pages": len(page_map),
                "assets": [
                    asset.model_dump(mode="json", exclude_none=True)
                    for asset in selected_assets
                ],
                "selection": selection.model_dump(mode="json"),
                "page_map": page_map,
                "structural_parents": [f"sha256:{value}" for value in parent_hashes],
            }
        )
        if all(asset_hash in pipeline_versions for asset_hash in first_use):
            frontmatter["processing"] = {
                "asset_pipeline_versions": [
                    pipeline_versions[asset_hash] for asset_hash in first_use
                ]
            }

        body = "".join(
            f"<!-- file_page: {record_page} -->{page_sources[coordinate].text}"
            for record_page, coordinate in enumerate(coordinates, 1)
        )
        try:
            prepared = prepare_page_record(frontmatter, body)
        except (ValidationError, ValueError) as exc:
            raise StructureError(f"Cannot derive output source map: {exc}") from exc
        output_path = source.store / f"{bare_output}.md"
        output_paths.append(output_path)
        output_prepared.append(prepared)
        output_documents.append(
            {
                "content_hash": content_hash,
                "public_hash": bare_output[:56],
                "title": metadata["title"],
                "assets": frontmatter["assets"],
                "selection": frontmatter["selection"],
                "page_map": page_map,
                "body": body,
                "pre_digest": {
                    "sha256": prepared.sha256,
                    "prep_version": prepared.prep_version,
                    "source_map_sha256": prepared.source_map_sha256,
                },
                "_frontmatter": frontmatter,
            }
        )

    if any(
        not coordinates & selected_coordinates for coordinates in parent_coordinates
    ):
        raise StructureError("Every structural parent must contribute to an output")
    if (
        len(parents) > 1
        and len({asset_hash for asset_hash, _page in selected_coordinates}) < 2
    ):
        raise StructureError("Composition output requires at least two distinct Assets")

    output_hashes = [output["content_hash"] for output in output_documents]
    changes: dict[Path, bytes] = {
        parent.path: _retire(parent.raw, output_hashes) for parent in parents
    }
    new_paths: list[Path] = []
    existing_artifact_paths: list[Path] = []
    for output, output_path, prepared in zip(
        output_documents, output_paths, output_prepared, strict=True
    ):
        changes[output_path] = _record_bytes(output.pop("_frontmatter"), output["body"])
        new_paths.append(output_path)
        immutable = {
            _source_map_path(source, prepared): prepared.source_map_json,
            source.store.parent
            / "pre-digests"
            / f"{prepared.sha256.removeprefix('sha256:')}.md": prepared.text.encode(
                "utf-8"
            ),
        }
        for path, content in immutable.items():
            committed = source.file_at_ref(path, ref)
            if committed is not None:
                if committed[1] != content:
                    raise StructureError(
                        f"Content-addressed artefact collision at {path.name}"
                    )
                existing_artifact_paths.append(path)
                continue
            previous = changes.get(path)
            if previous is not None and previous != content:
                raise StructureError(
                    f"Content-addressed artefact collision at {path.name}"
                )
            changes[path] = content
            new_paths.append(path)

    preview: dict[str, Any] = {
        "schema": SCHEMA_PREVIEW,
        "viewed_ref": ref,
        "parents": [
            {
                "content_hash": parent.structure.content_hash,
                "title": parent.frontmatter.get("title", "Untitled"),
                "retired_into": output_hashes,
            }
            for parent in parents
        ],
        "outputs": output_documents,
    }
    return StructurePlan(
        preview=preview,
        changes=changes,
        parent_paths=tuple(parent.path for parent in parents),
        new_paths=tuple(dict.fromkeys(new_paths)),
        existing_artifact_paths=tuple(dict.fromkeys(existing_artifact_paths)),
        vacant_authority_paths=tuple(dict.fromkeys(vacant_authority_paths)),
    )


def candidate_view(source: LocalSource, records_root: Path, ref: str) -> dict[str, Any]:
    """List committed temporary parents, surfacing invalid ones as blocked."""
    listed = subprocess.run(
        ["git", "ls-tree", "-r", "--name-only", ref, "--", "store"],
        cwd=source.store.parent,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.splitlines()
    candidates: list[dict[str, Any]] = []
    blocked: list[dict[str, str]] = []
    for relative in listed:
        path = source.store.parent / relative
        if path.parent != source.store or path.suffix != ".md":
            continue
        loaded = source.file_at_ref(path, ref)
        if loaded is None:
            continue
        try:
            frontmatter, _body, _text = _envelope(loaded[1])
        except StructureError:
            continue
        if frontmatter.get("structure_status") != "temporary":
            continue
        displayed_hash = str(frontmatter.get("content_hash", path.stem))
        try:
            bare = _bare_hash(frontmatter.get("content_hash"), "content_hash")
            parent = _load_parent(
                source, records_root, bare, ref, verify_archives=False
            )
            assets = {asset.asset_hash: asset for asset in parent.structure.assets}
            candidates.append(
                {
                    "content_hash": parent.structure.content_hash,
                    "title": parent.frontmatter.get("title", "Untitled"),
                    "assets": [
                        {
                            "asset_hash": asset.asset_hash,
                            "source_type": asset.source_type,
                            "file_format": asset.file_format,
                            "pages": asset.pages,
                            "copyright_status": asset.copyright.status,
                        }
                        for asset in parent.structure.assets
                    ],
                    "pages": [
                        {
                            "asset_hash": page.asset_hash,
                            "asset_file_page": page.asset_file_page,
                            "source_type": assets[page.asset_hash].source_type,
                            "excerpt": " ".join(page.text.split())[:180],
                        }
                        for page in parent.pages
                    ],
                }
            )
        except StructureError as exc:
            blocked.append(
                {"content_hash": displayed_hash, "path": relative, "detail": str(exc)}
            )
    candidates.sort(
        key=lambda value: (str(value["title"]).casefold(), value["content_hash"])
    )
    blocked.sort(key=lambda value: value["path"])
    return {
        "schema": SCHEMA_CANDIDATES,
        "viewed_ref": ref,
        "parents": candidates,
        "blocked": blocked,
    }


def assert_clean_targets(source: LocalSource, plan: StructurePlan, ref: str) -> None:
    """Do not overwrite worktree changes or untracked structural output paths."""
    checked_paths = (
        *plan.parent_paths,
        *plan.new_paths,
        *plan.existing_artifact_paths,
        *plan.vacant_authority_paths,
    )
    for path in dict.fromkeys(checked_paths):
        relative = path.relative_to(source.store.parent).as_posix()
        staged = subprocess.run(
            ["git", "diff-index", "--cached", "--quiet", ref, "--", relative],
            cwd=source.store.parent,
        )
        if staged.returncode == 1:
            raise StructureError(f"Structural target has staged changes: {path.name}")
        if staged.returncode != 0:
            staged.check_returncode()

    for path in (*plan.parent_paths, *plan.existing_artifact_paths):
        committed = source.file_at_ref(path, ref)
        if (
            committed is None
            or path.is_symlink()
            or not path.is_file()
            or path.read_bytes() != committed[1]
        ):
            raise StructureError(
                f"Structural target has uncommitted changes: {path.name}"
            )
    for path in plan.new_paths:
        if path.exists() or path.is_symlink():
            raise StructureError(f"Structural output path already exists: {path.name}")
    for path in plan.vacant_authority_paths:
        if path.exists() or path.is_symlink():
            raise StructureError(
                f"Structural output already has authority state: {path.name}"
            )


__all__ = [
    "SCHEMA_REQUEST",
    "StructureError",
    "StructurePlan",
    "assert_clean_targets",
    "build_plan",
    "candidate_view",
]
