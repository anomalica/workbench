#!/usr/bin/env python3
"""Keep the local ingests clone in step with origin - as an OBSERVER.

The single pusher for the ingests clone is the operations auto-push
watcher (anomalica-autopush.service: inotify on .git/logs/HEAD, pushes
within ~2s of any commit, rebasing onto origin only when a push is
rejected). The workbench used to push and rebase too, and the two
processes raced on fetch/rebase ("cannot rebase onto multiple
branches"). So the workbench is now COMMIT-ONLY and this module never
rebases:

- fetch on startup and every few minutes, to see where origin is;
- pull --ff-only when purely behind with a clean tree (a fast-forward
  can't conflict with anything);
- a plain, no-rebase push ONLY when ahead and not behind - reconnect
  recovery for commits made offline, since the watcher only wakes on new
  commits. A concurrent watcher push just wins the race; a rejected
  plain push is reported, never force-resolved here;
- diverged (ahead AND behind) is reported and left for the watcher,
  which integrates on its next push.

The status snapshot drives the header indicator so any divergence is
visible instead of silent. GIT_LOCK serialises this loop against the
request handlers' commits within this process; cross-process safety
comes from never rebasing.
"""

from __future__ import annotations

import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path

GIT_LOCK = threading.RLock()

SYNC_INTERVAL_SECONDS = 180


class SyncManager:
    """Background fetch/observe loop + status snapshot for one git clone."""

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
        """(ahead, behind) of HEAD vs origin/main - no network involved.
        The auto-push watcher shares this clone, so its successful push
        updates origin/main here and ahead drops to 0 without a fetch."""
        out = self._run("rev-list", "--left-right", "--count", "HEAD...origin/main")
        if out.returncode != 0:
            return 0, 0
        ahead, behind = out.stdout.split()
        return int(ahead), int(behind)

    def dirty(self) -> bool:
        """Tracked modifications in the work tree (untracked files don't
        block a fast-forward, so they don't count)."""
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
        """One fetch + observe round. Fast-forwards when purely behind;
        nudges a plain push when purely ahead; never rebases."""
        with GIT_LOCK:
            fetch = self._run("fetch", "origin")
            if fetch.returncode != 0:
                self.offline = True
                self.last_error = (fetch.stderr or fetch.stdout).strip()[-300:]
            else:
                self.offline = False
                self.last_error = ""
                ahead, behind = self.counts()
                if behind and not ahead and not self.dirty():
                    pull = self._run("pull", "--ff-only", "origin", "main")
                    if pull.returncode != 0:
                        self.last_error = (pull.stderr or pull.stdout).strip()[-300:]
                elif ahead and not behind:
                    # Reconnect recovery: the watcher wakes on commits, not on
                    # connectivity, so old offline commits need one nudge. A
                    # plain push cannot corrupt anything - if the watcher gets
                    # there first this is a no-op or a clean rejection.
                    push = self._run("push", "origin", "HEAD")
                    if push.returncode != 0:
                        self.last_error = (push.stderr or push.stdout).strip()[-300:]
            self.checked_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            return self.status()

    def wait_for_push(self, timeout_seconds: float = 12.0) -> tuple[bool, str]:
        """Observe the auto-push watcher landing local commits on origin:
        poll the ahead count until it reaches 0 or the timeout passes.
        Never pushes - the watcher owns that."""
        deadline = datetime.now(timezone.utc).timestamp() + timeout_seconds
        while True:
            ahead, _ = self.counts()
            if ahead == 0:
                return True, ""
            if datetime.now(timezone.utc).timestamp() >= deadline:
                return (
                    False,
                    f"{ahead} commit{'s' if ahead != 1 else ''} committed locally; "
                    "the auto-push watcher hasn't confirmed the push yet",
                )
            self._stop.wait(0.4)

    def _loop(self) -> None:
        while not self._stop.wait(self.interval):
            try:
                self.sync_once()
            except Exception as e:  # noqa: BLE001 - the loop must survive
                self.last_error = str(e)[-300:]

    def start(self) -> None:
        """Run one sync now (startup fetch/fast-forward), then keep
        observing in the background for the life of the process."""
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
