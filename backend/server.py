#!/usr/bin/env python3
"""FastAPI backend for the Anomalica Workbench.

Serves ingests from the ingests repository to authenticated
reviewers. In local mode reads from a local clone; in remote mode
talks to the GitHub API via a service account. Selected via env vars.

See architecture/review-workbench.md in the anomalica meta-repo for
the full design, particularly the copyright handling section.
"""

from __future__ import annotations

import json
import math
import mimetypes
import os
import random
import re
import secrets
import string
import time
from abc import ABC, abstractmethod
from collections import OrderedDict
from datetime import datetime
from datetime import timezone as dt_timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

from anomalica_common import pre_digest
from anomalica_common.review_gate import digestibility

from backend import (
    audit_gold,
    curation,
    graph,
    models,
    proposals,
    roles,
    tuning,
    waveform,
)
from backend import (
    archive_flag,
    compositions,
    infrastructure,
    pages,
    relations,
    review_priority,
    tags,
)
from backend.auth import setup_auth
from backend.sync import GIT_LOCK, SyncManager
from anomalica_common import housekeeping as hk

FULL_HASH_LENGTH = 64
PUBLIC_HASH_LENGTH = 56
FULL_HASH_PATTERN = re.compile(r"^[a-f0-9]{64}$")

COVERAGE_SCHEMA = "anomalica/review-coverage/0"
# /1 adds a reviewer-computed verdict at the sidecar top level
# (observed_coverage, digestible, total_units) that the digester's gate reads
# instead of recomputing from spans.
COVERAGE_SCHEMA_V1 = "anomalica/review-coverage/1"

CHALLENGES_PER_SESSION = 10
PASS_RATIO = 0.8
MIN_POOL_FOR_CLOZE_GATE = 5
VERIFICATION_SESSION_TTL_SECONDS = 1800

DEFAULT_INGESTS_PATH = Path(__file__).resolve().parents[2] / "ingests"
DEFAULT_RECORDS_PATH = Path(__file__).resolve().parents[2] / "records"
DEFAULT_DIGESTS_PATH = Path(__file__).resolve().parents[2] / "digests"
DEFAULT_CONTENT_PATH = Path(__file__).resolve().parents[2] / "content"
# Grading results the digester emits for the relevance-tuning loop
# (grading/{body_sha256}.grading.json in the digester repo). Read-only.
DEFAULT_GRADING_PATH = Path(__file__).resolve().parents[2] / "digester" / "grading"
# Materialised pre-digests (ADR 0042): the exact model input, content-addressed,
# with a by-record pointer. Read-only from the digester repo (gitignored there -
# pre-digests carry near-whole copyrighted bodies and the repo is public).
DEFAULT_PREDIGESTS_PATH = (
    Path(__file__).resolve().parents[2] / "digester" / "predigests"
)
# The digester's versioned extraction prompts: registry.yaml maps each prompt
# id (nodes, claims) to its active version's file.
DEFAULT_PROMPTS_PATH = (
    Path(__file__).resolve().parents[2]
    / "digester"
    / "workspace"
    / "digester"
    / "prompts"
)

# Sections under content/pages/ that are hand-authored static/explainer pages
# (translated ~30 ways), NOT assembled knowledge articles. Excluded from the
# Articles tab. Authoritative list per the assembler.
STATIC_PAGE_SECTIONS = frozenset(
    {
        "about",
        "methodology",
        "artificial-intelligence",
        "contact",
        "language-coverage",
        "decisions",
    }
)

# The site publishes every language under a subdir (Hugo defaultContentLanguageInSubdir),
# so even English pages live at /en/<section>/<slug>/. The workbench is English-only
# for now, so article links always point at the English render. When the workbench
# becomes multilingual this should track the reviewer's chosen language.
WORKBENCH_LANG = "en"


def _schema_version(schema: str) -> int:
    """Extract the record format version from `schema` (e.g. `anomalica/record/2` → 2).
    Returns 1 as fallback for absent/unparseable values (old records)."""
    try:
        return int(schema.rstrip("/").rsplit("/", 1)[-1])
    except (ValueError, IndexError):
        return 1


def _unquote(value: str) -> str:
    """Strip surrounding YAML quotes and unescape a double-quoted scalar, so a
    title like '"He said \\"hi\\""' renders with real quotes, not backslashes."""
    value = value.strip()
    if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
        return (
            value[1:-1]
            .replace("\\\\", "\x00")
            .replace('\\"', '"')
            .replace("\x00", "\\")
        )
    if len(value) >= 2 and value[0] == "'" and value[-1] == "'":
        return value[1:-1].replace("''", "'")
    return value


def parse_frontmatter(text: str) -> tuple[dict, str, str]:
    """Extract YAML frontmatter and body from a markdown file.

    Returns (parsed_fields, body, raw_frontmatter_block).
    The raw_frontmatter_block includes the --- delimiters so it can be
    written back without loss.

    Handles top-level scalar fields and one level of nesting (for the
    copyright block). Nested keys are flattened with dots, e.g.
    copyright.status becomes a top-level key.
    """
    match = re.match(r"^(---\n.*?\n---\n)(.*)", text, re.DOTALL)
    if not match:
        return {}, text, ""

    raw_frontmatter = match.group(1)
    body = match.group(2)
    fm_content = raw_frontmatter[
        4 : raw_frontmatter.rindex("---")
    ]  # strip --- delimiters

    frontmatter: dict = {}
    current_parent = ""
    for line in fm_content.splitlines():
        # Top-level key with inline value
        if ":" in line and not line.startswith(" "):
            key, _, value = line.partition(":")
            value = _unquote(value)
            key = key.strip()
            if value:
                frontmatter[key] = value
                current_parent = ""
            else:
                # Block start (e.g. "copyright:" with children below)
                current_parent = key
        # Indented list item under current parent (e.g. authors)
        elif (
            line.startswith("  ") and current_parent and line.lstrip().startswith("- ")
        ):
            item = _unquote(line.lstrip()[2:])
            if item and ":" not in item:
                existing = frontmatter.setdefault(current_parent, [])
                if isinstance(existing, list):
                    existing.append(item)
        # Nested key (indented with spaces)
        elif line.startswith("  ") and ":" in line and current_parent:
            nested_line = line.strip()
            key, _, value = nested_line.partition(":")
            value = _unquote(value)
            frontmatter[f"{current_parent}.{key.strip()}"] = value

    return frontmatter, body, raw_frontmatter


# Digestibility (the digester gate's rule: 100% of content units observed) is
# single-sourced in anomalica_common.review_gate.digestibility - imported above
# so the workbench's browse-list flag and the digester's gate never drift. The
# `_needs_body_for_digestibility` helper avoids reading a record body when the
# sidecar already carries a verdict (the only case the pure rule needs the text).
def _needs_body_for_digestibility(sidecar: dict | None) -> bool:
    return (
        sidecar is not None
        and "observed_coverage" not in sidecar
        and "digestible" not in sidecar
    )


# Pipeline versioning + supersession (anomalica decision 0040). A record's
# `processing.pipeline_version` is the per-media-type extraction generation; a
# record is STALE only when that value is PRESENT and below the current version
# for its media type (absent = "generation not declared", no badge). Supersession
# is the `superseded_by` frontmatter flag (a retired re-acquisition); the browse
# list hides any record carrying it, with source_url newest-wins as belt-and-braces.
def _pipeline_version_of(frontmatter: dict) -> int | None:
    """The record's extraction generation, or None if not declared."""
    raw = frontmatter.get("processing.pipeline_version")
    if raw is None:
        return None
    text = str(raw).strip()
    return int(text) if text.lstrip("-").isdigit() else None


def _date_sort_key(value: str | None) -> float:
    """A comparable POSIX timestamp for an ISO date_extracted, tolerant of the
    store's mixed forms (`...+00:00` and `...Z`). Unparseable/empty sorts oldest
    so a record with a real date always wins the newest-extraction tiebreak."""
    if not value:
        return float("-inf")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return float("-inf")


# `Speaker 3` from diarisation: a cluster id, not a person's name.
_DEFAULT_SPEAKER = re.compile(r"^\[?\s*Speaker\s+\d+\s*\]?$", re.IGNORECASE)

# Far enough into a queued record to pass its frontmatter, not so far that a
# body without a title is read in full.
_QUEUE_HEAD_LINES = 40


class IngestSource(ABC):
    """Abstract source of ingest records. Concrete implementations
    read from a local git clone or from the GitHub API."""

    @abstractmethod
    def list_ingests(self) -> list[dict]:
        """Return a summary index of every available ingest."""

    def queued_titles(self) -> list[str]:
        """Titles of records ingested but not yet in the store.

        A real stage between "we do not hold this" and "it is a record": the
        ingester has produced it and it is waiting to be promoted. Only the
        local clone can see the queue, so the default is empty rather than
        abstract - a source without one is not broken, it just has nothing
        in flight.
        """
        return []

    @abstractmethod
    def get_ingest(self, full_hash: str) -> dict | None:
        """Return the full ingest for a given hash, or None if absent."""

    @abstractmethod
    def save_ingest(self, full_hash: str, content: str) -> bool:
        """Write the modified markdown content back. Returns True on success."""

    @abstractmethod
    def commit_review(
        self,
        full_hash: str,
        author_name: str,
        author_email: str,
        notes: str,
    ) -> None:
        """Commit the current state of the file as a review. COMMIT-ONLY:
        pushing is the operations auto-push watcher's job (the single
        pusher for the ingests clone); callers observe the sync state via
        the SyncManager rather than driving it."""

    @abstractmethod
    def load_verification(self, full_hash: str) -> dict | None:
        """Load the verification sidecar for a record, or None if absent."""

    @abstractmethod
    def load_coverage(self, full_hash: str) -> dict | None:
        """Load the review-coverage sidecar for a record, or None if absent."""

    @abstractmethod
    def append_coverage(
        self,
        full_hash: str,
        email: str,
        spans: list[dict],
        notes: str,
    ) -> bool:
        """Append one review entry to the coverage sidecar (creating it if
        missing). Returns True on success."""

    @abstractmethod
    def supersession(self, full_hash: str) -> dict:
        """Whether a (possibly-open) record has been superseded by a re-ingest.
        Returns {"exists": bool, "superseded_by": str|None} read from
        frontmatter only (no body). Polled by the open review view so it can
        prompt a reload rather than silently showing a stale record."""

    @abstractmethod
    def load_highlights(self, full_hash: str) -> dict | None:
        """Load the relevance-tuning highlights sidecar, or None if absent."""

    @abstractmethod
    def save_highlights(
        self,
        full_hash: str,
        sidecar: dict,
        author_name: str,
        author_email: str,
    ) -> bool:
        """Write the highlights sidecar and commit it. Returns True on success."""

    @abstractmethod
    def reviewed_by_email(self, email: str) -> dict[str, str]:
        """Return {content_hash: latest_review_iso} for this user's reviews."""

    @abstractmethod
    def review_history(self, full_hash: str) -> list[dict]:
        """Every reviewer's edits to a record, newest first: a list of
        {by, at, summary} from the record's git history (no email)."""


def normalise_hash(value: str | None) -> str | None:
    """Strip the optional `sha256:` prefix and validate the hex string."""
    if not value:
        return None
    if value.startswith("sha256:"):
        value = value[len("sha256:") :]
    value = value.strip()
    return value if FULL_HASH_PATTERN.match(value) else None


