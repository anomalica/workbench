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

The status snapshot drives the header indicator so any divergence is visible
instead of silent. The repository writer lock serialises this loop against
request commits both within this process and across local Anomalica processes
that share the clone.
"""

from __future__ import annotations

import fcntl
import json
import logging
import os
import secrets
import stat
import subprocess
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

GIT_LOCK = threading.RLock()
_LOCK_STATE = threading.local()
logger = logging.getLogger(__name__)
INDEX_LOCK_WARNING_SECONDS = 300
_OWNER_ATTRIBUTE = "user.anomalica.workbench-index-owner"


def _boot_time_ns() -> int | None:
    """Linux boot boundary; only locks from before it are provably abandoned."""
    try:
        with open("/proc/stat") as proc_stat:
            for line in proc_stat:
                if line.startswith("btime "):
                    return int(line.split()[1]) * 1_000_000_000
    except (OSError, ValueError):
        pass
    return None


def _index_lock_path(repo_dir: Path) -> Path:
    index = subprocess.run(
        ["git", "rev-parse", "--git-path", "index"],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    index_path = Path(index)
    if not index_path.is_absolute():
        index_path = repo_dir / index_path
    return index_path.with_name(f"{index_path.name}.lock")


def _clear_preboot_index_lock(repo_dir: Path) -> bool:
    """Recover a crashed Git index writer without touching a current-boot lock."""
    boot = _boot_time_ns()
    if boot is None:
        return False
    lock = _index_lock_path(repo_dir)
    try:
        info = lock.lstat()
    except FileNotFoundError:
        return False
    # A lock made in this boot may belong to a live Git operation, however
    # old it looks. Refuse symlinks and anything whose ctime is not pre-boot.
    if not stat.S_ISREG(info.st_mode) or info.st_ctime_ns >= boot:
        return False
    lock.unlink()
    _owner_path(lock).unlink(missing_ok=True)
    logger.warning("Cleared pre-boot Git index lock: %s", lock)
    return True


def _index_lock_status(repo_dir: Path) -> dict | None:
    """Local-only warning, not authority to remove an unowned Git lock."""
    try:
        info = _index_lock_path(repo_dir).lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode):
        return {"age_seconds": 0, "long_running": True}
    age = max(0, (time.time_ns() - info.st_ctime_ns) // 1_000_000_000)
    return {
        "age_seconds": age,
        "long_running": age >= INDEX_LOCK_WARNING_SECONDS,
    }


def _owner_path(index_lock: Path) -> Path:
    return index_lock.with_name(f"{index_lock.name}.workbench-owner")


def _recover_owned_index_lock(repo_dir: Path) -> bool:
    """Remove only this Workbench writer's orphan, while holding the repo flock.

    A live writer holds an advisory lock on its owner receipt. Once that process
    dies, the kernel releases the advisory lock; the receipt binds the native
    Git lock to its inode and the ref it was about to update. A changed ref is
    not safe to recover automatically: the commit might already have landed.
    """
    index_lock = _index_lock_path(repo_dir)
    marker = _owner_path(index_lock)
    try:
        owner_fd = os.open(marker, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return False
    with os.fdopen(owner_fd, "rb") as owner:
        try:
            fcntl.flock(owner.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        try:
            receipt = json.load(owner)
        except (ValueError, UnicodeError):
            receipt = None
        try:
            info = index_lock.lstat()
        except FileNotFoundError:
            marker.unlink(missing_ok=True)
            return False
        if not isinstance(receipt, dict) or not stat.S_ISREG(info.st_mode):
            return False
        if (info.st_dev, info.st_ino) != (receipt.get("dev"), receipt.get("ino")):
            return False
        if receipt.get("token"):
            try:
                if (
                    os.getxattr(index_lock, _OWNER_ATTRIBUTE)
                    != receipt["token"].encode()
                ):
                    return False
            except OSError:
                return False
        elif info.st_ctime_ns != receipt.get("ctime_ns"):
            # Fallback on filesystems without user xattrs: refuse a lock that
            # was modified since ownership was recorded rather than guessing.
            return False
        head = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        if head != receipt.get("expected_ref"):
            return False
        index_lock.unlink()
        marker.unlink()
        logger.warning("Recovered dead Workbench Git index writer: %s", index_lock)
        return True


class IndexLockOwner:
    """Process-lifetime proof of ownership for a native Git index lock."""

    def __init__(self, index_lock: Path, lock_fd: int, expected_ref: str):
        self.marker = _owner_path(index_lock)
        self.fd = os.open(
            self.marker, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
        )
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX)
            token = secrets.token_hex(16)
            try:
                os.setxattr(lock_fd, _OWNER_ATTRIBUTE, token.encode())
            except OSError:
                token = ""
            info = os.fstat(lock_fd)
            receipt = json.dumps(
                {
                    "dev": info.st_dev,
                    "ino": info.st_ino,
                    "ctime_ns": info.st_ctime_ns,
                    "token": token,
                    "expected_ref": expected_ref,
                }
            ).encode()
            if os.write(self.fd, receipt) != len(receipt):
                raise OSError("Could not record Git index lock owner")
            os.fsync(self.fd)
        except BaseException:
            self.close()
            raise

    def close(self) -> None:
        self.marker.unlink(missing_ok=True)
        os.close(self.fd)

    def published(self, index_path: Path) -> None:
        """Do not carry the local ownership marker onto Git's ordinary index."""
        try:
            os.removexattr(index_path, _OWNER_ATTRIBUTE)
        except OSError:
            pass  # Git has already published the new index; cleanup is advisory.


