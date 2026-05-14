#!/usr/bin/env python3
"""FastAPI backend for the Anomalica Workbench.

Serves ingests from the anomalica-ingests repository to authenticated
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

CHALLENGES_PER_SESSION = 10
PASS_RATIO = 0.8
MIN_POOL_FOR_CLOZE_GATE = 5
VERIFICATION_SESSION_TTL_SECONDS = 1800

DEFAULT_INGESTS_PATH = Path(__file__).resolve().parents[2] / "anomalica-ingests"
DEFAULT_SOURCES_PATH = Path(__file__).resolve().parents[2] / "sources"


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
            value = value.strip().strip('"').strip("'")
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
            item = line.lstrip()[2:].strip().strip('"').strip("'")
            if item and ":" not in item:
                existing = frontmatter.setdefault(current_parent, [])
                if isinstance(existing, list):
                    existing.append(item)
        # Nested key (indented with spaces)
        elif line.startswith("  ") and ":" in line and current_parent:
            nested_line = line.strip()
            key, _, value = nested_line.partition(":")
            value = value.strip().strip('"').strip("'")
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
    """Reads ingests directly from a local clone of anomalica-ingests.

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
        subprocess.run(
            ["git", "add", str(md_path.relative_to(repo_dir))],
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
        # Reviewed-Record trailer lets _scan_git_reviews attribute the
        # commit to a content_hash even when nothing was staged (empty
        # "approved as-is" commits don't touch any file, so a file-path
        # scan misses them).
        message += f"\n\nReviewed-Record: sha256:{full_hash}"

        cmd = ["git", "commit", "-m", message]
        if no_changes:
            cmd.append("--allow-empty")
        subprocess.run(cmd, cwd=repo_dir, check=True, env=env)

        # Invalidate the cached review index so the new commit shows up
        # in /api/me/reviews on the next read.
        self._reviewed_cache = None

    _reviewed_cache: dict[str, dict[str, str]] | None = None

    def reviewed_by_email(self, email: str) -> dict[str, str]:
        """Return a {content_hash: latest_review_iso} map for this user.
        Empty when the user has no review commits. Built from the
        ingests repo's git log. Cached; commit_review invalidates."""
        target = email.strip().lower()
        if self._reviewed_cache is None:
            self._reviewed_cache = self._scan_git_reviews()
        return dict(self._reviewed_cache.get(target, {}))

    def _scan_git_reviews(self) -> dict[str, dict[str, str]]:
        """Build the reviewer-email to set-of-content-hashes index.

        Two detection paths in priority order:

        1. **Reviewed-Record trailer.** Every commit produced by
           commit_review() now appends `Reviewed-Record: sha256:HASH`
           as a git trailer. Picks up empty "approved as-is" commits
           that don't touch any file.
        2. **File-path scan.** Legacy fallback for commits that
           pre-date the trailer (review commits made before the bug
           fix, and any external commit that touched a store file).
           Maps the touched filename back to a content_hash via the
           current scan index.
        """
        import subprocess

        repo_dir = self.store.parent
        if not (repo_dir / ".git").exists():
            return {}

        out: dict[str, dict[str, str]] = {}

        def record(email: str, content_hash: str, iso_ts: str) -> None:
            bucket = out.setdefault(email, {})
            existing = bucket.get(content_hash)
            # Keep the most recent commit timestamp.
            if existing is None or iso_ts > existing:
                bucket[content_hash] = iso_ts

        # Trailer-based detection. Newest first via default git log order.
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
                    if entry.startswith("sha256:"):
                        entry = entry[len("sha256:") :]
                    if FULL_HASH_PATTERN.match(entry):
                        record(email, entry, iso_ts)

        # File-path detection (legacy fallback for commits without the trailer).
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
                    # Format is "email iso_timestamp" - split on last space.
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
                    record(current_email, content_hash, current_ts)
        return out

    def load_verification(self, full_hash: str) -> dict | None:
        path = self.store / f"{full_hash}.verification.json"
        if not path.exists():
            return None
        with open(path) as f:
            return json.load(f)


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


@app.put("/api/ingests/{full_hash}")
def submit_review(full_hash: str, body: dict, request: Request) -> JSONResponse:
    """Submit a review: save changes and commit with reviewer identity.

    Expects {"content": "...", "notes": "..."}.
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

    if not source.save_ingest(full_hash, content):
        raise HTTPException(status_code=404, detail="Not found")

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
    Derived from the ingests repo's git log - the canonical
    'who reviewed what (and when)' event is the review commit itself."""
    user = _require_user(request)
    reviewed = source.reviewed_by_email(user["email"])
    return JSONResponse({"reviewed": reviewed})


# Verification: cloze-challenge proof of possession.
# Reviewers prove they have the source by filling in N short cloze blanks
# drawn from the body. The sidecar (`{hash}.verification.json`) lives next
# to the record in the ingests store. Answers must never reach the client.
# Mirrors the normalisation in anomalica-ingester/shared/verification.py.

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