class LocalIngestSource(IngestSource):
    """Reads ingests directly from a local clone of ingests.

    Records are discovered by scanning every `.md` file in the store and
    reading the `content_hash` from the frontmatter. The filename itself
    is no longer required to be the hash - the new ingester names files
    by `source_id` (e.g. `youtube-sm6AL5lA4Zc.md`) so the filename and
    the content hash are decoupled.
    """

    def __init__(self, repo_path: Path):
        self.store = repo_path / "store"

    def _scan(self) -> dict[str, tuple[Path, dict]]:
        """Walk the store, return {content_hash: (path, frontmatter)}."""
        index: dict[str, tuple[Path, dict]] = {}
        if not self.store.exists():
            return index

        for md_path in sorted(self.store.glob("*.md")):
            with open(md_path) as f:
                frontmatter, _, _ = parse_frontmatter(f.read())

            content_hash = normalise_hash(frontmatter.get("content_hash"))
            if not content_hash:
                continue
            index[content_hash] = (md_path, frontmatter)

        return index

    def _digested_content_hashes(self) -> set[str]:
        """content_hashes that have a digest. The digest YAML is named by the
        friendly by-name/ symlink slug, so walk the symlinks once and only read
        a record's frontmatter when its digest actually exists."""
        digested: set[str] = set()
        records_dir = self.store.parent / "by-name"
        digest_records = digests_path
        if not (records_dir.exists() and digest_records.exists()):
            return digested
        for symlink in records_dir.glob("*.md"):
            if not (digest_records / f"{record_slug(symlink.name)}.yaml").exists():
                continue
            try:
                with open(symlink.resolve()) as f:
                    fm, _, _ = parse_frontmatter(f.read())
            except OSError:
                continue
            ch = normalise_hash(fm.get("content_hash"))
            if ch:
                digested.add(ch)
        return digested

    def _pipeline_versions(self) -> dict[str, int]:
        """Current extraction generation per media type, from
        `store/_pipeline_versions.yaml` ({media_type: int}) - a flat map the
        ingester upserts each run (decision 0040). Parsed without a YAML
        dependency; a missing file yields an empty map (nothing badges)."""
        path = self.store / "_pipeline_versions.yaml"
        versions: dict[str, int] = {}
        try:
            text = path.read_text()
        except OSError:
            return versions
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or ":" not in line:
                continue
            key, _, value = line.partition(":")
            value = value.strip()
            if value.lstrip("-").isdigit():
                versions[key.strip()] = int(value)
        return versions

    def _dedup_by_source(self, ingests: list[dict]) -> list[dict]:
        """Belt-and-braces for supersession: at most one record per source_url,
        newest `date_ingested` winning. The deterministic rule is the
        superseded_by flag (filtered in list_ingests); this catches a retired
        record that slipped its store/v1/ move. Records with no source_url pass
        through untouched (no logical-source key to dedup on)."""
        best: dict[str, dict] = {}
        passthrough: list[dict] = []
        for ing in ingests:
            src = ing.get("source_url") or ""
            if not src:
                passthrough.append(ing)
                continue
            cur = best.get(src)
            if cur is None or _date_sort_key(ing.get("date_ingested")) > _date_sort_key(
                cur.get("date_ingested")
            ):
                best[src] = ing
        return passthrough + list(best.values())

    def _scan_archived(self) -> dict[str, tuple[Path, dict]]:
        """Walk store/v1/, return {content_hash: (path, frontmatter)}."""
        index: dict[str, tuple[Path, dict]] = {}
        archive = self.store / "v1"
        if not archive.exists():
            return index
        for md_path in sorted(archive.glob("*.md")):
            with open(md_path) as f:
                frontmatter, _, _ = parse_frontmatter(f.read())
            content_hash = normalise_hash(frontmatter.get("content_hash"))
            if not content_hash:
                continue
            index[content_hash] = (md_path, frontmatter)
        return index

    def list_archived_ingests(self) -> list[dict]:
        """Summary metadata for every record in store/v1/."""
        ingests: list[dict] = []
        for content_hash, (md_path, frontmatter) in self._scan_archived().items():
            creators = frontmatter.get("creators") or frontmatter.get("authors") or []
            if not isinstance(creators, list):
                creators = []
            schema_version = _schema_version(frontmatter.get("schema", ""))
            ingests.append(
                {
                    "content_hash": content_hash,
                    "public_hash": content_hash[:PUBLIC_HASH_LENGTH],
                    "title": frontmatter.get("title", "Untitled"),
                    "schema_version": schema_version,
                    "creators": creators,
                    "digestible": False,
                    "observed_coverage": 0,
                    "digested": False,
                    "date": frontmatter.get(
                        "date_published", frontmatter.get("date", "")
                    ),
                    "date_ingested": frontmatter.get(
                        "date_extracted", frontmatter.get("date_accessed", "")
                    ),
                    "source_type": frontmatter.get("source_type", ""),
                    # What the thing IS (email, transcript...), distinct from how it
                    # was acquired. The list shows this in preference.
                    "document_type": frontmatter.get("document_type", ""),
                    "pipeline_version": None,
                    "pipeline_current": None,
                    "source_url": frontmatter.get("source_url", ""),
                    "source_file": frontmatter.get("source_file", ""),
                    "source_hash": frontmatter.get("source_hash", ""),
                    "provenance": frontmatter.get("provenance", ""),
                    "publisher": frontmatter.get("publisher", ""),
                    "copyright_status": frontmatter.get(
                        "copyright.status", "restricted"
                    ),
                    "review_carryover": None,
                }
            )
        ingests.sort(key=lambda x: (x.get("date", ""), x.get("title", "")))
        return ingests

    def _symlink_for_hash(self, full_hash: str) -> Path | None:
        """Find the by-name/ symlink pointing at store/{hash}.md, if any."""
        records_dir = self.store.parent / "by-name"
        if not records_dir.exists():
            return None
        for symlink in records_dir.glob("*.md"):
            if not symlink.is_symlink():
                continue
            target = symlink.resolve()
            if full_hash in target.name:
                return symlink
        return None

    def _make_symlink_name(self, frontmatter: dict) -> str:
        """Generate a human-readable symlink name from frontmatter.

        Pattern: {date}-{source_type}-{slugified-title}.md
        """
        date_val = (
            frontmatter.get("date_published")
            or frontmatter.get("date", "")
            or "unknown"
        )[:10]
        stype = frontmatter.get("source_type", "unknown")
        title = frontmatter.get("title", "untitled")
        slug = re.sub(r"[^a-zA-Z0-9]+", "-", title.lower()).strip("-")
        slug = re.sub(r"-+", "-", slug)
        return f"{date_val}-{stype}-{slug}.md"

    def _git_commit_paths(
        self,
        paths: list[Path],
        message: str,
        author_name: str,
        author_email: str,
    ) -> None:
        import subprocess

        repo_dir = self.store.parent
        env = {
            **os.environ,
            "GIT_AUTHOR_NAME": author_name,
            "GIT_AUTHOR_EMAIL": author_email,
        }
        # A moved-from path no longer exists on disk; `git add` stages its
        # deletion only if it is tracked, and errors on an untracked missing
        # path - so filter those out rather than aborting the whole commit.
        with GIT_LOCK:
            rel_paths = []
            for p in paths:
                rel = str(p.relative_to(repo_dir))
                if (
                    p.exists()
                    or p.is_symlink()
                    or subprocess.run(
                        ["git", "ls-files", "--error-unmatch", rel],
                        cwd=repo_dir,
                        capture_output=True,
                    ).returncode
                    == 0
                ):
                    rel_paths.append(rel)
            subprocess.run(
                ["git", "add", *rel_paths],
                cwd=repo_dir,
                check=True,
                env=env,
            )
            subprocess.run(
                ["git", "commit", "-m", message],
                cwd=repo_dir,
                check=True,
                env=env,
            )

    def archive_ingest(self, full_hash: str, user: dict) -> bool:
        """Move a record from store/ to store/v1/, stamp the decision into its
        frontmatter, and remove its by-name/ symlink.

        The stamp is not bookkeeping. `store/v1/` means "archived" here and
        "intake queue" to the scheduler's ingest lane, so the folder Mark
        archives INTO is the one the GPU lane shops FROM - archiving offered a
        record straight back for re-transcription (22 of his 26 archived records
        were sitting in that lane). The two states are identical on disk, so
        without the flag the only trace of the decision is this commit's subject
        line: a contract made of prose. The scheduler's skip already reads
        `archived`; nothing ever wrote it.
        """
        entry = self._scan().get(full_hash)
        if entry is None:
            return False
        md_path, frontmatter = entry
        archive_dir = self.store / "v1"
        archive_dir.mkdir(parents=True, exist_ok=True)
        dest = archive_dir / md_path.name

        stamped_at = datetime.now(dt_timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        md_path.write_text(
            archive_flag.stamp_archived(md_path.read_text(), True, stamped_at)
        )
        md_path.rename(dest)

        # Both sides of the move: staging only the destination leaves the
        # source tracked in git and its deletion dangling in the work tree.
        paths: list[Path] = [dest, md_path]
        symlink = self._symlink_for_hash(full_hash)
        if symlink:
            symlink.unlink()
            paths.append(symlink)

        title = frontmatter.get("title", full_hash[:12])
        self._git_commit_paths(
            paths,
            f"archive: {title}",
            author_name=user.get("name", "Workbench"),
            author_email=user.get("email", "workbench@anomalica.com"),
        )
        return True

    def unarchive_ingest(self, full_hash: str, user: dict) -> bool:
        """Move a record from store/v1/ back to store/, clear the archive stamp,
        and recreate its symlink.

        Clearing matters as much as setting: a record back in the active corpus
        still flagged archived would be skipped by the scheduler's lane forever -
        restored for Mark, invisible to the pipeline.
        """
        entry = self._scan_archived().get(full_hash)
        if entry is None:
            return False
        md_path, frontmatter = entry

        dest = self.store / md_path.name
        md_path.write_text(archive_flag.stamp_archived(md_path.read_text(), False))
        md_path.rename(dest)

        paths: list[Path] = [dest, md_path]
        symlink_name = self._make_symlink_name(frontmatter)
        records_dir = self.store.parent / "by-name"
        if records_dir.exists():
            link_path = records_dir / symlink_name
            link_path.symlink_to(Path("../store") / md_path.name)
            paths.append(link_path)

        title = frontmatter.get("title", full_hash[:12])
        self._git_commit_paths(
            paths,
            f"unarchive: {title}",
            author_name=user.get("name", "Workbench"),
            author_email=user.get("email", "workbench@anomalica.com"),
        )
        return True

    def known_speakers(self) -> list[dict]:
        """Every speaker name the corpus already uses, with how many ingests
        each appears in.

        Exists so a reviewer naming a speaker can see what they (or a past
        session) already wrote for the same person. The recurring problem is
        not misspelling, it is FORMAT - whether a nickname goes in quotes, in
        brackets, or not at all - and the only cure is showing the existing
        spelling at the moment the next one is typed.

        Reads the cached frontmatter index, so it costs no file reads beyond
        the ones the listing already does."""
        counts: dict[str, int] = {}
        for _hash, (_path, frontmatter) in self._scan().items():
            if frontmatter.get("superseded_by"):
                continue
            speakers = frontmatter.get("speakers") or []
            if not isinstance(speakers, list):
                continue
            for name in speakers:
                if not isinstance(name, str):
                    continue
                name = name.strip()
                # A name in square brackets is a DESCRIPTION of someone whose
                # real name is unknown - `[interviewer 2]`, `[narrator]`,
                # `[speaker 3]`. It is scoped to its own record: the
                # `[interviewer 2]` in one recording is not the person in
                # another, so offering it here would invite a reviewer to file
                # two strangers under one name. `Speaker 3` unbracketed is the
                # same thing written the old way.
                if not name or name.startswith("[") or _DEFAULT_SPEAKER.match(name):
                    continue
                counts[name] = counts.get(name, 0) + 1
        return [
            {"name": name, "ingests": n}
            for name, n in sorted(
                counts.items(), key=lambda kv: (-kv[1], kv[0].lower())
            )
        ]

    def queued_titles(self) -> list[str]:
        """Titles from `ingests/queue/*.md`, read from the frontmatter head.

        Only the first lines of each file: the queue holds whole records and
        this needs one field from each. Bounded rather than parsed, so a
        malformed record costs its own title and nothing else.
        """
        titles: list[str] = []
        for path in sorted(self.store.parent.glob("queue/*.md")):
            try:
                with path.open(errors="replace") as handle:
                    for _ in range(_QUEUE_HEAD_LINES):
                        line = handle.readline()
                        if not line:
                            break
                        if line.startswith("title:"):
                            titles.append(line[len("title:") :].strip().strip("'\""))
                            break
            except OSError:
                continue
        return titles

    def list_ingests(self) -> list[dict]:
        ingests: list[dict] = []
        digested_hashes = self._digested_content_hashes()
        manifest = self._pipeline_versions()
        for content_hash, (md_path, frontmatter) in self._scan().items():
            # Supersession: a retired re-acquisition is hidden from the browse
            # list (decision 0040). The flag is the source of truth; the file's
            # store/v1/ move is a derived convenience.
            if frontmatter.get("superseded_by"):
                continue
            # The spec field is `creators`; older records used `authors`.
            creators = frontmatter.get("creators") or frontmatter.get("authors") or []
            if not isinstance(creators, list):
                creators = []
            # Digestibility: read the coverage sidecar; only read the record
            # body when the legacy recompute path needs it (no stored verdict).
            sidecar = self.load_coverage(content_hash)
            record_text = (
                md_path.read_text() if _needs_body_for_digestibility(sidecar) else None
            )
            verdict = digestibility(record_text, sidecar)
            schema_version = _schema_version(frontmatter.get("schema", ""))
            ingests.append(
                {
                    "content_hash": content_hash,
                    "public_hash": content_hash[:PUBLIC_HASH_LENGTH],
                    "title": frontmatter.get("title", "Untitled"),
                    "schema_version": schema_version,
                    "creators": creators,
                    "digestible": verdict.digestible,
                    "observed_coverage": verdict.observed_coverage,
                    "digested": content_hash in digested_hashes,
                    "date": frontmatter.get(
                        "date_published", frontmatter.get("date", "")
                    ),
                    "date_ingested": frontmatter.get(
                        "date_extracted", frontmatter.get("date_accessed", "")
                    ),
                    "source_type": frontmatter.get("source_type", ""),
                    # What the thing IS (email, transcript...), distinct from how it
                    # was acquired. The list shows this in preference.
                    "document_type": frontmatter.get("document_type", ""),
                    # Extraction generation vs the current per-media-type version
                    # (decision 0040). The frontend badges "outdated" only when
                    # pipeline_version is present and below pipeline_current.
                    "pipeline_version": _pipeline_version_of(frontmatter),
                    "pipeline_current": manifest.get(
                        frontmatter.get("source_type", "")
                    ),
                    # The pipeline tried to refresh this stale record and would
                    # not: the fresh extraction lost words a reviewer had kept.
                    # Without this a refused record looks exactly like one never
                    # tried. The reason is written by the ingester for a person.
                    "refresh_refused": (
                        {
                            "at": frontmatter.get("refresh_refused.at", ""),
                            "reason": frontmatter.get("refresh_refused.reason", ""),
                        }
                        if frontmatter.get("refresh_refused.at")
                        else None
                    ),
                    "source_url": frontmatter.get("source_url", ""),
                    # Acquisition provenance: source_url (http origin),
                    # source_file (local origin filename), source_hash (the
                    # archived original by sha256), or provenance: "unknown"
                    # when none of those recover the origin.
                    "source_file": frontmatter.get("source_file", ""),
                    "source_hash": frontmatter.get("source_hash", ""),
                    "provenance": frontmatter.get("provenance", ""),
                    "publisher": frontmatter.get("publisher", ""),
                    "copyright_status": frontmatter.get(
                        "copyright.status", "restricted"
                    ),
                    # Present when the ingester carried a prior review onto a
                    # re-ingested record; the workbench shows it as
                    # "carried over, verify" rather than fresh or reviewed.
                    "review_carryover": (
                        {
                            "at": frontmatter.get("review_carryover.at", ""),
                            "from": frontmatter.get("review_carryover.from", ""),
                            "had_text_edits": frontmatter.get(
                                "review_carryover.had_text_edits"
                            )
                            in (True, "true", "True"),
                        }
                        if frontmatter.get("review_carryover.at")
                        else None
                    ),
                }
            )
        ingests = self._dedup_by_source(ingests)
        ingests.sort(key=lambda x: (x.get("date", ""), x.get("title", "")))
        return ingests

    def bodies(self, hashes: set[str]) -> dict[str, str]:
        """Just the bodies, for callers that want prose and nothing else.

        `get_ingest` assembles a whole per-record verdict - coverage sidecar,
        digestibility, creator reconciliation - which is right for opening one
        record and wasteful across the store: it was most of an 18-second
        review-queue rebuild, and the queue rebuilds every time a review lands.
        """
        out: dict[str, str] = {}
        for full_hash, (md_path, _fm) in self._scan().items():
            if full_hash not in hashes:
                continue
            try:
                _fm2, body, _raw = parse_frontmatter(md_path.read_text())
            except OSError:
                continue
            out[full_hash] = body
        return out

    def get_ingest(self, full_hash: str) -> dict | None:
        # Archived (store/v1/) records stay fetchable by full hash: the
        # Archived list links to them, and tuning-mode ground truth is often
        # annotated on a retired body (stable, never edited by reviews).
        entry = self._scan().get(full_hash) or self._scan_archived().get(full_hash)
        if entry is None:
            return None
        md_path, _ = entry

        with open(md_path) as f:
            content = f.read()

        frontmatter, body, raw_frontmatter = parse_frontmatter(content)
        # The spec field is `creators`; older records used `authors`. Pop both
        # so neither shows again in the generic frontmatter panel.
        creators = (
            frontmatter.pop("creators", None) or frontmatter.pop("authors", None) or []
        )
        if not isinstance(creators, list):
            creators = []
        # The reviewer's LAST-SUBMITTED verdict, read straight from the sidecar
        # (recomputed from the body only when no verdict is stored). The frontend
        # shows this rather than a live recompute, because a recompute divides the
        # observed spans by the CURRENT word count - which shifts when the body is
        # edited (e.g. highlight markers), silently changing coverage under a
        # review that never moved.
        sidecar = self.load_coverage(full_hash)
        verdict = digestibility(
            content if _needs_body_for_digestibility(sidecar) else None, sidecar
        )
        return {
            "content_hash": full_hash,
            "public_hash": full_hash[:PUBLIC_HASH_LENGTH],
            "copyright_status": frontmatter.get("copyright.status", "restricted"),
            "creators": creators,
            "frontmatter": frontmatter,
            "raw_frontmatter": raw_frontmatter,
            "body": body,
            "observed_coverage": verdict.observed_coverage,
            "digestible": verdict.digestible,
        }

    def save_ingest(self, full_hash: str, content: str) -> bool:
        entry = self._scan().get(full_hash)
        if entry is None:
            return False
        md_path, _ = entry
        with open(md_path, "w") as f:
            f.write(content)
        return True

    def commit_review(
        self,
        full_hash: str,
        author_name: str,
        author_email: str,
        notes: str,
    ) -> None:
        import subprocess

        entry = self._scan().get(full_hash)
        if entry is None:
            return
        md_path, frontmatter = entry
        title = frontmatter.get("title", full_hash[:12])

        env = {
            **os.environ,
            "GIT_AUTHOR_NAME": author_name,
            "GIT_AUTHOR_EMAIL": author_email,
        }

        repo_dir = self.store.parent
        paths = [str(md_path.relative_to(repo_dir))]
        # Review-coverage sidecar travels in the same commit as the review
        # it belongs to, so the audit trail stays one-commit-per-review.
        coverage_path = self._coverage_path(full_hash)
        if coverage_path.exists():
            paths.append(str(coverage_path.relative_to(repo_dir)))

        # Reviewed-Record trailers: one per identity the record carries
        # at review time. Format is `<kind>:<value>` with kind in
        # {url, sha256, content}, per architecture/review-workbench.md.
        # Strongest available identity wins on scan, so emitting all
        # makes the review survive future re-ingestions that rotate the
        # weaker identities.
        trailers: list[str] = []
        source_url = (frontmatter.get("source_url") or "").strip()
        if source_url:
            trailers.append(f"Reviewed-Record: url:{source_url}")
        source_hash = normalise_hash(frontmatter.get("source_hash"))
        if source_hash:
            trailers.append(f"Reviewed-Record: sha256:{source_hash}")
        trailers.append(f"Reviewed-Record: content:{full_hash}")

        # Hold the git lock across stage+commit+push so the background sync
        # thread can never rebase the clone mid-commit.
        with GIT_LOCK:
            subprocess.run(
                ["git", "add", *paths],
                cwd=repo_dir,
                check=True,
                env=env,
            )

            # If save_ingest wrote the same bytes that were already on disk,
            # there's nothing staged. That's the "approved as-is" case -
            # record it as an empty commit so the review is still part of the
            # audit trail and shows up in the same git log as
            # content-changing reviews.
            diff = subprocess.run(
                ["git", "diff", "--cached", "--quiet"],
                cwd=repo_dir,
                env=env,
            )
            no_changes = diff.returncode == 0

            message = f"review: {title}"
            if no_changes:
                message += " (approved as-is)"
            if notes:
                message += f"\n\n{notes}"
            message += "\n\n" + "\n".join(trailers)

            cmd = ["git", "commit", "-m", message]
            if no_changes:
                cmd.append("--allow-empty")
            subprocess.run(cmd, cwd=repo_dir, check=True, env=env)

            # Invalidate the cached review index so the new commit shows up
            # in /api/me/reviews on the next read.
            self._reviewed_cache = None
            # COMMIT-ONLY: the operations auto-push watcher (the single
            # pusher for this clone) sees the new reflog entry and pushes
            # within seconds; the submit flow observes it via wait_for_push.

    # Per-email list of (kind, value, iso_ts) trailers. Cross-referenced
    # against record frontmatter identities in reviewed_by_email.
    _reviewed_cache: dict[str, list[tuple[str, str, str]]] | None = None

    def reviewed_by_email(self, email: str) -> dict[str, str]:
        """Return {content_hash: latest_review_iso} for this user across
        the current corpus. For each record, walk its three identities
        (source_url, source_hash, content_hash) and check the trailer
        index. Any matching kind on any historical commit counts; the
        latest matching timestamp wins. Per
        architecture/review-workbench.md `Review identity across
        re-ingestion`."""
        target = email.strip().lower()
        if self._reviewed_cache is None:
            self._reviewed_cache = self._scan_git_reviews()
        trailers = self._reviewed_cache.get(target, [])
        if not trailers:
            return {}

        # Flatten to (kind, value) -> latest ts for O(1) lookups.
        by_kind_value: dict[tuple[str, str], str] = {}
        for kind, value, ts in trailers:
            key = (kind, value)
            existing = by_kind_value.get(key)
            if existing is None or ts > existing:
                by_kind_value[key] = ts

        out: dict[str, str] = {}
        for content_hash, (_, frontmatter) in self._scan().items():
            candidates: list[str] = []
            source_url = (frontmatter.get("source_url") or "").strip()
            if source_url:
                ts = by_kind_value.get(("url", source_url))
                if ts:
                    candidates.append(ts)
            source_hash = normalise_hash(frontmatter.get("source_hash"))
            if source_hash:
                ts = by_kind_value.get(("sha256", source_hash))
                if ts:
                    candidates.append(ts)
            ts = by_kind_value.get(("content", content_hash))
            if ts:
                candidates.append(ts)
            if candidates:
                out[content_hash] = max(candidates)
        return out

    def review_history(self, full_hash: str) -> list[dict]:
        """Every reviewer's edits to this record, newest first: the git log of
        the record's canonical body file. {by, at, summary} - no email.

        summary is the subject line plus the reviewer's notes ("Reviewed up to
        20%"), if any were given - the detail a reviewer resuming later
        actually needs, not just the commit title. Notes are the commit body
        with blank lines and Reviewed-Record: identity trailers (see
        architecture/review-workbench.md) stripped, since those aren't for
        humans.
        """
        import subprocess

        entry = self._scan().get(full_hash)
        if entry is None:
            return []
        md_path, _ = entry
        repo_dir = self.store.parent
        rel = str(md_path.relative_to(repo_dir))
        # %x03 (end-of-text) separates commits so a multi-line %b body can't be
        # mistaken for the next commit's fields; %x00 separates fields within one.
        proc = subprocess.run(
            ["git", "log", "--format=%an%x00%aI%x00%s%x00%b%x03", "--", rel],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            return []
        history = []
        for record in proc.stdout.split("\x03"):
            record = record.strip("\n")
            if not record:
                continue
            parts = record.split("\x00")
            if len(parts) != 4:
                continue
            by, at, subject, body = parts
            notes = "\n".join(
                line
                for line in body.splitlines()
                if line.strip() and not line.startswith("Reviewed-Record:")
            ).strip()
            summary = f"{subject} - {notes}" if notes else subject
            history.append({"by": by, "at": at, "summary": summary})
        return history

    def _scan_git_reviews(self) -> dict[str, list[tuple[str, str, str]]]:
        """Walk review commits in the ingests repo and collect every
        Reviewed-Record trailer (and synthesise content-kind entries
        for legacy commits that touched a store/<hash>.md file but
        carried no trailer).

        Returns {email: [(kind, value, iso_ts), ...]}. The kind is one
        of `url`, `sha256`, `content` per the spec. Resolution against
        a specific record happens in reviewed_by_email.

        Back-compatibility: historical commits emitted
        `Reviewed-Record: sha256:<content_hash>` because the kind/value
        split didn't exist yet - the value was always a content_hash
        despite the `sha256:` prefix. Per the spec's back-compat
        subsection, such trailers are recorded under BOTH `sha256` and
        `content` kinds so the historical reviews keep matching after
        the spec change. The chance of a content_hash colliding with
        another record's source_hash is astronomical, so the dual
        registration is safe.
        """
        import subprocess

        repo_dir = self.store.parent
        if not (repo_dir / ".git").exists():
            return {}

        out: dict[str, list[tuple[str, str, str]]] = {}

        def record(email: str, kind: str, value: str, ts: str) -> None:
            out.setdefault(email, []).append((kind, value, ts))

        # Trailer-based detection.
        trailer_result = subprocess.run(
            [
                "git",
                "log",
                "--no-merges",
                "--format=%ae|%aI|%(trailers:key=Reviewed-Record,valueonly,separator=,)",
            ],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            check=False,
        )
        if trailer_result.returncode == 0:
            for raw in trailer_result.stdout.splitlines():
                parts = raw.split("|", 2)
                if len(parts) < 3:
                    continue
                email, iso_ts, trailer = parts
                email = email.strip().lower()
                iso_ts = iso_ts.strip()
                trailer = trailer.strip()
                if not email or not trailer or not iso_ts:
                    continue
                for entry in trailer.split(","):
                    entry = entry.strip()
                    if not entry:
                        continue
                    # url: values can contain colons (https://...) - split
                    # only on the first colon to extract the kind.
                    colon = entry.find(":")
                    if colon < 0:
                        continue
                    kind = entry[:colon]
                    value = entry[colon + 1 :]
                    if kind == "url" and value:
                        record(email, "url", value, iso_ts)
                    elif kind == "sha256" and FULL_HASH_PATTERN.match(value):
                        record(email, "sha256", value, iso_ts)
                        # Spec back-compat: legacy commits used
                        # sha256:<content_hash>. Try as content-kind too.
                        record(email, "content", value, iso_ts)
                    elif kind == "content" and FULL_HASH_PATTERN.match(value):
                        record(email, "content", value, iso_ts)

        # File-path detection (legacy fallback for commits with no
        # Reviewed-Record trailer at all). Anything touched in store/
        # is treated as a content-kind review of that file's record.
        index = self._scan()
        file_to_hash: dict[str, str] = {}
        for content_hash, (md_path, _) in index.items():
            rel = str(md_path.relative_to(repo_dir))
            file_to_hash[rel] = content_hash

        file_result = subprocess.run(
            [
                "git",
                "log",
                "--no-merges",
                "--pretty=format:COMMIT %ae %aI",
                "--name-only",
                "--",
                "store/",
            ],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            check=False,
        )
        if file_result.returncode == 0:
            current_email: str | None = None
            current_ts: str | None = None
            for raw in file_result.stdout.splitlines():
                line = raw.strip()
                if not line:
                    continue
                if line.startswith("COMMIT "):
                    rest = line[len("COMMIT ") :].strip()
                    sep = rest.rfind(" ")
                    if sep > 0:
                        current_email = rest[:sep].strip().lower()
                        current_ts = rest[sep + 1 :].strip()
                    else:
                        current_email = rest.lower()
                        current_ts = None
                    continue
                if current_email is None or current_ts is None:
                    continue
                content_hash = file_to_hash.get(line)
                if content_hash:
                    record(current_email, "content", content_hash, current_ts)
        return out

    def load_verification(self, full_hash: str) -> dict | None:
        path = self.store / f"{full_hash}.verification.json"
        if not path.exists():
            return None
        with open(path) as f:
            return json.load(f)

    def _coverage_path(self, full_hash: str) -> Path:
        return self.store / f"{full_hash}.review.json"

    def supersession(self, full_hash: str) -> dict:
        # Uses the scan's already-parsed frontmatter, so no body is read. A
        # re-ingested record moves to store/v1/ carrying superseded_by; the
        # live store no longer has it, so check both.
        entry = self._scan().get(full_hash) or self._scan_archived().get(full_hash)
        if entry is None:
            return {"exists": False, "superseded_by": None}
        _, frontmatter = entry
        return {
            "exists": True,
            "superseded_by": normalise_hash(frontmatter.get("superseded_by")),
        }

    def _highlights_path(self, full_hash: str) -> Path | None:
        """The highlights sidecar sits next to the record file, so an
        archived (store/v1/) record's sidecar lives in store/v1/ too."""
        entry = self._scan().get(full_hash) or self._scan_archived().get(full_hash)
        if entry is None:
            return None
        md_path, _ = entry
        return md_path.parent / f"{full_hash}.highlights.json"

    def load_highlights(self, full_hash: str) -> dict | None:
        path = self._highlights_path(full_hash)
        if path is None or not path.exists():
            return None
        with open(path) as f:
            return json.load(f)

    def save_audit(
        self,
        full_hash: str,
        gold: dict,
        author_name: str,
        author_email: str,
    ) -> bool:
        """Write the audit-gold sidecar (`{hash}.audit.json`) next to the record
        and commit it. The auto-push watcher lands it on origin."""
        entry = self._scan().get(full_hash) or self._scan_archived().get(full_hash)
        if entry is None:
            return False
        md_path, frontmatter = entry
        path = md_path.parent / f"{full_hash}.audit.json"
        path.write_text(json.dumps(gold, indent=2, ensure_ascii=False) + "\n")
        title = frontmatter.get("title", full_hash[:12])
        # COMMIT ON A DEBOUNCE, not per verdict. Grading is a rapid activity -
        # a reviewer works through claims a keypress at a time - and committing
        # each one cost 2.1s of git inside the request, so every keypress paid
        # for a commit before the next could start. The file is written
        # immediately (the durable part, and what any reader sees); the commit
        # follows once the reviewer pauses, collapsing a burst of verdicts into
        # one commit that also reads better in the log.
        _schedule_audit_commit(
            self, path, f"audit gold: {title}", author_name, author_email
        )
        return True

    def audit_store_dir(self, full_hash: str) -> Path | None:
        """The directory holding a record's `{hash}.audit.json` (store, or
        store/v1/ for an archived record)."""
        entry = self._scan().get(full_hash) or self._scan_archived().get(full_hash)
        return entry[0].parent if entry else None

    def save_roles(
        self,
        roles_map: dict,
        author_name: str,
        author_email: str,
    ) -> bool:
        """Write `ingests/roles.yaml` and commit it (the auto-push watcher lands
        it on origin). Roles gate write access, so a change is a real commit to
        the access-gated ingests repo, attributed to the editor who made it."""
        path = roles.save_roles(self.store.parent, roles_map)
        self._git_commit_paths(
            [path],
            "roles: update contribution roles",
            author_name=author_name,
            author_email=author_email,
        )
        return True

    def save_highlights(
        self,
        full_hash: str,
        sidecar: dict,
        author_name: str,
        author_email: str,
    ) -> bool:
        entry = self._scan().get(full_hash) or self._scan_archived().get(full_hash)
        if entry is None:
            return False
        _, frontmatter = entry
        path = self._highlights_path(full_hash)
        with open(path, "w") as f:
            json.dump(sidecar, f, indent=2, ensure_ascii=False)
            f.write("\n")
        title = frontmatter.get("title", full_hash[:12])
        self._git_commit_paths(
            [path],
            f"highlights: {title}",
            author_name=author_name,
            author_email=author_email,
        )
        # Commit-only: the auto-push watcher lands it on origin.
        return True

    def load_coverage(self, full_hash: str) -> dict | None:
        path = self._coverage_path(full_hash)
        if not path.exists():
            return None
        with open(path) as f:
            return json.load(f)

    def append_coverage(
        self,
        full_hash: str,
        email: str,
        spans: list[dict],
        notes: str,
        observed_coverage: float | None = None,
        digestible: bool | None = None,
        total_units: int | None = None,
    ) -> bool:
        """Append one review entry to `{hash}.review.json`. Spans anchor to
        line indices (segment records) or word indices (word records) of the
        body at submission time; `parent_commit` records the repo HEAD before
        the review commit. When `observed_coverage` is supplied, the reviewer's
        verdict (observed_coverage, digestible, total_units) is stored at the
        sidecar top level and the schema bumped to /1.

        The verdict is NOT enforced anywhere. The digester's `assess_record` is
        imported by one caller, its `coverage` reporting command; the `extract`
        path never consults it, so an unreviewed record digests exactly like a
        reviewed one and the resulting digest does not record which it was.
        This comment used to claim the gate read the verdict - a documented
        safety property that nothing enforces is worse than no property at all,
        because it gets relied on. Until the digester enforces it, this is a
        report, not a gate."""
        import subprocess
        from datetime import datetime, timezone

        if self._scan().get(full_hash) is None:
            return False

        sidecar = self.load_coverage(full_hash) or {
            "schema": COVERAGE_SCHEMA,
            "reviews": [],
        }

        repo_dir = self.store.parent
        head = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            check=False,
        )
        parent_commit = head.stdout.strip() if head.returncode == 0 else None

        entry: dict = {
            "by": email,
            "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "spans": [
                {
                    "from": s["from"],
                    "to": s["to"],
                    "kind": s.get("kind", "observed"),
                }
                for s in spans
            ],
        }
        if notes:
            entry["notes"] = notes
        if parent_commit:
            entry["parent_commit"] = parent_commit
        sidecar["reviews"].append(entry)

        if observed_coverage is not None:
            sidecar["schema"] = COVERAGE_SCHEMA_V1
            sidecar["observed_coverage"] = observed_coverage
            sidecar["digestible"] = bool(digestible)
            if total_units is not None:
                sidecar["total_units"] = total_units

        with open(self._coverage_path(full_hash), "w") as f:
            json.dump(sidecar, f, indent=2)
            f.write("\n")
        return True