@contextmanager
def repository_write_lock(repo_dir: Path):
    """The cross-process writer lock shared by every local ingests mutator."""
    repo_dir = Path(repo_dir)
    with GIT_LOCK:
        depth = getattr(_LOCK_STATE, "depth", 0)
        if depth:
            _LOCK_STATE.depth = depth + 1
            try:
                yield
            finally:
                _LOCK_STATE.depth -= 1
            return

        common = subprocess.run(
            ["git", "rev-parse", "--git-common-dir"],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        common_dir = Path(common)
        if not common_dir.is_absolute():
            common_dir = (repo_dir / common_dir).resolve()
        lock_path = common_dir / "anomalica-write.lock"
        with lock_path.open("a+") as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            _LOCK_STATE.depth = 1
            try:
                _recover_owned_index_lock(repo_dir)
                yield
            finally:
                _LOCK_STATE.depth = 0
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


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
        # A normal `git status` refreshes the index and briefly creates
        # .git/index.lock even on an idle status poll. The UI polls every minute;
        # this monitor must never become an index writer itself.
        out = self._run(
            "--no-optional-locks", "status", "--porcelain", "--untracked-files=no"
        )
        if out.returncode != 0:
            raise RuntimeError(
                f"Cannot inspect ingests working tree: {out.stderr.strip()}"
            )
        return bool(out.stdout.strip())

    def status(self) -> dict:
        ahead, behind = self.counts()
        return {
            "ahead": ahead,
            "behind": behind,
            "dirty": self.dirty(),
            "index_lock": _index_lock_status(self.repo_dir),
            "offline": self.offline,
            "last_error": self.last_error,
            "checked_at": self.checked_at,
        }

    def sync_once(self) -> dict:
        """One fetch + observe round. Fast-forwards when purely behind;
        nudges a plain push when purely ahead; never rebases."""
        # Network operations must not hold the repository writer lock. A fetch
        # or push can consume its full 120-second timeout; review submissions
        # queued behind it then hit their own 120-second browser timeout even
        # though the commit succeeds immediately afterwards. Fetch updates
        # remote refs and push reads local refs, so only the local fast-forward
        # needs exclusion from concurrent commits.
        fetch = self._run("fetch", "origin")
        push_needed = False
        if fetch.returncode != 0:
            self.offline = True
            self.last_error = (fetch.stderr or fetch.stdout).strip()[-300:]
        else:
            self.offline = False
            self.last_error = ""
            with repository_write_lock(self.repo_dir):
                ahead, behind = self.counts()
                if behind and not ahead and not self.dirty():
                    merge = self._run("merge", "--ff-only", "origin/main")
                    if merge.returncode != 0:
                        self.last_error = (merge.stderr or merge.stdout).strip()[-300:]
                elif ahead and not behind:
                    push_needed = True
            if push_needed:
                # Reconnect recovery: the watcher wakes on commits, not on
                # connectivity, so old offline commits need one nudge. A
                # concurrent local commit may join this push safely; a watcher
                # winning the race makes it a no-op or clean rejection.
                push = self._run("push", "origin", "HEAD")
                if push.returncode != 0:
                    self.last_error = (push.stderr or push.stdout).strip()[-300:]
        self.checked_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        return self.status()

    def on_default_branch(self) -> bool:
        """Whether this clone is on the branch the watcher will push."""
        branch = self._run("symbolic-ref", "--short", "HEAD").stdout.strip()
        if not branch:
            return True
        head = self._run(
            "symbolic-ref", "--short", "refs/remotes/origin/HEAD"
        ).stdout.strip()
        default = head.rsplit("/", 1)[-1] if head else "main"
        return branch == default

    def wait_for_push(self, timeout_seconds: float = 12.0) -> tuple[bool, str]:
        """Observe the auto-push watcher landing local commits on origin:
        poll the ahead count until it reaches 0 or the timeout passes.
        Never pushes - the watcher owns that.

        On a working branch there is nothing to wait for: the watcher pushes
        only the default branch, so polling for an ahead count that will never
        fall reported a review as a failed push when it had committed cleanly.
        A checked-out branch means the reviewer is keeping the work local."""
        if not self.on_default_branch():
            return True, "kept local - this clone is on a working branch"
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
        # A crash or power loss can leave Git's O_EXCL index.lock on disk.
        # Unlike our flock writer lock, that file survives a reboot and blocks
        # every later review commit until removed. Only a pre-boot file is safe
        # to clean automatically: no process from that boot can still own it.
        with repository_write_lock(self.repo_dir):
            _clear_preboot_index_lock(self.repo_dir)
        try:
            self.sync_once()
        except Exception as e:  # noqa: BLE001 - startup must not block serving
            self.last_error = str(e)[-300:]
        self._thread = threading.Thread(
            target=self._loop, daemon=True, name="ingests-sync"
        )
        self._thread.start()
