#!/usr/bin/env python3
"""FastAPI backend for the Anomalica Workbench.

Serves ingests from the anomalica-ingests repository to authenticated
reviewers. In local mode reads from a local clone; in remote mode
talks to the GitHub API via a service account. Selected via env vars.

See architecture/review-workbench.md in the anomalica meta-repo for
the full design, particularly the copyright handling section.
"""

from __future__ import annotations

import mimetypes
import os
import re
from abc import ABC, abstractmethod
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

from backend.auth import setup_auth

FULL_HASH_LENGTH = 64
PUBLIC_HASH_LENGTH = 56
FULL_HASH_PATTERN = re.compile(r"^[a-f0-9]{64}$")

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
        # Nested key (indented with spaces)
        elif line.startswith("  ") and ":" in line and current_parent:
            nested_line = line.strip()
            if nested_line.startswith("- "):
                continue  # Skip list items
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
            ingests.append(
                {
                    "content_hash": content_hash,
                    "public_hash": content_hash[:PUBLIC_HASH_LENGTH],
                    "title": frontmatter.get("title", "Untitled"),
                    "date": frontmatter.get(
                        "date_published", frontmatter.get("date", "")
                    ),
                    "source_type": frontmatter.get("source_type", ""),
                    "source_url": frontmatter.get("source_url", ""),
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
        return {
            "content_hash": full_hash,
            "public_hash": full_hash[:PUBLIC_HASH_LENGTH],
            "copyright_status": frontmatter.get("copyright.status", "restricted"),
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

        message = f"review: {title}"
        if notes:
            message += f"\n\n{notes}"

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
        subprocess.run(
            ["git", "commit", "-m", message],
            cwd=repo_dir,
            check=True,
            env=env,
        )


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