def record_slug(symlink_name: str) -> str:
    """The digest's name for a record, from its by-name/ symlink.

    The ingester now writes `{slug}.v2.md` alongside the older `{slug}.md`, but
    a digest is still named `{slug}.yaml` - so `Path.stem` yields `{slug}.v2`
    and matches nothing. That silently hid 14 of 46 digests: the record listed
    as undigested, and the Digests tab had nothing to adjudicate. A format
    suffix is not part of the record's identity, so it is stripped."""
    stem = symlink_name[:-3] if symlink_name.endswith(".md") else symlink_name
    return re.sub(r"\.v\d+$", "", stem)


class GitHubIngestSource(IngestSource):
    """Fetches ingests from a private GitHub repository via the API.

    Used in production. Requires a service account token with read
    access to the repository. Not yet implemented.
    """

    def __init__(self, repo: str, token: str):
        self.repo = repo
        self.token = token

    def list_ingests(self) -> list[dict]:
        raise NotImplementedError("GitHubIngestSource is not yet implemented")

    def get_ingest(self, full_hash: str) -> dict | None:
        raise NotImplementedError("GitHubIngestSource is not yet implemented")

    def save_ingest(self, full_hash: str, content: str) -> bool:
        raise NotImplementedError("GitHubIngestSource is not yet implemented")

    def commit_review(self, **kwargs: object) -> None:
        raise NotImplementedError("GitHubIngestSource is not yet implemented")

    def load_verification(self, full_hash: str) -> dict | None:
        raise NotImplementedError("GitHubIngestSource is not yet implemented")

    def load_coverage(self, full_hash: str) -> dict | None:
        raise NotImplementedError("GitHubIngestSource is not yet implemented")

    def append_coverage(self, **kwargs: object) -> bool:
        raise NotImplementedError("GitHubIngestSource is not yet implemented")

    def supersession(self, full_hash: str) -> dict:
        raise NotImplementedError("GitHubIngestSource is not yet implemented")

    def load_highlights(self, full_hash: str) -> dict | None:
        raise NotImplementedError("GitHubIngestSource is not yet implemented")

    def save_highlights(self, **kwargs: object) -> bool:
        raise NotImplementedError("GitHubIngestSource is not yet implemented")

    def save_audit(self, **kwargs: object) -> bool:
        raise NotImplementedError("GitHubIngestSource is not yet implemented")

    def save_roles(self, **kwargs: object) -> bool:
        # Role management is a local-clone (workbench) operation; the static
        # deploy is read-only and cannot commit.
        return False

    def audit_store_dir(self, full_hash: str):
        return None

    def reviewed_by_email(self, email: str) -> dict[str, str]:
        # TODO: query the GitHub REST API for commits authored by this email
        # under store/ in the ingests repo. Returning an empty dict is correct
        # default behaviour - no records show as reviewed until implemented.
        return {}

    def review_history(self, full_hash: str) -> list[dict]:
        # The edge (edge/main.ts) serves this in production via the GitHub commits
        # API; this Python stub is unused there. [] is a safe default.
        return []


def build_source() -> IngestSource:
    """Select the ingest source based on environment variables."""
    remote = os.environ.get("INGESTS_REMOTE")
    token = os.environ.get("GITHUB_TOKEN")
    if remote and token:
        return GitHubIngestSource(remote, token)

    path = Path(os.environ.get("INGESTS_PATH", str(DEFAULT_INGESTS_PATH)))
    return LocalIngestSource(path)


app = FastAPI(title="Anomalica Workbench API")

setup_auth(app)

source: IngestSource = build_source()
records_path = Path(os.environ.get("RECORDS_PATH", str(DEFAULT_RECORDS_PATH)))
ingests_path = Path(os.environ.get("INGESTS_PATH", str(DEFAULT_INGESTS_PATH)))
digests_path = Path(os.environ.get("DIGESTS_PATH", str(DEFAULT_DIGESTS_PATH)))
content_path = Path(os.environ.get("CONTENT_PATH", str(DEFAULT_CONTENT_PATH)))
grading_path = Path(os.environ.get("GRADING_PATH", str(DEFAULT_GRADING_PATH)))
predigests_path = Path(os.environ.get("PREDIGESTS_PATH", str(DEFAULT_PREDIGESTS_PATH)))
prompts_path = Path(os.environ.get("PROMPTS_PATH", str(DEFAULT_PROMPTS_PATH)))

# Two-way sync of the local ingests clone with origin: pull on startup and
# every few minutes (when clean), so localhost never silently drifts from the
# live site. Local-clone mode only - the GitHub source writes upstream anyway.
sync_manager: SyncManager | None = (
    SyncManager(ingests_path) if isinstance(source, LocalIngestSource) else None
)


@app.on_event("startup")
def _start_ingests_sync() -> None:
    if sync_manager is not None:
        sync_manager.start()


@app.get("/api/sync")
def sync_status() -> JSONResponse:
    """Sync state of the local ingests clone vs origin, for the header
    indicator. 404 on deployments without a local clone (the static site
    reads origin-fed snapshots and is in sync by construction)."""
    if sync_manager is None:
        raise HTTPException(status_code=404, detail="Not found")
    return JSONResponse(sync_manager.status())


# Public site base for linking assembled article pages (the live, post-digest layer).
site_base_url = os.environ.get("SITE_BASE_URL", "https://anomalica.is").rstrip("/")

MEDIA_FILENAME_PATTERN = re.compile(r"^[0-9a-f]{12}\.[a-z]{3,4}$")


def _require_user(request: Request) -> dict:
    user = request.session.get("user")
    if not user or not user.get("email"):
        raise HTTPException(status_code=401, detail="Login required")
    return user


def _role_of_user(user: dict | None) -> str:
    """A user's contribution role from `ingests/roles.yaml` (read per request so
    a change takes effect without a restart). Contributor by default and for
    anonymous."""
    return roles.role_of((user or {}).get("login"), ingests_path)


def _role(request: Request) -> str:
    return _role_of_user(request.session.get("user"))


def _require_role(request: Request, minimum: str) -> dict:
    """Require a logged-in user whose role is at least `minimum`. 401 when not
    logged in, 403 when under-privileged."""
    user = _require_user(request)
    if not roles.at_least(_role_of_user(user), minimum):
        raise HTTPException(status_code=403, detail=f"Requires {minimum} role")
    return user


@app.get("/api/me/role")
def my_role(request: Request) -> dict:
    """The logged-in user's contribution role (contributor for anonymous), so the
    UI can show the Review tab and the propose-vs-commit affordance. The role is
    enforced server-side regardless of what the client does with this."""
    return {"role": _role(request)}


# Role management (roles phase 3). Editor-only CRUD over ingests/roles.yaml. A
# change is a real commit to the access-gated ingests repo; the last-editor guard
# stops the file being edited into a state where nobody can manage roles again.


@app.get("/api/roles")
def list_roles(request: Request) -> JSONResponse:
    """The current login -> role map, the role options, and the caller's own
    login (so the UI can flag self-edits). Admin-only."""
    user = _require_role(request, "admin")
    return JSONResponse(
        {
            "roles": roles.load_roles(ingests_path),
            "options": list(roles.ROLES),
            "self": (user.get("login") or "").lower(),
        }
    )


@app.put("/api/roles/{login}")
def set_role(login: str, body: dict, request: Request) -> JSONResponse:
    """Set `login`'s role. Admin-only. Refuses a change that would leave no
    admin (the last-admin lockout guard - admin is the only role that manages
    roles)."""
    admin = _require_role(request, "admin")
    login = (login or "").strip().lower()
    if not login:
        raise HTTPException(status_code=400, detail="Missing login")
    role = body.get("role")
    if role not in roles.ROLES:
        raise HTTPException(status_code=400, detail="Invalid role")
    current = roles.load_roles(ingests_path)
    updated = {**current, login: role}
    if roles.count_admins(current) > 0 and roles.count_admins(updated) == 0:
        raise HTTPException(status_code=400, detail="Cannot remove the last admin")
    if not source.save_roles(updated, admin.get("name", ""), admin.get("email", "")):
        raise HTTPException(status_code=404, detail="Role management unavailable here")
    return JSONResponse({"roles": updated})


@app.delete("/api/roles/{login}")
def remove_role(login: str, request: Request) -> JSONResponse:
    """Remove `login` from the role file (reverts them to the contributor
    default). Admin-only. Refuses removing the last admin."""
    admin = _require_role(request, "admin")
    login = (login or "").strip().lower()
    current = roles.load_roles(ingests_path)
    if login not in current:
        raise HTTPException(status_code=404, detail="Login is not listed")
    updated = {k: v for k, v in current.items() if k != login}
    if roles.count_admins(current) > 0 and roles.count_admins(updated) == 0:
        raise HTTPException(status_code=400, detail="Cannot remove the last admin")
    if not source.save_roles(updated, admin.get("name", ""), admin.get("email", "")):
        raise HTTPException(status_code=404, detail="Role management unavailable here")
    return JSONResponse({"roles": updated})


def _records_held() -> list[dict]:
    """Every record we hold, with how far along the pipeline it is.

    The infrastructure graph names ~800 works and the question about each is
    where it has got to: named by someone else's bibliography, acquired,
    ingested, reviewed, digested. Matching is by title because that is all a
    citation gives us - works are named in prose, not by hash.

    Queued records are included: they have been acquired and ingested but are
    not in the store yet, which is a real stage between "we do not have it" and
    "it is in the corpus".
    """
    held = [
        {
            "title": r.get("title", ""),
            "content_hash": r.get("content_hash"),
            "digested": r.get("digested"),
            "digestible": r.get("digestible"),
            "pipeline_version": r.get("pipeline_version"),
            "pipeline_current": r.get("pipeline_current"),
        }
        for r in source.list_ingests()
    ]
    return held + [{"title": t, "queued": True} for t in source.queued_titles()]


@app.get("/api/infrastructure")
def infrastructure_summary(request: Request) -> JSONResponse:
    """What the infrastructure half of the corpus contains.

    Nothing has read this database since it was created, so the tab's first job
    is to say what is in it - see backend/infrastructure.py.
    """
    _require_user(request)
    return JSONResponse(
        {
            "summary": infrastructure.summary(records_held=_records_held()),
            "records": infrastructure.records(),
        }
    )


@app.get("/api/infrastructure/entities")
def infrastructure_entities(
    request: Request, kind: str = "document", q: str = ""
) -> JSONResponse:
    """Works, people or organisations that infrastructure claims mention."""
    _require_user(request)
    if kind not in infrastructure.BROWSABLE:
        raise HTTPException(status_code=404, detail="Not found")
    held = _records_held() if kind == "document" else None
    return JSONResponse(
        {"entities": infrastructure.entities(kind=kind, query=q, records_held=held)}
    )


@app.get("/api/infrastructure/entities/{node_id}")
def infrastructure_entity(request: Request, node_id: str) -> JSONResponse:
    _require_user(request)
    found = infrastructure.entity(node_id, records_held=_records_held())
    if found is None:
        raise HTTPException(status_code=404, detail="Not found")
    return JSONResponse(found)


@app.get("/api/infrastructure/claims")
def infrastructure_claims(
    request: Request,
    claim_type: str | None = None,
    q: str = "",
    limit: int = 200,
    offset: int = 0,
) -> JSONResponse:
    """The raw claims, non-administrative first."""
    _require_user(request)
    return JSONResponse(
        {
            "claims": infrastructure.claims(
                claim_type=claim_type, query=q, limit=min(limit, 2500), offset=offset
            )
        }
    )


