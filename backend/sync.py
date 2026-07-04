#!/usr/bin/env python3
"""Keep the local ingests clone in step with origin.

The local workbench exists to test UI changes, never to hold a private data
state - so the clone must track origin both ways: local review commits push
up immediately (LocalIngestSource.push_origin) and origin advances (edge
reviews from the live site) pull down here. This module adds the down/idle
half: a fetch on startup and every few minutes, pulling with --rebase when
the tree is clean, plus a status snapshot the UI header renders so any
divergence is visible instead of silent.

Guard rails: never force-push, never pull over a dirty tree (the dirt is
surfaced in the status instead), abort a conflicted rebase and report it.

GIT_LOCK serialises every mutating git operation on the clone between the
sync thread and request handlers (commit + push during a review submit), so
a background rebase can never interleave with a review commit.
"""

from __future__ import annotations

import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path

GIT_LOCK = threading.RLock()

SYNC_INTERVAL_SECONDS = 180


class SyncManager:
    """Background fetch/pull loop + status snapshot for one git clone."""

    def __init__(self, repo_dir: Path, interval: int = SYNC_INTERVAL_SECONDS):
        self.repo_dir = Path(repo_dir)
        self.interval = interval
        self.offline = False
        self.last_error = ""
        self.checked_at: str | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def _run(self, *args: str, timeout: int = 120) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["git", *args],
            cwd=self.repo_dir,
            capture_output=True,
            text=True,
            timeout=timeout,
        )

    def counts(self) -> tuple[int, int]:
        """(ahead, behind) of HEAD vs origin/main - no network involved."""
        out = self._run("rev-list", "--left-right", "--count", "HEAD...origin/main")
        if out.returncode != 0:
            return 0, 0
        ahead, behind = out.stdout.split()
        return int(ahead), int(behind)

    def dirty(self) -> bool:
        """Tracked modifications in the work tree (untracked files don't
        block a rebase, so they don't count)."""
        out = self._run("status", "--porcelain")
        return any(
            line and not line.startswith("??") for line in out.stdout.splitlines()
        )

    def status(self) -> dict:
        ahead, behind = self.counts()
        return {
            "ahead": ahead,
            "behind": behind,
            "dirty": self.dirty(),
            "offline": self.offline,
            "last_error": self.last_error,
            "checked_at": self.checked_at,
        }

    def sync_once(self) -> dict:
        """One fetch + (when clean) pull --rebase + push round."""
        with GIT_LOCK:
            fetch = self._run("fetch", "origin")
            if fetch.returncode != 0:
                self.offline = True
                self.last_error = (fetch.stderr or fetch.stdout).strip()[-300:]
            else:
                self.offline = False
                self.last_error = ""
                if not self.dirty():
                    _, behind = self.counts()
                    if behind:
                        # Explicit branch - a bare `pull --rebase origin` reads
                        # FETCH_HEAD, which a concurrent fetch from another
                        # process can turn into "cannot rebase onto multiple
                        # branches".
                        pull = self._run("pull", "--rebase", "origin", "main")
                        if pull.returncode != 0:
                            self._run("rebase", "--abort")
                            self.last_error = (pull.stderr or pull.stdout).strip()[
                                -300:
                            ]
                    ahead, _ = self.counts()
                    if ahead and not self.last_error:
                        push = self._run("push", "origin", "HEAD")
                        if push.returncode != 0:
                            self.last_error = (push.stderr or push.stdout).strip()[
                                -300:
                            ]
            self.checked_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            return self.status()

    def _loop(self) -> None:
        while not self._stop.wait(self.interval):
            try:
                self.sync_once()
            except Exception as e:  # noqa: BLE001 - the loop must survive
                self.last_error = str(e)[-300:]

    def start(self) -> None:
        """Run one sync now (startup pull), then keep syncing in the
        background for the life of the process."""
        if self._thread is not None:
            return
        try:
            self.sync_once()
        except Exception as e:  # noqa: BLE001 - startup must not block serving
            self.last_error = str(e)[-300:]
        self._thread = threading.Thread(
            target=self._loop, daemon=True, name="ingests-sync"
        )
        self._thread.start()
