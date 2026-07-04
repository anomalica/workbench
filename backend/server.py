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
from datetime import datetime
from datetime import timezone as dt_timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

from anomalica_common import pre_digest
from anomalica_common.review_gate import digestibility

from backend import curation, graph, models, tuning
from backend.auth import setup_auth
from backend.sync import GIT_LOCK, SyncManager

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
DEFAULT_SOURCES_PATH = Path(__file__).resolve().parents[2] / "sources"
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


class IngestSource(ABC):
    """Abstract source of ingest records. Concrete implementations
    read from a local git clone or from the GitHub API."""

    @abstractmethod
    def list_ingests(self) -> list[dict]:
        """Return a summary index of every available ingest."""

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
        push: bool = True,
    ) -> tuple[bool, str]:
        """Commit the current state of the file as a review and sync it to
        origin. Returns (synced, detail): synced False means the review is
        safe locally but has NOT reached GitHub - callers must surface it.
        push=False defers the sync (the caller runs it as a separate step)."""

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
        friendly records/ symlink slug, so walk the symlinks once and only read
        a record's frontmatter when its digest actually exists."""
        digested: set[str] = set()
        records_dir = self.store.parent / "records"
        digest_records = digests_path / "records"
        if not (records_dir.exists() and digest_records.exists()):
            return digested
        for symlink in records_dir.glob("*.md"):
            if not (digest_records / f"{symlink.stem}.yaml").exists():
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
        """Find the records/ symlink pointing at store/{hash}.md, if any."""
        records_dir = self.store.parent / "records"
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
        """Move a record from store/ to store/v1/ and remove its records/ symlink."""
        entry = self._scan().get(full_hash)
        if entry is None:
            return False
        md_path, frontmatter = entry
        archive_dir = self.store / "v1"
        archive_dir.mkdir(parents=True, exist_ok=True)
        dest = archive_dir / md_path.name
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
        """Move a record from store/v1/ back to store/ and recreate its symlink."""
        entry = self._scan_archived().get(full_hash)
        if entry is None:
            return False
        md_path, frontmatter = entry

        dest = self.store / md_path.name
        md_path.rename(dest)

        paths: list[Path] = [dest, md_path]
        symlink_name = self._make_symlink_name(frontmatter)
        records_dir = self.store.parent / "records"
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
                    # Extraction generation vs the current per-media-type version
                    # (decision 0040). The frontend badges "outdated" only when
                    # pipeline_version is present and below pipeline_current.
                    "pipeline_version": _pipeline_version_of(frontmatter),
                    "pipeline_current": manifest.get(
                        frontmatter.get("source_type", "")
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
        return {
            "content_hash": full_hash,
            "public_hash": full_hash[:PUBLIC_HASH_LENGTH],
            "copyright_status": frontmatter.get("copyright.status", "restricted"),
            "creators": creators,
            "frontmatter": frontmatter,
            "raw_frontmatter": raw_frontmatter,
            "body": body,
        }

    def save_ingest(self, full_hash: str, content: str) -> bool:
        entry = self._scan().get(full_hash)
        if entry is None:
            return False
        md_path, _ = entry
        with open(md_path, "w") as f:
            f.write(content)
        return True

    def push_origin(self) -> tuple[bool, str]:
        """Push local commits to origin so localhost work reaches the live
        site immediately (a local commit that only ever sits on this machine
        is exactly the drift the sync work exists to kill). If the push is
        rejected because origin advanced (edge reviews land there directly),
        rebase onto origin and retry. Never forces; on any failure the local
        commit stays safe and (ok=False, detail) is returned for the caller
        to surface - never strand silently."""
        import subprocess

        repo_dir = self.store.parent

        def run(*args: str) -> subprocess.CompletedProcess:
            return subprocess.run(
                ["git", *args], cwd=repo_dir, capture_output=True, text=True
            )

        with GIT_LOCK:
            last = ""
            for _ in range(3):
                push = run("push", "origin", "HEAD")
                if push.returncode == 0:
                    return True, ""
                last = (push.stderr or push.stdout).strip()[-300:]
                rebase = run("pull", "--rebase", "origin")
                if rebase.returncode != 0:
                    run("rebase", "--abort")
                    detail = (rebase.stderr or rebase.stdout).strip()[-300:]
                    return False, detail or last
            return False, last

    def commit_review(
        self,
        full_hash: str,
        author_name: str,
        author_email: str,
        notes: str,
        push: bool = True,
    ) -> tuple[bool, str]:
        import subprocess

        entry = self._scan().get(full_hash)
        if entry is None:
            return False, "record not found"
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

            # Local commits must reach origin immediately, or localhost
            # reviews silently drift from the live site. A deferred push
            # (two-phase submit) runs via POST /api/sync/push instead.
            if not push:
                return False, "push deferred"
            return self.push_origin()

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
        self.push_origin()
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
        sidecar top level and the schema bumped to /1 - the digester's gate
        reads that verdict rather than recomputing from the spans."""
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

    def commit_review(self, **kwargs: object) -> tuple[bool, str]:
        raise NotImplementedError("GitHubIngestSource is not yet implemented")

    def load_verification(self, full_hash: str) -> dict | None:
        raise NotImplementedError("GitHubIngestSource is not yet implemented")

    def load_coverage(self, full_hash: str) -> dict | None:
        raise NotImplementedError("GitHubIngestSource is not yet implemented")

    def append_coverage(self, **kwargs: object) -> bool:
        raise NotImplementedError("GitHubIngestSource is not yet implemented")

    def load_highlights(self, full_hash: str) -> dict | None:
        raise NotImplementedError("GitHubIngestSource is not yet implemented")

    def save_highlights(self, **kwargs: object) -> bool:
        raise NotImplementedError("GitHubIngestSource is not yet implemented")

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
sources_path = Path(os.environ.get("SOURCES_PATH", str(DEFAULT_SOURCES_PATH)))
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


@app.get("/api/ingests")
def list_ingests() -> list[dict]:
    """Return summary metadata for every available ingest.

    This includes the full content hash because the current workbench
    is a single-user development setup. In production this endpoint
    should return only public hashes to non-authenticated callers.
    """
    return source.list_ingests()


@app.get("/api/ingests/archived")
def list_archived_ingests() -> list[dict]:
    """Return summary metadata for archived (store/v1/) records."""
    return source.list_archived_ingests()


@app.post("/api/ingests/{full_hash}/archive")
def archive_ingest(full_hash: str, request: Request) -> JSONResponse:
    """Move a record to the archive (store/v1/). Requires authentication."""
    user = _require_user(request)
    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")
    if not source.archive_ingest(full_hash, user):
        raise HTTPException(status_code=404, detail="Not found")
    return JSONResponse({"archived": True})


@app.post("/api/ingests/{full_hash}/unarchive")
def unarchive_ingest(full_hash: str, request: Request) -> JSONResponse:
    """Restore a record from the archive back to the active store. Requires auth."""
    user = _require_user(request)
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
    UI labels it. Requires authentication."""
    import yaml as _yaml

    user = request.session.get("user")
    if not user:
        raise HTTPException(status_code=401, detail="Login required")
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

    The digester writes per-record YAML at ``digests/records/<name>.yaml``
    where ``<name>`` is the friendly filename used by the ingester's records/
    symlinks (e.g. ``2024-08-19-ebook-imminent-...``). To bridge the two we
    walk the ingest records/ symlinks, resolve each to its store/{hash}.md
    target, read the content_hash from frontmatter, and return the matching
    digest path.
    """
    records_dir = ingests_path / "records"
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
            # The ingester's records/ symlinks carry a version suffix for v2+
            # records (``<name>.v2.md`` -> stem ``<name>.v2``), but the digester
            # writes ``<name>.yaml`` with no suffix. Strip it so v2 audio/video
            # records resolve to their digest instead of 404ing.
            stem = re.sub(r"\.v\d+$", "", symlink.stem)
            yaml_path = digests_path / "records" / f"{stem}.yaml"
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

        for acro in sorted(doc_acronyms, key=len, reverse=True):
            full = doc_acronyms[acro]  # form: "Full Form (ACRONYM)"

            # Pattern that matches ANY case variant of "Full Form (ACRONYM)"
            # so "Forward Looking Infrared (FLIR)" and "forward-looking
            # infrared (FLIR)" are treated as the same expansion. The
            # parenthetical acronym must match exact case.
            full_no_paren = full[: full.rfind("(")].strip()
            case_insensitive_full = (
                re.escape(full_no_paren).replace(r"\ ", r"[-\s]")
                + rf"\s*\({re.escape(acro)}\)"
            )

            # Step A - find the first BARE acronym (not already in parens,
            # not part of hyphen designator). If it comes before any
            # full-form occurrence (any case), expand it.
            bare_pattern = rf"(?<!\(){re.escape(acro)}(?![\)\w-])"
            first_full = re.search(case_insensitive_full, out, flags=re.IGNORECASE)
            first_full_pos = first_full.start() if first_full else -1
            m = re.search(bare_pattern, out)
            if m and (first_full_pos == -1 or m.start() < first_full_pos):
                out = out[: m.start()] + full + out[m.end() :]

            # Step B - dedupe case-insensitively. Walk all matches of the
            # case-insensitive "Full Form (ACRONYM)" pattern; keep the first,
            # reduce each subsequent occurrence to just the bare ACRONYM.
            matches = list(re.finditer(case_insensitive_full, out, flags=re.IGNORECASE))
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
        import yaml as _yaml

        with open(yaml_path) as f:
            digest = _yaml.safe_load(f) or {}
    except Exception as exc:
        raise HTTPException(
            status_code=500, detail=f"Failed to parse digest: {exc}"
        ) from exc

    return JSONResponse(_filter_digest(digest))


# --- Knowledge-graph review (read-only over the assimilator DB) ----------
# Surfaces the assimilator's merged entity graph for human inspection - above
# all the merge decisions (a node's aliases), so a bad merge is reviewable.


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
def curation_merge(body: dict) -> dict:
    """Merge victim nodes into a survivor under a canonical name (writes the live
    graph via the assimilator). Fail-closed: a failed command returns 400 with
    the error, applies nothing."""
    result = curation.apply_merge(
        body.get("survivor_id"),
        body.get("victim_ids") or [],
        body.get("canonical_name"),
    )
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error", "merge failed"))
    return result


@app.post("/api/curation/unmerge")
def curation_unmerge(body: dict) -> dict:
    """Reverse a merge by merge_id."""
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
    user = request.session.get("user")
    by = user.get("email") if user else ""
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
    attributed to the logged-in reviewer."""
    user = request.session.get("user")
    result = models.save_judgment(
        body.get("content_hash"),
        body.get("models_compared") or [],
        body.get("chosen_model"),
        judged_by=(user.get("email") if user else "") or "",
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

    matches = list(sources_path.glob(f"{full_hash}.*"))
    if not matches:
        raise HTTPException(status_code=404, detail="Not found")

    file_path = matches[0]
    media_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
    return FileResponse(file_path, media_type=media_type)


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
    "rejected": [{start,end,text}]}. Offsets are validated against the
    current body (code points, text must match exactly); highlight spans
    must be non-overlapping. Requires authentication.
    """
    user = _require_user(request)
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
    except tuning.SpanError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    sidecar = tuning.build_sidecar(
        record_hash=full_hash,
        body=record_body,
        complete=bool(body.get("complete", False)),
        spans=spans,
        rejected=rejected,
        reviewed_by=user["email"],
        reviewed_at=datetime.now(dt_timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
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


@app.get("/api/ingests/{full_hash}/history")
def get_history(full_hash: str) -> JSONResponse:
    """Every reviewer's edits to a record, newest first (the record's git history):
    a list of {by, at, summary}. Public read; reviewer email is not exposed."""
    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")
    return JSONResponse({"history": source.review_history(full_hash)})


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
    user = request.session.get("user")
    if not user:
        raise HTTPException(status_code=401, detail="Login required")

    if not FULL_HASH_PATTERN.match(full_hash):
        raise HTTPException(status_code=404, detail="Not found")

    content = body.get("content")
    if not content or not isinstance(content, str):
        raise HTTPException(status_code=400, detail="Missing content")

    notes = body.get("notes", "").strip()
    spans = _validate_spans(body.get("spans"))
    obs_cov, digestible_flag, total_units = _validate_verdict(body.get("verdict"))

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

    # Git commit with reviewer as author, then sync to origin. A failed
    # push is NOT a failed review (the commit is safe locally), but it must
    # be surfaced - unsynced local reviews never reach the live site.
    # `push: false` defers the push so the client can run it as a separate
    # step (POST /api/sync/push) and show save/push progress distinctly.
    synced, sync_detail = source.commit_review(
        full_hash=full_hash,
        author_name=user["name"],
        author_email=user["email"],
        notes=notes,
        push=bool(body.get("push", True)),
    )

    return JSONResponse(
        {"submitted": True, "synced": synced, "sync_detail": sync_detail}
    )


@app.post("/api/sync/push")
def sync_push(request: Request) -> JSONResponse:
    """Push local ingests commits to origin now. The second phase of a
    review submit (the slow half - a pull-rebase-push can take seconds), so
    the client can report save and push progress separately. Requires
    authentication; local-clone deployments only."""
    _require_user(request)
    if not isinstance(source, LocalIngestSource):
        raise HTTPException(status_code=404, detail="Not found")
    synced, detail = source.push_origin()
    return JSONResponse({"synced": synced, "sync_detail": detail})


@app.get("/api/me/reviews")
def list_my_reviews(request: Request) -> JSONResponse:
    """Return {content_hash: latest_review_iso} for the current user.
    Derived from the ingests repo's git log."""
    user = _require_user(request)
    reviewed = source.reviewed_by_email(user["email"])
    return JSONResponse({"reviewed": reviewed})


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