@app.get("/api/speakers")
def list_speakers() -> list[dict]:
    """Speaker names already in use across the corpus, commonest first."""
    return source.known_speakers()


@app.get("/api/ingests")
def list_ingests() -> list[dict]:
    """Return summary metadata for every available ingest.

    This includes the full content hash because the current workbench
    is a single-user development setup. In production this endpoint
    should return only public hashes to non-authenticated callers.
    """
    return source.list_ingests()


_review_queue_cache: dict[str, object] = {}


@app.get("/api/review-queue")
def review_queue() -> JSONResponse:
    """What to read next, best value for attention first.

    Local-only, like the other Python-backed views: it reads the assimilator's
    graph to work out what a record would feed, and a GitHub-backed deployment
    has neither the graph nor a reviewer sitting in front of it.

    Cached on a fingerprint of the graph (including its write-ahead log) and
    the store's mtime, because building the matcher indexes every page-worthy
    node and the answer only changes when one of those two does.
    """
    if not isinstance(source, LocalIngestSource):
        raise HTTPException(status_code=404, detail="Not found")

    graph = review_priority.graph_db_path()
    store = ingests_path / "store"
    key = (
        review_priority.db_fingerprint(graph),
        store.stat().st_mtime_ns if store.exists() else 0,
    )
    if _review_queue_cache.get("key") == key:
        return JSONResponse(_review_queue_cache["value"])  # type: ignore[arg-type]

    # Candidates are what Mark has still to read: not digested, and not already
    # carrying a completed review. A record mid-review stays listed - partial
    # coverage is a reason to finish it, not to hide it.
    wanted = {
        entry["content_hash"]
        for entry in source.list_ingests()
        if entry.get("content_hash")
        and not entry.get("digested")
        and not entry.get("digestible")
    }
    bodies = source.bodies(wanted)
    candidates = list(bodies.items())
    sidecars = {
        content_hash: review_priority.load_sidecar(
            store / f"{content_hash}.housekeeping.json"
        )
        for content_hash in bodies
    }

    page_worthy = review_priority.load_page_worthy(graph)
    ranked = [
        p.as_dict() for p in review_priority.rank(candidates, page_worthy, sidecars)
    ]
    value = {
        "queue": ranked,
        # Stated rather than inferred from an empty result: "no graph" and "no
        # record reaches anything" are different answers and the second is a
        # finding, while the first is a missing input.
        "graph_available": page_worthy.available,
    }
    _review_queue_cache["key"] = key
    _review_queue_cache["value"] = value
    return JSONResponse(value)


@app.get("/api/ingests/archived")
def list_archived_ingests() -> list[dict]:
    """Return summary metadata for archived (store/v1/) records."""
    return source.list_archived_ingests()


@app.post("/api/ingests/{full_hash}/archive")
def archive_ingest(full_hash: str, request: Request) -> JSONResponse:
    """Move a record to the archive (store/v1/). Requires editor role."""
    user = _require_role(request, "editor")
    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")
    if not source.archive_ingest(full_hash, user):
        raise HTTPException(status_code=404, detail="Not found")
    return JSONResponse({"archived": True})


@app.post("/api/ingests/{full_hash}/unarchive")
def unarchive_ingest(full_hash: str, request: Request) -> JSONResponse:
    """Restore a record from the archive back to the active store. Editor role."""
    user = _require_role(request, "editor")
    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")
    if not source.unarchive_ingest(full_hash, user):
        raise HTTPException(status_code=404, detail="Not found")
    return JSONResponse({"unarchived": True})


def list_articles() -> list[dict]:
    """List assembled knowledge-article pages from the content repo for the
    Articles tab. Walks content/pages/<section>/*.en.md, skipping the
    hand-authored static/explainer sections. Entity articles (people,
    organisations, events, ...) link to the public site at /<section>/<slug>/;
    records additionally carry a top-level record_hash (their 56-char stable id)
    so the workbench can deep-link to its own richer inspection view. Every
    content page is public - no access gating applies to this layer."""
    import yaml as _yaml

    pages = content_path / "pages"
    if not pages.is_dir():
        return []
    articles: list[dict] = []
    for section_dir in sorted(pages.iterdir()):
        if not section_dir.is_dir() or section_dir.name in STATIC_PAGE_SECTIONS:
            continue
        section = section_dir.name
        for md in sorted(section_dir.glob("*.en.md")):
            slug = md.name[: -len(".en.md")]
            try:
                match = re.match(r"^---\n(.*?)\n---\n", md.read_text(), re.DOTALL)
                fields = _yaml.safe_load(match.group(1)) if match else None
            except (OSError, _yaml.YAMLError):
                fields = None
            if not isinstance(fields, dict):
                fields = {}
            record_hash = fields.get("record_hash")
            articles.append(
                {
                    "section": section,
                    "slug": slug,
                    "title": fields.get("title") or slug,
                    "description": fields.get("description") or "",
                    "tags": fields.get("tags") or [],
                    "url": f"{site_base_url}/{WORKBENCH_LANG}/{section}/{slug}/",
                    "record_hash": record_hash
                    if isinstance(record_hash, str)
                    else None,
                    "directives": read_article_directives(section, slug),
                }
            )
    return articles


# Article identity for the directive sidecar path. Strict kebab-case so a path
# segment can never escape content/pages/ (no dots, slashes, or "..").
ARTICLE_SECTION_RE = re.compile(r"^[a-z][a-z-]*$")
ARTICLE_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
MAX_DIRECTIVE_LEN = 500


def _article_sidecar_path(section: str, slug: str) -> Path | None:
    """The per-article presentation-directive sidecar, or None if section/slug
    fail the strict kebab-case check."""
    if not ARTICLE_SECTION_RE.match(section) or not ARTICLE_SLUG_RE.match(slug):
        return None
    return content_path / "pages" / section / f"{slug}.directives.yaml"


def read_article_directives(section: str, slug: str) -> list[str]:
    """The presentation directives for one article, from its sidecar (a YAML list
    of strings), or [] if absent/invalid."""
    import yaml as _yaml

    path = _article_sidecar_path(section, slug)
    if path is None or not path.exists():
        return []
    try:
        loaded = _yaml.safe_load(path.read_text())
    except (OSError, _yaml.YAMLError):
        return []
    return [d for d in loaded if isinstance(d, str)] if isinstance(loaded, list) else []


def _clean_directives(raw) -> list[str] | None:
    """Trim, drop blanks, dedupe (order-preserving), length-cap a directive list.
    None if not a list, or any item is a non-string / over the length cap."""
    if not isinstance(raw, list):
        return None
    seen: set[str] = set()
    out: list[str] = []
    for d in raw:
        if not isinstance(d, str):
            return None
        s = d.strip()
        if not s:
            continue
        if len(s) > MAX_DIRECTIVE_LEN:
            return None
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out


@app.get("/api/articles")
def get_articles() -> list[dict]:
    """Assembled knowledge-article pages, read-only listing for the Articles tab."""
    return list_articles()


@app.put("/api/articles/{section}/{slug}/directives")
def set_article_directives(
    section: str, slug: str, body: dict, request: Request
) -> JSONResponse:
    """Write an article's presentation-directive sidecar (local dev; the edge does
    this in production by committing to the content repo). Presentation-only - the
    assembler enforces in-prompt that a directive can never change a fact, and the
    UI labels it. Requires editor role."""
    import yaml as _yaml

    _require_role(request, "editor")
    path = _article_sidecar_path(section, slug)
    if path is None or not path.parent.is_dir():
        raise HTTPException(status_code=404, detail="Not found")
    directives = _clean_directives(body.get("directives"))
    if directives is None:
        raise HTTPException(status_code=400, detail="Invalid directives list")
    path.write_text(
        _yaml.safe_dump(directives, default_flow_style=False, allow_unicode=True)
        if directives
        else "[]\n"
    )
    return JSONResponse({"ok": True, "directives": directives})


@app.get("/api/ingests/{full_hash}")
def get_ingest(full_hash: str) -> JSONResponse:
    """Fetch an ingest by its full SHA-256 hash.

    The hash must be the complete 64-character SHA-256. Partial or
    prefix lookups are never supported. Not-found and malformed-hash
    responses are indistinguishable by design (see architecture doc).
    """
    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")

    ingest = source.get_ingest(full_hash)
    if ingest is None:
        raise HTTPException(status_code=404, detail="Not found")

    return JSONResponse(ingest)


def _hash_to_digest_path(full_hash: str) -> Path | None:
    """Map an ingest content_hash to its matching digest YAML, if one exists.

    The digester writes per-record YAML at ``digests/<name>.yaml``
    where ``<name>`` is the friendly filename used by the ingester's records/
    symlinks (e.g. ``2024-08-19-ebook-imminent-...``). To bridge the two we
    walk the ingest by-name/ symlinks, resolve each to its store/{hash}.md
    target, read the content_hash from frontmatter, and return the matching
    digest path.
    """
    records_dir = ingests_path / "by-name"
    if not records_dir.exists():
        return None
    for symlink in records_dir.glob("*.md"):
        try:
            target = symlink.resolve()
            with open(target) as f:
                frontmatter, _, _ = parse_frontmatter(f.read())
        except OSError:
            continue
        content_hash = normalise_hash(frontmatter.get("content_hash"))
        if content_hash == full_hash:
            # The ingester's by-name/ symlinks carry a version suffix for v2+
            # records (``<name>.v2.md`` -> stem ``<name>.v2``), but the digester
            # writes ``<name>.yaml`` with no suffix. Strip it so v2 audio/video
            # records resolve to their digest instead of 404ing.
            stem = re.sub(r"\.v\d+$", "", symlink.stem)
            yaml_path = digests_path / f"{stem}.yaml"
            if yaml_path.exists():
                return yaml_path
            return None
    return None


# Patterns for node names the extraction model sometimes emits but that are
# unusable downstream (redacted-name "persons", parens-type artefacts). These
# match the deterministic backstop in digester/import_markdown.py so the
# workbench view matches what makes it into the knowledge graph.
_DIGEST_REDACTED_RE = re.compile(r"\([Rr][Ee][Dd][Aa][Cc][Tt][Ee][Dd]\)")
_DIGEST_TYPE_SUFFIX_RE = re.compile(
    r"\s*\((person|organisation|place|event|matter|object|document|concept|record)\)\s*$",
    re.IGNORECASE,
)


def _is_unusable_node_name(name: str) -> bool:
    if not isinstance(name, str):
        return False
    if _DIGEST_REDACTED_RE.search(name):
        return True
    if _DIGEST_TYPE_SUFFIX_RE.search(name):
        return True
    return False


# Deterministic acronym expansions the digester applies at import time. Mirror
# them here so the workbench Digest column shows the same expanded forms as
# the graph.
_WB_SQUADRON_PREFIXES = {
    "VFA": "Strike Fighter Squadron",
    "VMFA": "Marine Fighter Attack Squadron",
    "VAQ": "Electronic Attack Squadron",
    "VAW": "Carrier Airborne Early Warning Squadron",
    "VRC": "Fleet Logistics Support Squadron",
    "HS": "Helicopter Anti-Submarine Squadron",
    "CSG": "Carrier Strike Group",
    "CVW": "Carrier Air Wing",
}
_WB_SQUADRON_RE = re.compile(
    r"\b("
    + "|".join(sorted(_WB_SQUADRON_PREFIXES, key=len, reverse=True))
    + r")-(\d+)\b"
)
_WB_PROGRAMME_EXPANSIONS = {
    "AATIP": "Advanced Aerospace Threat Identification Program",
    "AAWSAP": "Advanced Aerospace Weapon System Applications Program",
    "AARO": "All-Domain Anomaly Resolution Office",
}


def _wb_expand_squadron(match: "re.Match[str]") -> str:
    prefix, number = match.group(1), match.group(2)
    full = _WB_SQUADRON_PREFIXES[prefix]
    return f"{full} {number} ({prefix}-{number})"


# Universal acronyms - mirrors SAFE_ACRONYMS in
# digester/workspace/digester/extract.py. Kept in sync by hand;
# if you change one, change the other.
_WB_UNIVERSAL_ACRONYMS = {
    "UFO",
    "UAP",
    "CIA",
    "FBI",
    "NSA",
    "NASA",
    "DOD",
    "DoD",
    "FAA",
    "NATO",
    "UN",
    "EU",
    "US",
    "USA",
    "UK",
    "USSR",
    "GPS",
    "TV",
    "CPU",
    "GPU",
    "USB",
    "URL",
    "API",
}


def _collapse_nested_acronym_parens(name: str) -> str:
    """Reduce "X (Y (ACRONYM))" -> "X (ACRONYM)".

    The extraction model occasionally emits self-nested expansions like
    "All-domain Anomaly Resolution Office (All-Domain Anomaly Resolution
    Office (AARO))". This collapses any number of nesting layers down to a
    single "Full Form (ACRONYM)" form.
    """
    if not isinstance(name, str):
        return name
    pattern = re.compile(r"\(\s*[^()]+?\s*\(([A-Z0-9][A-Z0-9-]+)\)\s*\)")
    prev = None
    out = name
    while prev != out:
        prev = out
        out = pattern.sub(lambda m: f"({m.group(1)})", out)
    return out


def _reduce_universal_expansions(text: str) -> str:
    """Reduce "Full Form (UNIVERSAL_ACRONYM)" -> "UNIVERSAL_ACRONYM".

    Universally-known acronyms (UFO, UAP, CIA, FBI, NASA etc.) don't need to
    carry their full form in either node names or claim text. When the model
    has expanded one anyway, collapse "Unidentified Flying Object (UFO)" to
    just "UFO".
    """
    if not isinstance(text, str):
        return text
    out = text
    for acro in _WB_UNIVERSAL_ACRONYMS:
        # Match capitalised-word expansion immediately before "(ACRONYM)".
        # The expansion can include hyphens, spaces, slashes; it should not
        # span sentence punctuation.
        out = re.sub(
            rf"[A-Z][A-Za-z][A-Za-z\- /]{{0,80}}?\s*\({acro}\)",
            acro,
            out,
        )
    return out


def _normalise_name(name: str) -> str:
    if not isinstance(name, str):
        return name
    out = _collapse_nested_acronym_parens(name)
    out = _reduce_universal_expansions(out)
    if not any(full in out for full in _WB_SQUADRON_PREFIXES.values()):
        out = _WB_SQUADRON_RE.sub(_wb_expand_squadron, out)
    for acro, full in _WB_PROGRAMME_EXPANSIONS.items():
        # Case-insensitive substring check so "All-domain Anomaly Resolution
        # Office" counts as already-expanded for "All-Domain Anomaly Resolution
        # Office".
        if full.lower() in out.lower():
            continue
        # (?<!\() prevents matching an acronym that is already inside a
        # parenthetical-acronym pattern like "(AARO)".
        out = re.sub(
            rf"(?<!\()\b{acro}\b(?!-\d|\))",
            f"{full} ({acro})",
            out,
        )
    out = out.replace("—", " - ").replace("–", "-")
    out = re.sub(r" {2,}", " ", out)
    return out


_ACRONYM_SUFFIX_RE = re.compile(r"\s*\(([A-Z0-9][A-Z0-9-]{1,}[A-Z0-9])\)\s*$")


def _equivalence_key(name: str) -> str:
    """Lowercase, acronym-suffix-stripped key for matching equivalent names."""
    if not isinstance(name, str):
        return ""
    return _ACRONYM_SUFFIX_RE.sub("", name).lower().strip()


# Month-name -> 2-digit ISO month, mirrors digester/import_markdown.py.
_WB_MONTH_NAMES = {
    "january": "01",
    "february": "02",
    "march": "03",
    "april": "04",
    "may": "05",
    "june": "06",
    "july": "07",
    "august": "08",
    "september": "09",
    "october": "10",
    "november": "11",
    "december": "12",
}
_WB_SPELLED_DATE_DAY_RE = re.compile(
    r"\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b",
    re.IGNORECASE,
)
_WB_SPELLED_DATE_MY_RE = re.compile(
    r"\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b",
    re.IGNORECASE,
)


def _wb_normalise_spelled_dates(name: str) -> str:
    if not isinstance(name, str):
        return name

    def _d(m):
        return (
            f"{m.group(3)}-{_WB_MONTH_NAMES[m.group(2).lower()]}-{int(m.group(1)):02d}"
        )

    def _my(m):
        return f"{m.group(2)}-{_WB_MONTH_NAMES[m.group(1).lower()]}"

    return _WB_SPELLED_DATE_MY_RE.sub(_my, _WB_SPELLED_DATE_DAY_RE.sub(_d, name))


def _wb_codename_roots(codenames):
    roots = set()
    for cn in codenames:
        if not cn:
            continue
        tokens = cn.strip().split()
        first = tokens[0] if tokens else ""
        if first and (first.isupper() or first[0].isupper()) and len(first) >= 4:
            roots.add(first)
        roots.add(cn)
    return roots


def _wb_build_terminology_enforcers(terminology):
    if not terminology:
        return set(), {}
    raw_codenames = {
        (c.get("codename") or "").strip()
        for c in (terminology.get("codenames") or [])
        if c.get("codename")
    }
    codenames = _wb_codename_roots(raw_codenames)
    expansions = {}
    for a in terminology.get("acronyms") or []:
        acro = (a.get("acronym") or "").strip()
        full = (a.get("expansion") or "").strip()
        if not (acro and full):
            continue
        if "(" in full:
            continue  # descriptive, not lexical (e.g. SSN-724 hull number)
        if re.search(r"-\d", acro):
            continue  # designator, handled by squadron normaliser
        if acro in _WB_UNIVERSAL_ACRONYMS:
            continue  # universally known - expanding adds noise
        expansions[acro] = f"{full} ({acro})"
    return codenames, expansions


def _wb_apply_doc_terminology(name, codenames, expansions):
    if not name or not isinstance(name, str):
        return name, None
    for cn in codenames:
        if cn and re.search(rf"\b{re.escape(cn)}\b", name):
            return name, f"codename '{cn}'"
    out = _collapse_nested_acronym_parens(name)
    for acro in sorted(expansions, key=len, reverse=True):
        full = expansions[acro]  # "Full Form (ACRONYM)"
        # Case-insensitive "is already there".
        if full.lower() in out.lower():
            continue
        # Also skip if the name CONTAINS the bare full-form (without the
        # paren-acronym suffix), in which case we want the append-suffix
        # pass below to add "(ACRONYM)" rather than re-substituting.
        bare_full = full[: full.rfind("(")].strip()
        if bare_full.lower() in out.lower():
            continue
        out = re.sub(
            rf"(?<!\()\b{re.escape(acro)}\b(?!-\d|\))",
            full,
            out,
            count=1,
        )

    # If the name exactly matches the bare full form of a known acronym,
    # append "(ACRONYM)". So "National Geospatial-Intelligence Agency" gets
    # the "(NGA)" suffix when NGA is in the document's acronym map.
    for acro in sorted(expansions, key=len, reverse=True):
        full = expansions[acro]
        bare_full = full[: full.rfind("(")].strip()
        if bare_full.lower() == out.lower() and f"({acro})" not in out:
            out = f"{bare_full} ({acro})"
            break

    out = _wb_normalise_spelled_dates(out)
    return out, None


