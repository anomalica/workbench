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
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

from backend.auth import setup_auth

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
    ) -> None:
        """Commit the current state of the file as a review."""

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
    def reviewed_by_email(self, email: str) -> dict[str, str]:
        """Return {content_hash: latest_review_iso} for this user's reviews."""


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

    def list_ingests(self) -> list[dict]:
        ingests: list[dict] = []
        for content_hash, (_, frontmatter) in self._scan().items():
            authors = frontmatter.get("authors") or []
            if not isinstance(authors, list):
                authors = []
            ingests.append(
                {
                    "content_hash": content_hash,
                    "public_hash": content_hash[:PUBLIC_HASH_LENGTH],
                    "title": frontmatter.get("title", "Untitled"),
                    "authors": authors,
                    "date": frontmatter.get(
                        "date_published", frontmatter.get("date", "")
                    ),
                    "date_ingested": frontmatter.get(
                        "date_extracted", frontmatter.get("date_accessed", "")
                    ),
                    "source_type": frontmatter.get("source_type", ""),
                    "source_url": frontmatter.get("source_url", ""),
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
        ingests.sort(key=lambda x: (x.get("date", ""), x.get("title", "")))
        return ingests

    def get_ingest(self, full_hash: str) -> dict | None:
        entry = self._scan().get(full_hash)
        if entry is None:
            return None
        md_path, _ = entry

        with open(md_path) as f:
            content = f.read()

        frontmatter, body, raw_frontmatter = parse_frontmatter(content)
        authors = frontmatter.pop("authors", None) or []
        if not isinstance(authors, list):
            authors = []
        return {
            "content_hash": full_hash,
            "public_hash": full_hash[:PUBLIC_HASH_LENGTH],
            "copyright_status": frontmatter.get("copyright.status", "restricted"),
            "authors": authors,
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
        subprocess.run(
            ["git", "add", *paths],
            cwd=repo_dir,
            check=True,
            env=env,
        )

        # If save_ingest wrote the same bytes that were already on disk,
        # there's nothing staged. That's the "approved as-is" case - record
        # it as an empty commit so the review is still part of the audit
        # trail and shows up in the same git log as content-changing reviews.
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
        message += "\n\n" + "\n".join(trailers)

        cmd = ["git", "commit", "-m", message]
        if no_changes:
            cmd.append("--allow-empty")
        subprocess.run(cmd, cwd=repo_dir, check=True, env=env)

        # Invalidate the cached review index so the new commit shows up
        # in /api/me/reviews on the next read.
        self._reviewed_cache = None

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

    def commit_review(self, **kwargs: str) -> None:
        raise NotImplementedError("GitHubIngestSource is not yet implemented")

    def load_verification(self, full_hash: str) -> dict | None:
        raise NotImplementedError("GitHubIngestSource is not yet implemented")

    def load_coverage(self, full_hash: str) -> dict | None:
        raise NotImplementedError("GitHubIngestSource is not yet implemented")

    def append_coverage(self, **kwargs: object) -> bool:
        raise NotImplementedError("GitHubIngestSource is not yet implemented")

    def reviewed_by_email(self, email: str) -> dict[str, str]:
        # TODO: query the GitHub REST API for commits authored by this email
        # under store/ in the ingests repo. Returning an empty dict is correct
        # default behaviour - no records show as reviewed until implemented.
        return {}


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
            yaml_path = digests_path / "records" / f"{symlink.stem}.yaml"
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

    # Git commit with reviewer as author
    source.commit_review(
        full_hash=full_hash,
        author_name=user["name"],
        author_email=user["email"],
        notes=notes,
    )

    return JSONResponse({"submitted": True})


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
    return word.strip(string.punctuation + "“”‘’\"'").lower()


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