def _filter_digest(digest: dict) -> dict:
    """Strip rejected nodes and references to them, expand bare acronyms in
    surviving names, and collapse X / X (ACRONYM) duplicates within this
    digest. Mirrors the import-time normalisation so the Digest column and
    the knowledge graph agree."""
    codenames, doc_acronyms = _wb_build_terminology_enforcers(digest.get("terminology"))

    # Compiled once per digest, not once per claim. These patterns depend only
    # on the document's acronym table, and rebuilding them inside the per-claim
    # loop cost 1.15M re.escape calls and 700k searches on a book-length digest
    # - most of the eleven seconds the endpoint took to answer.
    #
    # Longest acronym first, so "AATIP" is matched before "ATIP" would eat it.
    acronym_rules = []
    for acro in sorted(doc_acronyms, key=len, reverse=True):
        full = doc_acronyms[acro]  # form: "Full Form (ACRONYM)"
        full_no_paren = full[: full.rfind("(")].strip()
        # Any case variant of the full form, with hyphens and spaces treated
        # alike, but the parenthetical acronym matched exactly.
        case_insensitive_full = (
            re.escape(full_no_paren).replace(r"\ ", r"[-\s]")
            + rf"\s*\({re.escape(acro)}\)"
        )
        acronym_rules.append(
            (
                acro,
                full,
                re.compile(case_insensitive_full, re.IGNORECASE),
                # A bare acronym: not already inside parens, not part of a
                # hyphenated designator.
                re.compile(rf"(?<!\(){re.escape(acro)}(?![\)\w-])"),
            )
        )

    # Normalise the terminology block too so the header strip shows the same
    # cleaned-up names the body claims use.
    term = digest.get("terminology")
    if term:
        new_term = dict(term)
        for key in ("main_matter", "main_event"):
            v = new_term.get(key)
            if isinstance(v, dict) and v.get("name"):
                cleaned, _ = _wb_apply_doc_terminology(
                    _normalise_name(v["name"]), codenames, doc_acronyms
                )
                new_term[key] = {**v, "name": cleaned}
        digest = {**digest, "terminology": new_term}

    raw_nodes = digest.get("nodes") or []
    bad_ids: set[str] = set()
    bad_names: set[str] = set()
    name_rewrites: dict[str, str] = {}
    intermediate_nodes: list[dict] = []
    for n in raw_nodes:
        name = n.get("name") if isinstance(n, dict) else None
        if name and _is_unusable_node_name(name):
            if n.get("id"):
                bad_ids.add(n["id"])
            bad_names.add(name)
            continue
        if name:
            new_name = _normalise_name(name)
            if new_name != name:
                name_rewrites[name] = new_name
                n = {**n, "name": new_name}
        intermediate_nodes.append(n)

    # Collapse duplicates within this digest. Group by equivalence key and
    # pick the canonical form per group: prefer a name that already includes
    # the acronym in parens ("Carrier Air Wing 11 (CVW-11)"); fall back to
    # the longest name as a proxy for "most informative". Other names in the
    # group are redirected via name_rewrites and their ids fold into the
    # canonical id so claim refs/speakers still resolve.
    groups: dict[str, list[dict]] = {}
    for n in intermediate_nodes:
        key = _equivalence_key(n.get("name", ""))
        if not key:
            groups.setdefault(f"__keyless__{id(n)}", []).append(n)
        else:
            groups.setdefault(key, []).append(n)

    # Apply per-document terminology AFTER the global normalisation. If a node
    # matches a codename it goes onto the reject list; otherwise its name is
    # expanded with per-doc acronyms and spelled-out dates normalised to ISO.
    final_intermediate: list[dict] = []
    for n in intermediate_nodes:
        if not isinstance(n, dict):
            final_intermediate.append(n)
            continue
        name = n.get("name")
        if not name:
            final_intermediate.append(n)
            continue
        rewritten, reject = _wb_apply_doc_terminology(name, codenames, doc_acronyms)
        if reject:
            if n.get("id"):
                bad_ids.add(n["id"])
            bad_names.add(name)
            continue
        if rewritten != name:
            name_rewrites[name] = rewritten
            n = {**n, "name": rewritten}
        final_intermediate.append(n)
    intermediate_nodes = final_intermediate

    # Rebuild groups after the rewrite (rewrites may have collapsed pairs).
    groups = {}
    for n in intermediate_nodes:
        key = _equivalence_key(n.get("name", ""))
        if not key:
            groups.setdefault(f"__keyless__{id(n)}", []).append(n)
        else:
            groups.setdefault(key, []).append(n)

    kept_nodes: list[dict] = []
    id_redirect: dict[str, str] = {}
    for group in groups.values():
        if len(group) == 1:
            kept_nodes.append(group[0])
            continue

        # Pick canonical: parenthetical-acronym preferred, then longest name.
        def _score(node: dict) -> tuple[int, int]:
            name = node.get("name", "")
            has_parens = bool(_ACRONYM_SUFFIX_RE.search(name))
            return (1 if has_parens else 0, len(name))

        canonical = max(group, key=_score)
        kept_nodes.append(canonical)
        canonical_name = canonical.get("name", "")
        canonical_id = canonical.get("id")
        for other in group:
            if other is canonical:
                continue
            other_name = other.get("name", "")
            other_id = other.get("id")
            if other_name and other_name != canonical_name:
                name_rewrites[other_name] = canonical_name
            if other_id and canonical_id and other_id != canonical_id:
                id_redirect[other_id] = canonical_id

    digest = {**digest, "nodes": kept_nodes}

    def _rewrite_ref(r):
        if not isinstance(r, dict):
            return r
        out = dict(r)
        rid = out.get("id")
        if rid in id_redirect:
            out["id"] = id_redirect[rid]
        name = out.get("name")
        if name in name_rewrites:
            out["name"] = name_rewrites[name]
        return out

    def _clean_refs(refs):
        out = []
        for r in refs or []:
            if not isinstance(r, dict):
                out.append(r)
                continue
            if r.get("id") in bad_ids or r.get("name") in bad_names:
                continue
            out.append(_rewrite_ref(r))
        return out

    def _normalise_claim_text(text):
        """Apply per-doc acronym expansion + dedup + ISO date normalisation to
        claim prose. Does NOT touch quote text - the verbatim source excerpt
        is preserved as-is for attribution.

        Rules within a single claim:
        - Expand each acronym on FIRST use only (bare ACRONYM not already
          paired with its full form).
        - DEDUPE subsequent "Full Form (ACRONYM)" patterns down to bare
          "ACRONYM" so the same acronym is not expanded multiple times in
          one claim.
        - Normalise spelled-out months to ISO format.
        """
        if not isinstance(text, str) or not text:
            return text
        out = text

        for acro, full, full_re, bare_re in acronym_rules:
            # Step A - find the first BARE acronym (not already in parens,
            # not part of hyphen designator). If it comes before any
            # full-form occurrence (any case), expand it.
            first_full = full_re.search(out)
            first_full_pos = first_full.start() if first_full else -1
            m = bare_re.search(out)
            if m and (first_full_pos == -1 or m.start() < first_full_pos):
                out = out[: m.start()] + full + out[m.end() :]

            # Step B - dedupe case-insensitively. Walk all matches of the
            # case-insensitive "Full Form (ACRONYM)" pattern; keep the first,
            # reduce each subsequent occurrence to just the bare ACRONYM.
            matches = list(full_re.finditer(out))
            for m in reversed(matches[1:]):
                out = out[: m.start()] + acro + out[m.end() :]

        # Reduce universal expansions: "Unidentified Flying Object (UFO)" -> "UFO".
        out = _reduce_universal_expansions(out)

        # ASCII punctuation: em-dash / en-dash -> " - "
        out = out.replace("—", " - ").replace("–", "-")
        # Collapse the doubled spaces that the em-dash substitution can
        # produce when the dash already had spaces around it.
        out = re.sub(r" {2,}", " ", out)

        out = _wb_normalise_spelled_dates(out)
        return out

    for section in ("domain_claims", "infrastructure_claims"):
        claims = digest.get(section) or []
        cleaned = []
        for c in claims:
            if not isinstance(c, dict):
                cleaned.append(c)
                continue
            spk = c.get("speaker")
            if isinstance(spk, dict):
                if spk.get("id") in bad_ids or spk.get("name") in bad_names:
                    c = {**c, "speaker": None}
                    c.pop("speaker")
                else:
                    c = {**c, "speaker": _rewrite_ref(spk)}
            c = {**c, "refs": _clean_refs(c.get("refs"))}
            if not c["refs"]:
                c.pop("refs")
            # Normalise claim text (acronyms + ISO dates). Quote is left raw.
            if c.get("text"):
                new_text = _normalise_claim_text(c["text"])
                if new_text != c["text"]:
                    c = {**c, "text": new_text}
            cleaned.append(c)
        digest = {**digest, section: cleaned}
    return digest


@app.get("/api/ingests/{full_hash}/digest")
def get_digest(full_hash: str) -> JSONResponse:
    """Fetch the digester's YAML output for an ingest by its full SHA-256.

    Returns the parsed digest document directly, or 404 if no digest has
    been produced for this record. Filters out node names the deterministic
    importer rejects (redacted-persons, parens-type artefacts) so this view
    matches the knowledge graph. The schema is `anomalica/digest/1` - see
    anomalica/architecture/digest-format.md and decision 0027 in the
    meta-repo.
    """
    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")

    yaml_path = _hash_to_digest_path(full_hash)
    if yaml_path is None:
        raise HTTPException(status_code=404, detail="No digest for record")

    try:
        return JSONResponse(_read_digest(yaml_path))
    except Exception as exc:
        raise HTTPException(
            status_code=500, detail=f"Failed to parse digest: {exc}"
        ) from exc


#: Filtered digests, keyed by path and invalidated by the file's own mtime and
#: size. A book-length digest is 3.5MB of YAML and the same reviewer opens the
#: same one repeatedly - re-reading and re-filtering it each time is seconds of
#: work to produce a byte-identical answer. Small, because a handful of records
#: are in play at once and each entry is a parsed document.
_DIGEST_CACHE: OrderedDict[tuple, dict] = OrderedDict()
_DIGEST_CACHE_MAX = 8


def _read_digest(yaml_path) -> dict:
    """Parse and filter one digest, reusing the last result while the file on
    disk is unchanged.

    The C YAML loader where libyaml is available: it parses the largest digest
    in 0.8s against 5.4s for the pure-Python one, which is most of the wait
    before anything appears on screen. It is the same parser semantically -
    `safe_load` with a faster scanner - and falls back when absent.
    """
    stat = os.stat(yaml_path)
    key = (str(yaml_path), stat.st_mtime_ns, stat.st_size)
    cached = _DIGEST_CACHE.get(key)
    if cached is not None:
        _DIGEST_CACHE.move_to_end(key)
        return cached

    import yaml as _yaml

    try:
        loader = _yaml.CSafeLoader
    except AttributeError:
        loader = _yaml.SafeLoader
    with open(yaml_path) as f:
        digest = _yaml.load(f, Loader=loader) or {}

    filtered = _filter_digest(digest)
    _DIGEST_CACHE[key] = filtered
    while len(_DIGEST_CACHE) > _DIGEST_CACHE_MAX:
        _DIGEST_CACHE.popitem(last=False)
    return filtered


def _hash_to_friendly_name(full_hash: str) -> str | None:
    """The digester's friendly record name (stem, version suffix stripped) for an
    ingest content_hash - the key under which its digest and variants are filed.
    None if no ingest record matches the hash."""
    records_dir = ingests_path / "by-name"
    if not records_dir.exists():
        return None
    for symlink in records_dir.glob("*.md"):
        try:
            with open(symlink.resolve()) as f:
                frontmatter, _, _ = parse_frontmatter(f.read())
        except OSError:
            continue
        if normalise_hash(frontmatter.get("content_hash")) == full_hash:
            return re.sub(r"\.v\d+$", "", symlink.stem)
    return None


# In-process cache of the CLUSTERED audit payload (pre-gold), keyed on the
# variant files' stat signature plus the similarity identity. Re-opening an
# unchanged record returns in ~ms instead of re-parsing every variant YAML and
# re-clustering (the two costs Mark saw as "slow to load"). The gold sidecar is
# attached fresh on every request, never cached, so a verdict written between
# opens shows immediately. Bounded, FIFO-evicted; cleared on any --reload restart.
_AUDIT_PAYLOAD_CACHE: "OrderedDict[tuple, dict]" = OrderedDict()
_AUDIT_CACHE_MAX = 32
# How long a single warm() (embed the whole claim-text set in one round trip) may
# take before the audit degrades to lexical for that open. A record already warm
# in the assimilator's persistent cache returns cached vectors well inside this;
# a not-yet-warmed record hits it, raises, and we fall back rather than block the
# request thread for the minutes a cold 2000-claim embed would take. The next
# open, after the cache is warm, builds embedding and pins it.
_AUDIT_EMBED_TIMEOUT_S = 30.0


def _resolve_similarity_threshold() -> float:
    """The cosine cut for "same fact", resolved once so the value we CLUSTER with
    is the value we STAMP into the gold - a verdict is on clusters a specific
    (space, threshold) produced. Env override for tuning without a redeploy."""
    from anomalica_common.embedding_client import DEFAULT_THRESHOLD

    raw = os.environ.get("ANOMALICA_SIMILARITY_THRESHOLD")
    try:
        return float(raw) if raw else DEFAULT_THRESHOLD
    except ValueError:
        return DEFAULT_THRESHOLD


def _audit_prose(full_hash: str) -> str:
    """The record's pre-digest as one whitespace-normalised string - the text
    claim quotes are located in, so passages follow the document rather than the
    model-reported timecodes. Empty when the record cannot be read, which falls
    the audit back to the location axis rather than failing."""
    from backend.audit import normalise_source

    try:
        ingest = source.get_ingest(full_hash)
        body = ingest.get("body") if isinstance(ingest, dict) else None
        if not body:
            return ""
        return normalise_source(pre_digest.materialise(body))
    except Exception:
        return ""


def _build_audit_payload(name: str, prose: str = "") -> dict:
    """The clustered audit payload for a record, embedding-clustered when the
    assimilator's endpoint is reachable and lexically clustered when it is not.

    Similarity is the assimilator's fastembed Qwen3 cosine, reached over HTTP
    through anomalica_common.embedding_client - never by importing the model into
    this process (a second vector space free to drift from theirs). The whole
    claim-text set is embedded in ONE warm() so the per-pair path is in-process
    dot products; if the endpoint is down or a cold record's warm exceeds the
    budget, the build degrades to the lexical placeholder and says so in the
    payload's `similarity` block, rather than failing the view.

    Cached against (variant signature, method, threshold): the embedding payload,
    once built, stays valid until a variant file changes, independent of the
    endpoint's later state."""
    from anomalica_common.embedding_client import (
        EmbeddingCache,
        EmbeddingUnavailable,
        embedding_similar,
    )

    from backend.audit_load import (
        audit_payload,
        load_record_variants,
        variant_signature,
    )
    from backend.audit_similarity import lexical_similar

    threshold = _resolve_similarity_threshold()
    sig = variant_signature(digests_path, name)

    # Prefer a cached embedding payload - valid regardless of the endpoint's
    # current state, since it was clustered from the same unchanged files.
    embed_key = (sig, "embedding", threshold, bool(prose))
    hit = _AUDIT_PAYLOAD_CACHE.get(embed_key)
    if hit is None:
        hit = _AUDIT_PAYLOAD_CACHE.get((sig, "lexical", None, bool(prose)))
    if hit is not None:
        _AUDIT_PAYLOAD_CACHE.move_to_end(
            embed_key
            if embed_key in _AUDIT_PAYLOAD_CACHE
            else (sig, "lexical", None, bool(prose))
        )
        return dict(hit)  # new top-level dict; nested passages shared read-only

    variants = load_record_variants(digests_path, name)
    cache = EmbeddingCache(timeout=_AUDIT_EMBED_TIMEOUT_S)
    try:
        # One round trip embeds every claim; a not-yet-warmed record trips the
        # timeout and drops us to the lexical branch.
        cache.warm(c.text for v in variants for c in v.claims)
        similar = embedding_similar(threshold=threshold, cache=cache)
        payload = audit_payload(variants, similar, prose)
        method, model_id = "embedding", cache.model_id
    except EmbeddingUnavailable:
        payload = audit_payload(variants, lexical_similar(), prose)
        method, model_id = "lexical", None

    payload["similarity"] = {
        "method": method,
        "model_id": model_id,
        "threshold": threshold,
        # A lexical build is an APPROXIMATION the reviewer must know about: the
        # singleton/overlap structure is real but the meaning-merge is crude, so
        # the view flags it and (downstream) gold recorded against it is not a
        # verdict on the embedding space.
        "degraded": method == "lexical",
    }
    key = embed_key if method == "embedding" else (sig, "lexical", None, bool(prose))
    _AUDIT_PAYLOAD_CACHE[key] = payload
    _AUDIT_PAYLOAD_CACHE.move_to_end(key)
    while len(_AUDIT_PAYLOAD_CACHE) > _AUDIT_CACHE_MAX:
        _AUDIT_PAYLOAD_CACHE.popitem(last=False)
    return dict(payload)


@app.get("/api/ingests/{full_hash}/audit")
def get_audit(full_hash: str, request: Request) -> JSONResponse:
    """The model/digest audit view for a record: every extraction variant's
    claims, grouped by source passage and clustered by meaning, with singleton
    flags, per-variant cost, and the reviewer's adjudication gold attached.
    Reviewer-gated (an internal quality tool). 404 when no variant exists.

    Clustering is the assimilator's embedding-cosine similarity, with a lexical
    fallback when the endpoint is unreachable - the payload's `similarity` block
    says which ran.
    """
    _require_role(request, "reviewer")
    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")
    name = _hash_to_friendly_name(full_hash)
    if name is None:
        raise HTTPException(status_code=404, detail="Unknown record")

    try:
        payload = _build_audit_payload(name, _audit_prose(full_hash))
    except Exception as exc:
        raise HTTPException(
            status_code=500, detail=f"Failed to build audit: {exc}"
        ) from exc
    if not payload["variants"]:
        raise HTTPException(status_code=404, detail="No extraction variants for record")
    payload["record"] = {"hash": full_hash, "friendly_name": name}
    _attach_audit_gold(full_hash, payload)
    return JSONResponse(payload)


# Pending audit-gold commits, keyed by path so repeated verdicts on one record
# collapse into a single commit. A timer per path, restarted on each write.
_AUDIT_COMMIT_TIMERS: dict[str, object] = {}
_AUDIT_COMMIT_DELAY_S = 4.0


def _schedule_audit_commit(
    source_obj, path, message: str, author_name: str, author_email: str
) -> None:
    import threading

    key = str(path)
    existing = _AUDIT_COMMIT_TIMERS.pop(key, None)
    if existing is not None:
        try:
            existing.cancel()  # type: ignore[attr-defined]
        except Exception:
            pass

    def run() -> None:
        _AUDIT_COMMIT_TIMERS.pop(key, None)
        try:
            source_obj._git_commit_paths(
                [path], message, author_name=author_name, author_email=author_email
            )
        except Exception:
            # A failed commit must not take the process down; the file is
            # already written and the next verdict will schedule another.
            pass

    timer = threading.Timer(_AUDIT_COMMIT_DELAY_S, run)
    timer.daemon = True
    _AUDIT_COMMIT_TIMERS[key] = timer
    timer.start()


def _attach_audit_gold(full_hash: str, payload: dict) -> None:
    """Attach the v2 gold: the raw claim verdicts and cluster best-ofs, keyed
    for the client by (variant, claim_id). Matching a verdict onto the DISPLAYED
    run is the client's job (it has the claims in hand); re-match across
    re-digests anchors on quote/location/text. v2 has no stored `missed` - the
    client derives missed-fact from cluster membership."""
    store_dir = source.audit_store_dir(full_hash)
    gold = (
        audit_gold.read(store_dir, full_hash)
        if store_dir is not None
        else audit_gold.empty(full_hash)
    )
    payload["gold"] = {
        "claims": gold.get("claims", []),
        "clusters": gold.get("clusters", []),
        "nodes": gold.get("nodes", []),
    }


def _record_model_set(full_hash: str) -> list[dict]:
    """The variant set on disk for a record: [{variant, model, prompt_sha}].
    Variant stems are `{model}.{prompt_sha8}` - the sha IS the identity; a
    model name alone is only comparable within one sha."""
    name = _hash_to_friendly_name(full_hash)
    if not name:
        return []
    out = []
    for f in sorted((digests_path / "variants" / name).glob("*.yaml")):
        model, _, sha = f.stem.partition(".")
        out.append({"variant": f.stem, "model": model, "prompt_sha": sha})
    return out


def _audit_write(
    full_hash: str, request: Request, kind: str, body: dict
) -> JSONResponse:
    """Shared v2 gold write: validate one claim/cluster entry, stamp the
    reviewer, upsert, save + commit. Reviewer-gated - this is scored gold."""
    user = _require_role(request, "reviewer")
    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")
    store_dir = source.audit_store_dir(full_hash)
    if store_dir is None:
        raise HTTPException(status_code=404, detail="Unknown record")
    error = (
        audit_gold.validate_claim(body)
        if kind == "claim"
        else audit_gold.validate_cluster(body)
    )
    if error:
        raise HTTPException(status_code=400, detail=error)
    body["reviewed_by"] = user.get("email", "")
    body["reviewed_at"] = datetime.now(dt_timezone.utc).isoformat(timespec="seconds")
    gold = audit_gold.read(store_dir, full_hash)
    # Stamp the record's variant set (spec-required `models`) from the variants
    # actually on disk - authoritative, no client involvement. Refreshed on
    # every write so a later variant run shows up.
    gold["models"] = _record_model_set(full_hash)
    if kind == "claim":
        # The carry-forward identity, computed with the digester's OWN function
        # so the two sides cannot drift on what "the same claim" means. Only
        # possible when the client supplied claim_type; anchors remain the
        # fallback for entries without it.
        # The client sends the claim EXACTLY as the digest YAML serves it, and
        # fingerprint_of_claim (anomalica-common 698299a) does the field mapping
        # internally - so the mapping is shared, not just the hash. Hand-mapping
        # here was the drift surface the digester caught: one mismatched field
        # and every fingerprint diverges silently, no verdict ever matches. The
        # raw claim is popped, not stored - text/quote/location already carry
        # the human-readable anchors.
        raw_claim = body.pop("claim", None)
        try:
            from anomalica_common.digest import fingerprint_of_claim

            if isinstance(raw_claim, dict):
                body["claim_fingerprint"] = fingerprint_of_claim(raw_claim)
        except ImportError:
            pass
        audit_gold.upsert_claim(gold, body)
    else:
        audit_gold.upsert_cluster(gold, body)
    if not source.save_audit(full_hash, gold, user["name"], user["email"]):
        raise HTTPException(status_code=404, detail="Not found")
    return JSONResponse({"saved": True, "gold_id": body["gold_id"]})


@app.put("/api/ingests/{full_hash}/audit/claim")
def put_audit_claim(full_hash: str, body: dict, request: Request) -> JSONResponse:
    """Create or update one claim verdict (quality and/or irrelevant) -
    anomalica/audit/2. Absent gold_id: identity falls back to (variant,
    claim_id), so re-judging updates rather than duplicates."""
    return _audit_write(full_hash, request, "claim", body)


@app.put("/api/ingests/{full_hash}/audit/claims")
def put_audit_claims(full_hash: str, body: dict, request: Request) -> JSONResponse:
    """Record MANY claim verdicts in one write - anomalica/audit/2.

    Grading is done in bursts: a reviewer works down a passage marking claims
    and only then moves on. One request (and one commit) per keystroke made the
    git log a keystroke log and put a round trip between the reviewer and their
    next decision. The batch is validated whole - a single bad entry rejects the
    lot rather than half-writing it - then upserted and saved once."""
    user = _require_role(request, "reviewer")
    entries = body.get("claims")
    if not isinstance(entries, list) or not entries:
        raise HTTPException(status_code=400, detail="claims must be a non-empty list")
    for e in entries:
        if not isinstance(e, dict):
            raise HTTPException(status_code=400, detail="each claim must be an object")
        problem = audit_gold.validate_claim(e)
        if problem:
            raise HTTPException(status_code=400, detail=problem)

    store_dir = source.audit_store_dir(full_hash)
    if store_dir is None:
        raise HTTPException(status_code=404, detail="Unknown record")
    gold = audit_gold.read(store_dir, full_hash) or audit_gold.empty(full_hash)
    gold["models"] = _record_model_set(full_hash)

    saved = []
    for e in entries:
        entry = dict(e)
        raw_claim = entry.pop("claim", None)
        if isinstance(raw_claim, dict):
            from anomalica_common.digest import fingerprint_of_claim

            entry["claim_fingerprint"] = fingerprint_of_claim(raw_claim)
        entry["reviewed_by"] = user.get("email", "")
        entry["reviewed_at"] = datetime.now(dt_timezone.utc).isoformat(
            timespec="seconds"
        )
        saved.append(audit_gold.upsert_claim(gold, entry))

    if not source.save_audit(full_hash, gold, user["name"], user["email"]):
        raise HTTPException(status_code=500, detail="Could not save audit gold")
    # An explicit save commits now: the reviewer has said they are done, so the
    # commit should not wait on a debounce meant for incidental writes.
    commit_now = getattr(source, "commit_audit_now", None)
    if callable(commit_now):
        commit_now(full_hash, user["name"], user["email"])
    return JSONResponse(
        {"saved": len(saved), "gold_ids": [e.get("gold_id") for e in saved]}
    )


@app.put("/api/ingests/{full_hash}/audit/nodes")
def put_audit_nodes(full_hash: str, body: dict, request: Request) -> JSONResponse:
    """Record entity verdicts - one write, one commit, like the claim batch."""
    user = _require_role(request, "reviewer")
    entries = body.get("nodes")
    if not isinstance(entries, list) or not entries:
        raise HTTPException(status_code=400, detail="nodes must be a non-empty list")
    for e in entries:
        if not isinstance(e, dict):
            raise HTTPException(status_code=400, detail="each node must be an object")
        problem = audit_gold.validate_node(e)
        if problem:
            raise HTTPException(status_code=400, detail=problem)

    store_dir = source.audit_store_dir(full_hash)
    if store_dir is None:
        raise HTTPException(status_code=404, detail="Unknown record")
    gold = audit_gold.read(store_dir, full_hash) or audit_gold.empty(full_hash)
    gold["models"] = _record_model_set(full_hash)
    for e in entries:
        entry = dict(e)
        entry["reviewed_by"] = user.get("email", "")
        entry["reviewed_at"] = datetime.now(dt_timezone.utc).isoformat(
            timespec="seconds"
        )
        audit_gold.upsert_node(gold, entry)
    if not source.save_audit(full_hash, gold, user["name"], user["email"]):
        raise HTTPException(status_code=500, detail="Could not save audit gold")
    commit_now = getattr(source, "commit_audit_now", None)
    if callable(commit_now):
        commit_now(full_hash, user["name"], user["email"])
    return JSONResponse({"saved": len(entries)})


@app.put("/api/ingests/{full_hash}/audit/cluster")
def put_audit_cluster(full_hash: str, body: dict, request: Request) -> JSONResponse:
    """Create or update one cluster best-of choice - anomalica/audit/2. An
    entry without best_variant records nothing worth scoring; clients should
    simply not send a skip."""
    return _audit_write(full_hash, request, "cluster", body)


@app.delete("/api/ingests/{full_hash}/audit/verdict/{gold_id}")
def delete_audit_verdict(
    full_hash: str, gold_id: str, request: Request
) -> JSONResponse:
    """Remove one adjudication by gold_id. Reviewer-gated."""
    user = _require_role(request, "reviewer")
    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")
    store_dir = source.audit_store_dir(full_hash)
    if store_dir is None:
        raise HTTPException(status_code=404, detail="Unknown record")
    gold = audit_gold.read(store_dir, full_hash)
    if not audit_gold.remove(gold, gold_id):
        raise HTTPException(status_code=404, detail="No such adjudication")
    source.save_audit(full_hash, gold, user["name"], user["email"])
    return JSONResponse({"deleted": True})


# --- Knowledge-graph review (read-only over the assimilator DB) ----------
# Surfaces the assimilator's merged entity graph for human inspection - above
# all the merge decisions (a node's aliases), so a bad merge is reviewable.


# --- Topic and page management (what earns a page, and what goes into it) ---


@app.get("/api/topics")
def topics_list(limit: int = 400) -> dict:
    """Proposed topics with their evidence, plus the human-seeded ones.

    The evidence travels with the topic on purpose: a decision about whether
    something deserves a page is a decision about the numbers behind it, and a
    name alone cannot carry that.
    """
    return pages.list_topics(limit=limit)


@app.get("/api/topics/{section}/{slug}/brief")
def topic_brief(section: str, slug: str) -> dict:
    """The brief a page would be written from, whole.

    Returned unsummarised: the point of reading it is to see what actually goes
    in, and a summary of the input is not the input. Addressed as
    `<section>/<slug>` because a slug alone can name two pages.
    """
    brief = pages.read_brief(section, slug)
    if brief is None:
        raise HTTPException(status_code=404, detail="No brief for that page")
    return brief


@app.post("/api/topics/veto")
def topic_veto(body: dict, request: Request) -> dict:
    """Editorial "never a page". Durable in the curation ledger and replayed on
    every rebuild, so the proposal stops reappearing each pass.

    Editor-gated, like the two beside it: deciding what the site does and does
    not publish is a change to published output, not an assessment of it."""
    _require_role(request, "editor")
    node_ids = body.get("node_ids") or []
    if not node_ids:
        raise HTTPException(status_code=400, detail="node_ids required")
    reason = (body.get("reason") or "").strip()
    if not reason:
        # The reason is not paperwork: whoever carries out the retirement reads
        # it to decide what happens to the page. The first veto placed here went
        # in blank and stalled - a page whose claims are all about somebody else
        # wants MOVING, and only the reviewer knows which case it is.
        raise HTTPException(
            status_code=400,
            detail="A reason is required - it decides what happens to the page",
        )
    try:
        return pages.veto(node_ids, reason, body.get("by") or "workbench")
    except (RuntimeError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/topics/seed")
def topic_seed(body: dict, request: Request) -> dict:
    """Name a topic we want covered, possibly before any material exists.

    This is the half the graph cannot produce. An emergent proposal is derived
    FROM claims and so cannot exist until they do; a seeded topic is named first
    and fills up, which shows where the corpus is thin against what we care
    about - a better steer for what to ingest next than what happens to be
    abundant already.
    """
    _require_role(request, "editor")
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    return pages.add_seeded(name, body.get("note"), body.get("by") or "workbench")


@app.delete("/api/topics/seed/{name}")
def topic_unseed(name: str, request: Request) -> dict:
    """Drop a seeded topic. Append-only - a removal is a compensating entry, so
    what was asked for survives even after it is dropped."""
    _require_role(request, "editor")
    pages.remove_seeded(name, "workbench")
    return {"ok": True}


@app.post("/api/topics/rename")
def topic_rename(body: dict, request: Request) -> dict:
    """Rename a graph node - the name IS the page title and the slug.

    Editor-gated for that reason: it changes published output, the same class as
    archiving a record, not an assessment of it.

    The rename is applied through the assimilator and the recorded outcome comes
    back with it, because a rename can end `lost` (the node no longer resolves)
    without anything having gone wrong.

    Renaming a node to a name another node already holds is not an error either:
    it says the two are one thing, so it becomes a MERGE, into the node that
    holds the name. Across two different node types that inference is weak, so
    that case comes back as `clash` and is only merged with `confirm_merge`.
    """
    user = _require_role(request, "editor")
    node_id = (body.get("node_id") or "").strip()
    if not node_id:
        raise HTTPException(status_code=400, detail="node_id required")
    login = user.get("login") or user.get("email") or "unknown"
    try:
        return pages.propose_rename(
            node_id,
            body.get("name"),
            body.get("new_name"),
            body.get("reason"),
            f"workbench/{login}",
            confirm_merge=bool(body.get("confirm_merge")),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except (RuntimeError, OSError) as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/ingests/{full_hash}/tags")
def record_tags(full_hash: str) -> dict:
    """What a reviewer has said this record is about.

    Read-only and ungated, like the record itself. Each tag carries what became
    of it: `applied` is live in the graph, `pending` is waiting for the record to
    be digested (most records in the store have no graph row yet), `lost` can
    never resolve.
    """
    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")
    return {"tags": tags.tags_for_record(full_hash)}


@app.post("/api/ingests/{full_hash}/tags")
def add_record_tag(full_hash: str, body: dict, request: Request) -> dict:
    """Assert that this record is about a subject.

    Reviewer-gated: it is a judgement about a record, the same class as an audit
    verdict, and it changes no published output - a tag attaches no claim to the
    subject, so it feeds neither the page gate nor scoring.

    The judgement is worth capturing at the moment it is made, so a record the
    pipeline has not digested yet does not refuse the tag: it is held and lands
    when the record arrives.
    """
    user = _require_role(request, "reviewer")
    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")
    login = user.get("login") or user.get("email") or "unknown"
    try:
        return tags.add_tag(
            full_hash,
            body.get("name"),
            body.get("node_type") or "topic",
            body.get("note"),
            f"workbench/{login}",
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except (RuntimeError, OSError) as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.delete("/api/ingests/{full_hash}/tags/{tag_id}")
def remove_record_tag(full_hash: str, tag_id: str, request: Request) -> dict:
    """Withdraw a tag. A compensating entry, never a deletion: what was asserted,
    and that it was withdrawn, both stay in the record."""
    user = _require_role(request, "reviewer")
    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")
    login = user.get("login") or user.get("email") or "unknown"
    try:
        return tags.remove_tag(tag_id, f"workbench/{login}")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except (RuntimeError, OSError) as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/pages/compositions")
def list_compositions() -> dict:
    """Pages that cover several subjects at once."""
    return {"compositions": compositions.list_compositions()}


@app.post("/api/pages/compose")
def compose_page(body: dict, request: Request) -> dict:
    """Cover several subjects with one page.

    Editor-gated: it decides what the site publishes and under what name, the
    same class as a veto or a rename. It writes no vetoes - the composition op
    suppresses its members' separate proposals itself, so undoing it needs
    nothing else undone.
    """
    user = _require_role(request, "editor")
    login = user.get("login") or user.get("email") or "unknown"
    try:
        return compositions.compose(
            body.get("name"),
            body.get("node_ids") or [],
            body.get("note"),
            f"workbench/{login}",
            # From the SESSION, never the body: a confirmation a caller can put
            # in its own request confirms nothing.
            confirmed_by=f"workbench/{login}",
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except (RuntimeError, OSError) as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/pages/decompose")
def decompose_page(body: dict, request: Request) -> dict:
    """Take a composed page apart; its members are proposed separately again."""
    user = _require_role(request, "editor")
    login = user.get("login") or user.get("email") or "unknown"
    try:
        return compositions.decompose(body.get("page_id"), f"workbench/{login}")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except (RuntimeError, OSError) as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/topics/name-check")
def topic_name_check(name: str = "") -> dict:
    """What a proposed node name will render as, and where it breaks the naming
    convention. Advisory: a reviewer may know better than the rule, and a name is
    reversible - but the NAME and the page TITLE are different things, and that
    difference is invisible in a text box until it is shown."""
    return pages.name_check(name)


@app.get("/api/topics/name-suggestions")
def topic_name_suggestions(q: str = "", exclude: str = "") -> dict:
    """Live nodes whose name or alias looks like `q`.

    What makes a rename usable: the name a reviewer is reaching for usually
    exists already, spelled slightly differently, and typing it exactly is how
    the two become one thing. Read-only, like the graph browse it sits beside.
    """
    return {"suggestions": pages.name_suggestions(q, exclude)}


@app.get("/api/graph/stats")
def graph_stats() -> dict:
    s = graph.stats()
    if s is None:
        raise HTTPException(status_code=503, detail="Graph database not available")
    return s


@app.get("/api/graph/nodes")
def graph_nodes(type: str | None = None, q: str | None = None) -> list[dict]:
    nodes = graph.list_nodes(node_type=type, q=q)
    if nodes is None:
        raise HTTPException(status_code=503, detail="Graph database not available")
    return nodes


@app.get("/api/graph/nodes/{node_id}")
def graph_node(node_id: str) -> dict:
    detail = graph.node_detail(node_id)
    if detail is None:
        raise HTTPException(status_code=503, detail="Graph database not available")
    if detail is False:
        raise HTTPException(status_code=404, detail="Node not found")
    return detail


@app.get("/api/graph/ego/{node_id}")
def graph_ego(node_id: str, cap: int = 30) -> dict:
    """A scoped node-link graph around a node (centre + top co-occurring
    neighbours + weighted edges) for the visual graph view. cap bounds hubs."""
    cap = max(1, min(cap, 80))
    g = graph.ego_graph(node_id, cap=cap)
    if g is None:
        raise HTTPException(status_code=503, detail="Graph database not available")
    if g is False:
        raise HTTPException(status_code=404, detail="Node not found")
    return g


# --- Graph curation (merge duplicate entities) ------------------------------
# Reads are read-only; the merge/un-merge writes shell the assimilator's command.
# Ungated like the processing toggle (local control); same pre-public auth note
# applies - a merge mutates the live graph, so gate before any public exposure.


@app.get("/api/curation/candidates")
def curation_candidates() -> dict:
    """The assimilator's AI-proposed, pre-vetted merge candidates, enriched with
    member details + the decided ones filtered out (see curation.enriched_candidates)."""
    return {"candidates": curation.enriched_candidates()}


@app.get("/api/curation/merges")
def curation_merges() -> dict:
    """Active merges grouped for the cluster / un-merge view (node_merges)."""
    merges = graph.list_merges()
    if merges is None:
        raise HTTPException(status_code=503, detail="Graph database not available")
    return {"merges": merges}


@app.post("/api/curation/merge")
def curation_merge(body: dict, request: Request) -> dict:
    """Merge victim nodes into a survivor under a canonical name (writes the live
    graph via the assimilator). Fail-closed: a failed command returns 400 with
    the error, applies nothing.

    Editor-gated, and the confirmation is taken from the SESSION - never from the
    body. Mark's rule is that no session merges anything he has not confirmed
    here; a confirmation a caller could put in its own request would confirm
    nothing. Without one the assimilator applies nothing and queues the cluster
    instead.
    """
    user = _require_role(request, "editor")
    login = user.get("login") or user.get("email") or "unknown"
    result = curation.apply_merge(
        body.get("survivor_id"),
        body.get("victim_ids") or [],
        body.get("canonical_name"),
        by=f"workbench/{login}",
        confirmed_by=f"workbench/{login}",
        confirmed_via="workbench-queue",
    )
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error", "merge failed"))
    return result


@app.post("/api/curation/unmerge")
def curation_unmerge(body: dict, request: Request) -> dict:
    """Reverse a merge by merge_id. Editor-gated like the merge it reverses."""
    _require_role(request, "editor")
    result = curation.undo_merge(body.get("merge_id"))
    if not result.get("ok"):
        raise HTTPException(
            status_code=400, detail=result.get("error", "un-merge failed")
        )
    return result


@app.post("/api/curation/reject")
def curation_reject(body: dict, request: Request) -> dict:
    """Record a durable 'not a duplicate' rejection for a candidate cluster so it
    never re-shows in the queue. Fail-closed. Attributes it to the logged-in
    reviewer when there is one."""
    user = _require_role(request, "editor")
    by = user.get("email") or ""
    result = curation.reject(
        body.get("node_ids") or [], reason=body.get("reason") or "", by=by
    )
    if not result.get("ok"):
        raise HTTPException(
            status_code=400, detail=result.get("error", "reject failed")
        )
    return result


# --- Model comparison (ADR 0039 Layer 1) ------------------------------------


@app.get("/api/models/comparable")
def models_comparable() -> dict:
    """Ingests that have more than one model-variant digest, for the compare list."""
    return {"comparable": models.list_comparable()}


@app.get("/api/models/compare/{content_hash}")
def models_compare(content_hash: str) -> dict:
    """Side-by-side comparison of an ingest's model-variants + any prior judgment."""
    comparison = models.load_comparison(content_hash)
    if comparison is None:
        raise HTTPException(
            status_code=404, detail="No multi-model comparison for this ingest"
        )
    return {"comparison": comparison, "judgment": models.latest_judgment(content_hash)}


@app.post("/api/models/judgment")
def models_judgment(body: dict, request: Request) -> dict:
    """Persist a 'which model is better' judgment (workbench-owned, queryable),
    attributed to the logged-in reviewer. Reviewer-gated: it is an assessment
    written to live data, the same class as an audit verdict."""
    user = _require_role(request, "reviewer")
    result = models.save_judgment(
        body.get("content_hash"),
        body.get("models_compared") or [],
        body.get("chosen_model"),
        judged_by=user.get("email", ""),
        notes=body.get("notes") or "",
    )
    if not result.get("ok"):
        raise HTTPException(
            status_code=400, detail=result.get("error", "judgment failed")
        )
    return result


# The schedule + processing-mode runner moved OUT to the local `scheduler` repo
# (review-vs-orchestrate split): /api/schedule, /api/processing(/margin),
# /api/ingest-titles and the runner now live there. The workbench is review-only.


def _archived_source_by_stem(stem: str) -> Path | None:
    """The archived original whose filename stem is exactly `stem`.

    Not a sidecar sitting beside it: a source can have a companion like
    `{hash}.transcript.json`, `{hash}.*` matches that too, and glob order is
    arbitrary - so taking the first match served the transcript JSON
    (unplayable) for every record that has one. The source file's stem is the
    hash; a sidecar's is `{hash}.transcript`.
    """
    for candidate in records_path.glob(f"{stem}.*"):
        if candidate.stem == stem:
            return candidate
    return None


def _single_file_snapshot(raw_frontmatter: str | None) -> str | None:
    """The hash of the `single_file` snapshot - the self-contained capture of a
    web page, with its stylesheets and images inlined."""
    import yaml as _yaml  # local, as elsewhere in this module

    if not raw_frontmatter:
        return None
    try:
        # safe_load_all, not safe_load: the raw block still carries its `---`
        # delimiters, which makes it more than one YAML document.
        parsed = next(
            (d for d in _yaml.safe_load_all(raw_frontmatter) if isinstance(d, dict)),
            None,
        )
    except _yaml.YAMLError:
        return None
    if parsed is None:
        return None
    for snap in parsed.get("snapshots") or []:
        if isinstance(snap, dict) and snap.get("role") == "single_file":
            return normalise_hash(snap.get("hash"))
    return None


def _archived_file(full_hash: str) -> Path | None:
    """The archived original for a record, by the record's content hash.

    Most records are archived under that hash, because for audio, video and PDF
    the content hash IS the hash of the source file's bytes. For **web and
    ebook it is not**: those hash the EXTRACTED BODY, so the record and its own
    source file have two different hashes and the file is archived under
    `source_hash`. Asking for a book by its content hash therefore found
    nothing, and the reviewer was told the original was unavailable while it sat
    on disk the whole time - which is worse than missing, because it cannot be
    checked against the extraction it is supposed to verify. 51 of 295 records
    are in that class: 16 ebooks and 35 web pages.

    The mismatch is a known per-type inconsistency in the ingest format, under
    reconciliation upstream. Resolving it here rather than at each caller means
    the viewer, the download and the prerender all get the file, and a later
    reconciliation removes the fallback without changing any of them.
    """
    direct = _archived_source_by_stem(full_hash)
    if direct is not None:
        return direct
    # Only reached for the types whose hashes differ, so the extra read costs
    # nothing on the common path.
    ingest = source.get_ingest(full_hash)
    if not ingest:
        return None
    frontmatter = ingest.get("frontmatter", {})
    # A WEB record archives several captures of the same page, and the raw fetch
    # is the worst of them to show: its stylesheets and images are still
    # external URLs, so offline it renders as an unstyled skeleton of stacked
    # links and broken images - which reads as "the capture is empty" even
    # though every word is there. The `single_file` snapshot is the one that
    # inlines them and is meant to stand alone.
    #
    # Read from the RAW frontmatter, because the parsed one flattens a list of
    # mappings to `snapshots.hash` / `snapshots.content_type` holding whichever
    # snapshot came last - and `role`, the only field that says which capture a
    # snapshot IS, does not survive at all.
    single_file = _single_file_snapshot(ingest.get("raw_frontmatter"))
    if single_file:
        self_contained = _archived_source_by_stem(single_file)
        if self_contained is not None:
            return self_contained
    source_hash = normalise_hash(frontmatter.get("source_hash"))
    if not source_hash or source_hash == full_hash:
        return None
    return _archived_source_by_stem(source_hash)


@app.get("/api/sources/{full_hash}")
def get_source(full_hash: str) -> FileResponse:
    """Serve an original source file by its full SHA-256 hash.

    Returns the original file (PDF, video, audio, etc.) that was ingested.
    The hash must be the complete 64-character SHA-256. Not-found and
    malformed-hash responses are indistinguishable by design.

    Currently serves without access checking (development mode). In
    production this endpoint must verify either hash-based proof of
    possession or a manual access grant before serving copyrighted
    originals. See the source-types-and-copyright decision in the
    meta-repo for the full access model.
    """
    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")

    file_path = _archived_file(full_hash)
    if file_path is None:
        raise HTTPException(status_code=404, detail="Not found")
    media_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
    return FileResponse(file_path, media_type=media_type)


@app.get("/api/sources/{full_hash}/waveform")
def source_waveform(
    full_hash: str,
    start: float = 0.0,
    duration: float = 6.0,
    bins: int = 400,
) -> JSONResponse:
    """Peak amplitudes for a WINDOW of a source's audio, so the timestamp editor
    can draw a waveform around the word being retimed. ffmpeg extracts just
    `[start, start+duration]` (fast seek), downsampled to mono 8 kHz, and
    `pcm_peaks` reduces it to `bins` values in [0, 1] - cheap regardless of the
    file's total length. Video sources decode their audio track the same way."""
    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")
    # Audio and video only, where the content hash IS the file's hash, so the
    # stem lookup is enough - but it shares the sidecar-avoidance rule rather
    # than restating it.
    audio_file = _archived_source_by_stem(full_hash)
    if audio_file is None:
        raise HTTPException(status_code=404, detail="Not found")

    start = max(0.0, start)
    duration = max(0.1, min(duration, 60.0))
    bins = max(1, min(bins, 2000))

    import subprocess

    cmd = [
        "ffmpeg",
        "-v",
        "quiet",
        "-ss",
        f"{start:.3f}",
        "-t",
        f"{duration:.3f}",
        "-i",
        str(audio_file),
        "-ac",
        "1",
        "-ar",
        "8000",
        "-f",
        "s16le",
        "-",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=25)
    except (subprocess.SubprocessError, OSError):
        raise HTTPException(status_code=503, detail="Waveform unavailable")
    peaks = waveform.pcm_peaks(proc.stdout, bins)
    return JSONResponse(
        {"start": start, "duration": duration, "bins": bins, "peaks": peaks}
    )


@app.get("/api/ingests/{full_hash}/media/{filename}")
def get_record_media(full_hash: str, filename: str) -> FileResponse:
    """Serve an extracted media file (image) belonging to a record.

    Files live at `{ingests_root}/media/{record_hash}/{filename}`. The
    filename is constrained to `{12-hex}.{ext}` (the format the ingester
    writes) so this endpoint cannot be used to read arbitrary paths.
    Same hash-and-not-found indistinguishability as the other endpoints.

    Currently ungated for development. In production access follows the
    parent record's copyright status.
    """
    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")
    if not MEDIA_FILENAME_PATTERN.match(filename):
        raise HTTPException(status_code=404, detail="Not found")

    file_path = ingests_path / "media" / full_hash / filename
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="Not found")

    media_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
    return FileResponse(file_path, media_type=media_type)


def _validate_spans(raw: object) -> list[dict]:
    """Validate an optional spans payload: a list of {"from": int, "to": int,
    "kind": "played"|"observed"} with 0 <= from <= to. `kind` is optional and
    defaults to "observed" for back-compatibility. Raises 400 on malformed
    input; None/missing -> []."""
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise HTTPException(status_code=400, detail="spans must be a list")
    out: list[dict] = []
    for s in raw:
        if not isinstance(s, dict):
            raise HTTPException(status_code=400, detail="Malformed span")
        frm, to = s.get("from"), s.get("to")
        kind = s.get("kind", "observed")
        if (
            not isinstance(frm, int)
            or not isinstance(to, int)
            or isinstance(frm, bool)
            or isinstance(to, bool)
            or frm < 0
            or to < frm
            or kind not in ("played", "observed")
        ):
            raise HTTPException(status_code=400, detail="Malformed span")
        out.append({"from": frm, "to": to, "kind": kind})
    return out


def _validate_verdict(raw: object) -> tuple[float | None, bool | None, int | None]:
    """Validate an optional reviewer verdict {"observed_coverage": 0..1,
    "digestible": bool, "total_units": int}. Returns (observed_coverage,
    digestible, total_units) or (None, None, None) when absent. Raises 400 on
    malformed input."""
    if raw is None:
        return (None, None, None)
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="verdict must be an object")
    oc = raw.get("observed_coverage")
    if isinstance(oc, bool) or not isinstance(oc, (int, float)) or not (0 <= oc <= 1):
        raise HTTPException(
            status_code=400, detail="Malformed verdict observed_coverage"
        )
    tu = raw.get("total_units")
    if tu is not None and (isinstance(tu, bool) or not isinstance(tu, int) or tu < 0):
        raise HTTPException(status_code=400, detail="Malformed verdict total_units")
    return (float(oc), bool(raw.get("digestible")), tu if isinstance(tu, int) else None)


@app.get("/api/ingests/{full_hash}/coverage")
def get_coverage(full_hash: str) -> JSONResponse:
    """Return the review-coverage sidecar's reviews (all reviewers).
    Empty list when no coverage has been recorded yet."""
    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")
    sidecar = source.load_coverage(full_hash)
    return JSONResponse({"reviews": (sidecar or {}).get("reviews", [])})


# Relevance-tuning highlights (anomalica/highlights/1). Span offsets are
# Unicode code points into the raw stored body - the verbatim text after the
# closing frontmatter fence, exactly as parse_frontmatter returns it. See
# anomalica/decisions/drafts/relevance-tuning-mode.md. These endpoints follow
# the same access posture as the record body itself (get_ingest).


@app.get("/api/ingests/{full_hash}/body")
def get_raw_body(full_hash: str) -> JSONResponse:
    """The raw stored body and its hash - the reference text that highlight
    span offsets index. The digester pins body_sha256 from this endpoint so
    both sides agree byte-for-byte."""
    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")
    ingest = source.get_ingest(full_hash)
    if ingest is None:
        raise HTTPException(status_code=404, detail="Not found")
    body = ingest["body"]
    return JSONResponse({"body": body, "body_sha256": tuning.body_sha256(body)})


@app.get("/api/ingests/{full_hash}/highlights")
def get_highlights(full_hash: str) -> JSONResponse:
    """The highlights sidecar (null if none yet) plus the current body's
    hash so the client can detect a stale sidecar and re-anchor."""
    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")
    ingest = source.get_ingest(full_hash)
    if ingest is None:
        raise HTTPException(status_code=404, detail="Not found")
    return JSONResponse(
        {
            "highlights": source.load_highlights(full_hash),
            "body_sha256": tuning.body_sha256(ingest["body"]),
        }
    )


@app.put("/api/ingests/{full_hash}/highlights")
def put_highlights(full_hash: str, body: dict, request: Request) -> JSONResponse:
    """Replace the highlights sidecar and commit it to the ingests repo.

    Expects {"complete": bool, "spans": [{start,end,text,note?}],
    "rejected": [{start,end,text}], "complete_ranges": [{start,end,note?}]}.
    Offsets are validated against the current body (code points, text must match
    exactly); highlight spans must be non-overlapping. `complete_ranges` records
    which PARTS were swept, so precision is measurable on a record too long to
    treat wall-to-wall - within a range an unhighlighted sentence means "judged
    not claim-worthy", outside every range it means "not looked at". Requires
    reviewer role.
    """
    user = _require_role(request, "reviewer")
    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")
    ingest = source.get_ingest(full_hash)
    if ingest is None:
        raise HTTPException(status_code=404, detail="Not found")

    record_body = ingest["body"]
    try:
        spans = tuning.validate_spans(body.get("spans"), record_body)
        rejected = tuning.validate_spans(
            body.get("rejected"), record_body, field="rejected", allow_overlap=True
        )
        complete_ranges = tuning.validate_ranges(
            record_body, body.get("complete_ranges")
        )
    except (tuning.SpanError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    sidecar = tuning.build_sidecar(
        record_hash=full_hash,
        body=record_body,
        complete=bool(body.get("complete", False)),
        spans=spans,
        rejected=rejected,
        reviewed_by=user["email"],
        reviewed_at=datetime.now(dt_timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        complete_ranges=complete_ranges,
    )
    if not source.save_highlights(
        full_hash, sidecar, author_name=user["name"], author_email=user["email"]
    ):
        raise HTTPException(status_code=404, detail="Not found")
    return JSONResponse({"saved": True, "body_sha256": sidecar["body_sha256"]})


def _active_prompts() -> list[dict]:
    """The extraction prompts that WILL be sent with the next digest run:
    each prompt id's active version, resolved through the digester's
    registry.yaml (prompts.{id}.active -> versions.{v}.file, file paths
    relative to the prompts dir). Retired ids (active: null) are skipped."""
    import yaml as _yaml

    registry_path = prompts_path / "registry.yaml"
    if not registry_path.is_file():
        return []
    try:
        registry = _yaml.safe_load(registry_path.read_text()) or {}
    except _yaml.YAMLError:
        return []
    root = prompts_path.resolve()
    prompts: list[dict] = []
    for prompt_id, spec in (registry.get("prompts") or {}).items():
        active = (spec or {}).get("active")
        if not active:
            continue
        version = (spec.get("versions") or {}).get(active) or {}
        file_rel = str(version.get("file", ""))
        p = (root / file_rel).resolve()
        if not p.is_relative_to(root) or not p.is_file():
            continue
        prompts.append({"name": prompt_id, "version": active, "text": p.read_text()})
    return prompts


def _stored_predigest_pointer(full_hash: str) -> dict | None:
    """The digester's stored pre-digest pointer for a record, if it has
    materialised one (at digest time): {"predigest_sha256", "prep_version",
    "generated_at"} from `predigests/by-record/{record_hash}.json`."""
    pointer_path = predigests_path / "by-record" / f"{full_hash}.json"
    if not pointer_path.exists():
        return None
    with open(pointer_path) as f:
        pointer = json.load(f)
    sha = pointer.get("predigest_sha256", "")
    if not FULL_HASH_PATTERN.match(sha):
        return None
    return {
        "predigest_sha256": sha,
        "prep_version": pointer.get("prep_version"),
        "generated_at": pointer.get("generated_at"),
    }


@app.post("/api/ingests/{full_hash}/predigest")
def compute_predigest(full_hash: str, body: dict) -> JSONResponse:
    """The pre-digest computed LIVE (ADR 0042): the exact model input,
    derived on demand with the same anomalica_common.pre_digest.materialise
    the digester runs, so what the reviewer previews is byte-for-byte what a
    digest would read. Computes from the posted working body when given
    (unsubmitted irrelevant marks preview immediately - mark, re-preview,
    adjust), else from the record's current stored body. Includes the
    registry's active prompts (what the next run sends) and, when the
    digester has a stored artefact from the LAST digest, whether the live
    input still matches it."""
    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")
    ingest = source.get_ingest(full_hash)
    if ingest is None:
        raise HTTPException(status_code=404, detail="Not found")

    raw = body.get("body")
    if raw is not None and not isinstance(raw, str):
        raise HTTPException(status_code=400, detail="body must be a string")
    live = pre_digest.materialise(raw if raw is not None else ingest["body"])
    stored = _stored_predigest_pointer(full_hash)
    live_sha = pre_digest.pre_digest_hash(live)
    return JSONResponse(
        {
            "available": True,
            "body": live,
            "predigest_sha256": live_sha,
            "prep_version": pre_digest.PREP_VERSION,
            "generated_at": None,
            "prompts": _active_prompts(),
            "stored": stored,
            "stored_matches": (
                stored["predigest_sha256"] == live_sha if stored else None
            ),
        }
    )


@app.get("/api/ingests/{full_hash}/grading")
def get_grading(full_hash: str) -> JSONResponse:
    """Grading results the digester emitted for this record's current body
    (grading/{body_sha256}.grading.json in the digester repo). Read-only;
    accept/reject adjudications write back only to the highlights sidecar."""
    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")
    ingest = source.get_ingest(full_hash)
    if ingest is None:
        raise HTTPException(status_code=404, detail="Not found")
    sha = tuning.body_sha256(ingest["body"])
    path = grading_path / f"{sha}.grading.json"
    if not path.exists():
        return JSONResponse({"available": False, "body_sha256": sha})
    with open(path) as f:
        grading = json.load(f)
    return JSONResponse({"available": True, "body_sha256": sha, "grading": grading})


@app.get("/api/ingests/{full_hash}/supersession")
def get_supersession(full_hash: str) -> JSONResponse:
    """Whether the open record has been re-ingested/superseded underneath the
    view. The open review view polls this so it can prompt a reload with the
    new record rather than silently showing a stale, source-unresolvable one.
    `public_supersedes` is the 56-char prefix for deep-linking the new record."""
    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")
    status = source.supersession(full_hash)
    by = status.get("superseded_by")
    return JSONResponse(
        {
            "exists": status["exists"],
            "superseded_by": by,
            "public_supersedes": by[:PUBLIC_HASH_LENGTH] if by else None,
        }
    )


@app.get("/api/ingests/{full_hash}/relations")
def get_relations(full_hash: str) -> list[dict]:
    """EXPERIMENTAL. Records the assimilator judged to share a subject with
    this one, with the linked claim pairs resolved. Read-only; a decision on
    a relation goes through the curation ledger, never here."""
    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")
    return relations.relations_for(full_hash)


@app.get("/api/ingests/{full_hash}/history")
def get_history(full_hash: str) -> JSONResponse:
    """Every reviewer's edits to a record, newest first (the record's git history):
    a list of {by, at, summary}. Public read; reviewer email is not exposed."""
    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")
    return JSONResponse({"history": source.review_history(full_hash)})


def _guard_copyright_change(full_hash: str, content: str, user: dict) -> None:
    """Only an admin may change who is allowed to see a record.

    `copyright.status` is the access gate, not a label: it decides whether the
    body and the original file are served to anyone who asks. The workbench
    only offers the control to admins, but the control is a button - the record
    is submitted as whole markdown, so any reviewer could edit the frontmatter
    by hand and post it. This is where that is actually refused.
    """
    current = source.get_ingest(full_hash)
    if current is None:
        return
    before = (current.get("frontmatter") or {}).get("copyright.status")
    after = parse_frontmatter(content)[0].get("copyright.status")
    # An absent status is not a request to change one. Submitted content whose
    # frontmatter does not state it reads as "unchanged" here, and as
    # "restricted" everywhere that serves the record - so the omission fails
    # closed rather than quietly opening the gate.
    if after is None or before == after:
        return
    if not roles.at_least(_role_of_user(user), "admin"):
        raise HTTPException(
            status_code=403,
            detail=(
                "Changing a record's copyright status decides who may see it, "
                "and is restricted to admins."
            ),
        )


@app.put("/api/ingests/{full_hash}")
def submit_review(full_hash: str, body: dict, request: Request) -> JSONResponse:
    """Submit a review: save changes and commit with reviewer identity.

    Expects {"content": "...", "notes": "...",
    "spans": [{"from": 0, "to": 4, "kind": "played"|"observed"}]}.
    `spans` is optional: contiguous line ranges of the record body (at
    submission time) the reviewer covered. `kind` distinguishes weak
    auto-recorded playback coverage ("played") from asserted coverage
    ("observed", the default). Appended to the
    `{hash}.review.json` sidecar and committed with the review.
    Requires authentication.
    """
    user = _require_user(request)

    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")

    content = body.get("content")
    if not content or not isinstance(content, str):
        raise HTTPException(status_code=400, detail="Missing content")

    notes = body.get("notes", "").strip()
    spans = _validate_spans(body.get("spans"))
    obs_cov, digestible_flag, total_units = _validate_verdict(body.get("verdict"))

    # Contributors (the default for any authenticated-but-unlisted login) cannot
    # commit to live data: their edit is queued as a proposal for a reviewer to
    # approve. Reviewers and editors commit directly, as before.
    if not roles.at_least(_role_of_user(user), "reviewer"):
        entry = proposals.enqueue(
            ingests_path,
            record_hash=full_hash,
            content=content,
            author=user,
            notes=notes,
            spans=spans,
            verdict=body.get("verdict"),
        )
        return JSONResponse(
            {"submitted": True, "status": "pending", "proposal_id": entry["id"]},
            status_code=202,
        )

    _guard_copyright_change(full_hash, content, user)

    if not source.save_ingest(full_hash, content):
        raise HTTPException(status_code=404, detail="Not found")

    if spans or obs_cov is not None:
        source.append_coverage(
            full_hash=full_hash,
            email=user["email"],
            spans=spans,
            notes=notes,
            observed_coverage=obs_cov,
            digestible=digestible_flag,
            total_units=total_units,
        )

    # Git commit with reviewer as author. COMMIT-ONLY: the operations
    # auto-push watcher is the single pusher for the ingests clone (two
    # concurrent rebasers corrupted FETCH_HEAD); the client's second phase
    # (POST /api/sync/push) OBSERVES the watcher landing the commit.
    source.commit_review(
        full_hash=full_hash,
        author_name=user["name"],
        author_email=user["email"],
        notes=notes,
    )

    return JSONResponse(
        {"submitted": True, "synced": False, "sync_detail": "auto-push pending"}
    )


@app.post("/api/sync/push")
def sync_push(request: Request) -> JSONResponse:
    """Confirm local ingests commits reached origin - the second phase of a
    review submit. OBSERVES the operations auto-push watcher (the single
    pusher, ~2s after any commit) by polling the ahead count until it hits
    zero or a short timeout passes; never pushes or rebases itself, so it
    cannot race the watcher. Requires authentication; local-clone
    deployments only."""
    _require_user(request)
    if sync_manager is None:
        raise HTTPException(status_code=404, detail="Not found")
    synced, detail = sync_manager.wait_for_push()
    return JSONResponse({"synced": synced, "sync_detail": detail})


@app.get("/api/me/reviews")
def list_my_reviews(request: Request) -> JSONResponse:
    """Return {content_hash: latest_review_iso} for the current user.
    Derived from the ingests repo's git log."""
    user = _require_user(request)
    reviewed = source.reviewed_by_email(user["email"])
    return JSONResponse({"reviewed": reviewed})


# Proposal review queue (roles phase 2). A contributor's submit is queued as a
# proposal (see submit_review); these endpoints let a reviewer/editor list them,
# see the diff, and approve (commit as the contributor) or reject (drop). SECURITY:
# the store holds unreviewed content from anyone, so every list/read here is
# reviewer-gated; only the /mine endpoint is contributor-visible and returns just
# the caller's own pending proposals.


@app.get("/api/proposals/mine")
def my_proposals(request: Request) -> JSONResponse:
    """A contributor's own pending proposals (metadata only), so they can see
    what they've submitted is queued. Declared before /{pid} so "mine" is not
    captured as an id."""
    user = _require_user(request)
    login = user.get("login", "")
    mine = [
        p
        for p in proposals.list_pending(ingests_path)
        if p.get("author_login") == login
    ]
    return JSONResponse({"proposals": mine})


@app.get("/api/proposals")
def list_proposals(request: Request) -> JSONResponse:
    """Every pending proposal (metadata only, no content). Reviewer/editor."""
    _require_role(request, "reviewer")
    return JSONResponse({"proposals": proposals.list_pending(ingests_path)})


@app.get("/api/proposals/{pid}")
def get_proposal(pid: str, request: Request) -> JSONResponse:
    """One proposal with its full proposed content, plus the CURRENT record
    content so the client can diff. Reviewer/editor."""
    _require_role(request, "reviewer")
    entry = proposals.get(ingests_path, pid)
    if entry is None:
        raise HTTPException(status_code=404, detail="Not found")
    current = source.get_ingest(entry["record_hash"])
    # The record may have been re-ingested/removed since the proposal; still
    # show the proposed content so the reviewer can decide (empty current diffs
    # as an all-add).
    current_content = (current["raw_frontmatter"] + current["body"]) if current else ""
    record_title = ""
    if current:
        record_title = current.get("frontmatter", {}).get("title", "")
    return JSONResponse(
        {
            "proposal": entry,
            "current_content": current_content,
            "record_exists": current is not None,
            "record_title": record_title,
        }
    )


@app.post("/api/proposals/{pid}/approve")
def approve_proposal(pid: str, request: Request) -> JSONResponse:
    """Approve a proposal: commit its content to ingests attributed to the
    contributor (approved-by the reviewer), then drop the queue entry. Reuses
    the same save + coverage + commit path as a direct reviewer submit."""
    reviewer = _require_role(request, "reviewer")
    entry = proposals.get(ingests_path, pid)
    if entry is None:
        raise HTTPException(status_code=404, detail="Not found")

    full_hash = entry["record_hash"]
    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")

    content = entry.get("content")
    if not content or not isinstance(content, str):
        raise HTTPException(status_code=400, detail="Proposal has no content")

    if not source.save_ingest(full_hash, content):
        raise HTTPException(status_code=404, detail="Record not found")

    notes = (entry.get("notes") or "").strip()
    spans = _validate_spans(entry.get("spans"))
    obs_cov, digestible_flag, total_units = _validate_verdict(entry.get("verdict"))
    author_email = entry.get("author_email") or ""
    if (spans or obs_cov is not None) and author_email:
        source.append_coverage(
            full_hash=full_hash,
            email=author_email,
            spans=spans,
            notes=notes,
            observed_coverage=obs_cov,
            digestible=digestible_flag,
            total_units=total_units,
        )

    # Commit as the contributor; the reviewer who approved is recorded in the
    # message body so the audit trail carries both identities.
    approver = reviewer.get("name") or reviewer.get("login") or "a reviewer"
    commit_notes = (
        f"{notes}\n\nApproved by {approver}" if notes else f"Approved by {approver}"
    )
    source.commit_review(
        full_hash=full_hash,
        author_name=entry.get("author_name")
        or entry.get("author_login")
        or "Contributor",
        author_email=author_email or "contributor@anomalica.is",
        notes=commit_notes,
    )
    proposals.remove(ingests_path, pid)
    return JSONResponse({"approved": True})


@app.post("/api/proposals/{pid}/reject")
def reject_proposal(pid: str, request: Request) -> JSONResponse:
    """Reject a proposal: drop the queue entry (the full-content snapshot is
    discarded). Reviewer/editor."""
    _require_role(request, "reviewer")
    if proposals.get(ingests_path, pid) is None:
        raise HTTPException(status_code=404, detail="Not found")
    proposals.remove(ingests_path, pid)
    return JSONResponse({"rejected": True})


# Verification: cloze-challenge proof of possession.
# Reviewers prove they have the source by filling in N short cloze blanks
# drawn from the body. The sidecar (`{hash}.verification.json`) lives next
# to the record in the ingests store. Answers must never reach the client.
# Mirrors the normalisation in ingester/shared/verification.py.

_verification_sessions: dict[str, dict] = {}


def _normalise_word(word: str) -> str:
    # Strip surrounding whitespace as well as punctuation/quotes so a response
    # like " ufo " still matches (the edge port in edge/lib/gate.ts mirrors this).
    return word.strip(string.whitespace + string.punctuation + "“”‘’\"'").lower()


def _drop_expired_sessions(now: float) -> None:
    expired = [
        sid
        for sid, sess in _verification_sessions.items()
        if now - sess["created"] > VERIFICATION_SESSION_TTL_SECONDS
    ]
    for sid in expired:
        _verification_sessions.pop(sid, None)


@app.get("/api/ingests/{full_hash}/verification")
def verification_info(full_hash: str) -> JSONResponse:
    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")

    sidecar = source.load_verification(full_hash)
    if sidecar is None:
        return JSONResponse({"available": False})

    pool_size = len(sidecar.get("challenges", []))
    served = min(CHALLENGES_PER_SESSION, pool_size)
    return JSONResponse(
        {
            "available": True,
            "algorithm": sidecar.get("algorithm", "cloze-v1"),
            "pool_size": pool_size,
            "challenges_per_session": served,
            "min_correct_to_pass": math.ceil(PASS_RATIO * served) if served else 0,
            "cloze_gateable": pool_size >= MIN_POOL_FOR_CLOZE_GATE,
            "sha_fastpath_available": "sha256" in sidecar,
        }
    )


@app.post("/api/ingests/{full_hash}/verification/start")
def verification_start(full_hash: str) -> JSONResponse:
    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")

    sidecar = source.load_verification(full_hash)
    if sidecar is None:
        raise HTTPException(status_code=404, detail="No verification available")

    pool = sidecar.get("challenges", [])
    if len(pool) < MIN_POOL_FOR_CLOZE_GATE:
        raise HTTPException(
            status_code=409, detail="Cloze gate not available for this record"
        )

    n = min(CHALLENGES_PER_SESSION, len(pool))
    sample = random.sample(pool, n)

    now = time.time()
    _drop_expired_sessions(now)
    session_id = secrets.token_urlsafe(24)
    _verification_sessions[session_id] = {
        "hash": full_hash,
        "challenges": sample,
        "created": now,
    }

    client_challenges = [
        {"id": i + 1, "before": c["before"], "after": c["after"]}
        for i, c in enumerate(sample)
    ]
    return JSONResponse(
        {
            "session_id": session_id,
            "challenges": client_challenges,
            "min_correct_to_pass": math.ceil(PASS_RATIO * n),
        }
    )


@app.post("/api/ingests/{full_hash}/verification/submit")
def verification_submit(full_hash: str, body: dict) -> JSONResponse:
    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")

    sidecar = source.load_verification(full_hash)
    if sidecar is None:
        raise HTTPException(status_code=404, detail="No verification available")

    submitted_sha = body.get("sha256")
    if (
        isinstance(submitted_sha, str)
        and "sha256" in sidecar
        and submitted_sha.lower() == sidecar["sha256"].lower()
    ):
        return JSONResponse(
            {"passed": True, "method": "sha256", "score": None, "needed": None}
        )

    session_id = body.get("session_id")
    session = _verification_sessions.get(session_id) if session_id else None
    if not session or session["hash"] != full_hash:
        raise HTTPException(status_code=400, detail="Invalid or expired session")

    now = time.time()
    if now - session["created"] > VERIFICATION_SESSION_TTL_SECONDS:
        _verification_sessions.pop(session_id, None)
        raise HTTPException(status_code=400, detail="Session expired")

    responses = body.get("responses") or {}
    sample = session["challenges"]
    needed = math.ceil(PASS_RATIO * len(sample))
    correct = sum(
        1
        for i, challenge in enumerate(sample)
        if _normalise_word(str(responses.get(str(i + 1), "")))
        == challenge.get("answer", "")
    )

    _verification_sessions.pop(session_id, None)

    return JSONResponse(
        {
            "passed": correct >= needed,
            "method": "cloze",
            "score": correct,
            "needed": needed,
        }
    )


# --- Housekeeping decisions -------------------------------------------------
# Approving a proposal is NOT a reuse of PUT /api/ingests/{hash}. That route
# takes the whole record from the client, and a gated record's body never
# reaches the browser - the snapshot blanks it. So the client sends decisions
# only and the server, which can read the record, does the splicing.


def _housekeeping_sidecar_path(full_hash: str) -> Path:
    return ingests_path / "store" / f"{full_hash}.housekeeping.json"


@app.get("/api/housekeeping")
def housekeeping_queue() -> JSONResponse:
    """Records with a housekeeping sidecar. Counts only - no field values - so it
    carries nothing gated and is the same for every reader."""
    rows = []
    for s in source.list_ingests():
        h = s["content_hash"]
        sc = hk.load_sidecar_file(_housekeeping_sidecar_path(h))
        if sc is None:
            continue
        rows.append(
            {
                "content_hash": h,
                "title": s.get("title"),
                "copyright_status": s.get("copyright_status"),
                "checked_at": sc.checked_at,
                "checker_version": sc.checker_version,
                "proposed": sum(1 for i in sc.items if i.status == "proposed"),
                "approved": sum(1 for i in sc.items if i.status == "approved"),
                "rejected": sum(1 for i in sc.items if i.status == "rejected"),
            }
        )
    rows.sort(key=lambda r: (-r["proposed"], r.get("title") or ""))
    return JSONResponse({"queue": rows})


@app.get("/api/ingests/{full_hash}/housekeeping")
def housekeeping_sidecar(full_hash: str) -> JSONResponse:
    p = _housekeeping_sidecar_path(full_hash)
    if not p.exists():
        raise HTTPException(status_code=404, detail="No housekeeping sidecar")
    payload = json.loads(p.read_text())
    entry = source._scan().get(full_hash) if hasattr(source, "_scan") else None
    if entry is not None:
        # The exact frontmatter lines each item removes and adds, computed from
        # the LIVE record so the preview and the commit cannot disagree.
        text = entry[0].read_text(errors="replace")
        sc = hk.load_sidecar_file(p)
        if sc is not None:
            previews = {i.id: hk.preview_item(text, i) for i in sc.items}
            for raw in payload.get("items") or []:
                if raw.get("id") in previews:
                    raw["preview"] = previews[raw["id"]]
    return JSONResponse(payload)


@app.post("/api/ingests/{full_hash}/housekeeping/decide")
async def housekeeping_decide(full_hash: str, request: Request) -> JSONResponse:
    """Record per-item decisions and apply the approved ones.

    One commit carrying the record and the sidecar together: the record edit and
    the decision that authorised it are the same fact, and splitting them lets a
    reader find an unexplained frontmatter change."""
    user = _require_role(request, "reviewer")
    payload = await request.json()
    decisions = {
        d["item_id"]: d["status"]
        for d in (payload.get("decisions") or [])
        if d.get("status") in ("approved", "rejected")
    }
    if not decisions:
        raise HTTPException(status_code=400, detail="No decisions given")

    p = _housekeeping_sidecar_path(full_hash)
    sc = hk.load_sidecar_file(p)
    if sc is None:
        raise HTTPException(status_code=404, detail="No housekeeping sidecar")

    unknown = set(decisions) - {i.id for i in sc.items}
    if unknown:
        raise HTTPException(
            status_code=400, detail=f"Unknown item(s): {sorted(unknown)}"
        )

    for item in sc.items:
        if item.id in decisions:
            # A decision on an already-decided item is refused rather than
            # silently re-applied: the record has already moved underneath it.
            if item.status != "proposed":
                raise HTTPException(
                    status_code=409, detail=f"{item.id} is already {item.status}"
                )
            item.status = decisions[item.id]

    approved_ids = {
        i.id for i in sc.items if i.id in decisions and i.status == "approved"
    }
    unmet = hk.unmet_dependencies(sc.items, approved_ids)
    if unmet:
        # Not advisory: the dependent case exists because applying it alone
        # destroys data - setting date_published without the move that frees it
        # overwrites the upload date instead of relocating it.
        raise HTTPException(
            status_code=400,
            detail=f"These need their prerequisite approved too: {unmet}",
        )

    approved = [i for i in sc.items if i.id in decisions and i.status == "approved"]
    did_not_apply: list[dict] = []
    entry = source._scan().get(full_hash) if hasattr(source, "_scan") else None
    if approved:
        if entry is None:
            raise HTTPException(status_code=404, detail="Record not found")
        md_path, _ = entry
        try:
            result = hk.apply_patch(md_path, approved)
        except hk.BodyChanged as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        except hk.MultilineField as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        # An item that no longer matches the record is NOT an error - the record
        # moved on since the proposal was written. It goes back to `proposed` and
        # is reported, so the reviewer can re-run housekeeping rather than having
        # a stale change silently overwrite a newer edit.
        stale = {i.id for i, _ in result.did_not_apply}
        for item in sc.items:
            if item.id in stale:
                item.status = "proposed"
        if result.applied and not source.save_ingest(full_hash, result.text):
            raise HTTPException(status_code=404, detail="Record not found")
        did_not_apply = [
            {"item_id": i.id, "reason": why} for i, why in result.did_not_apply
        ]

    hk.write_sidecar_file(p, sc)
    source.commit_review(
        full_hash=full_hash,
        author_name=user["name"],
        author_email=user["email"],
        notes=f"housekeeping: {len(approved)} applied, "
        f"{len(decisions) - len(approved)} rejected",
    )
    return JSONResponse(
        {
            "applied": len(approved),
            "rejected": len(decisions) - len(approved),
            "did_not_apply": did_not_apply,
        }
    )
