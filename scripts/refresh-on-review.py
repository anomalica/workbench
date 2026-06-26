#!/usr/bin/env python3
"""Watch the ingests repo for review commits and incrementally refresh the
workbench snapshot on the CDN - so a reviewer's submitted edit shows on reload in
seconds, instead of waiting for a full local rebuild.

Each cycle: fetch origin/main; if it advanced, diff the new commits for changed
store/{hash}.md / {hash}.v2.md records, fast-forward the local clone, re-render
JUST those records (backend.prerender records-only, graph untouched), push the
changed JSON to Bunny Storage, and purge those URLs. The graph snapshot is left
alone (a review never changes the graph - that is the re-digest's job).

Run as a local daemon (the rebuild-pipeline layer). Creds from env - decrypt from
the Safe first:

    cd ~/repos/secrets && export SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt
    export BUNNY_STORAGE_HOST="$(sops -d --extract '["BUNNY_WB_STORAGE_HOST"]' store/anomalica.yaml)"
    export BUNNY_STORAGE_PASSWORD="$(sops -d --extract '["BUNNY_WB_STORAGE_PASSWORD"]' store/anomalica.yaml)"
    export BUNNY_API_KEY="$(sops -d --extract '["BUNNY_API_KEY"]' store/anomalica.yaml)"
    export BUNNY_STORAGE_ZONE=anomalica-wb BUNNY_PULL_ZONE_ID=6043673
    export INGESTS_DIR=~/repos/anomalica/ingests SNAPSHOT_DIR=/tmp/wb-snapshot
    python workbench/scripts/refresh-on-review.py

Env: INGESTS_DIR, SNAPSHOT_DIR, BUNNY_STORAGE_HOST (default storage.bunnycdn.com),
BUNNY_STORAGE_ZONE, BUNNY_STORAGE_PASSWORD, BUNNY_API_KEY, BUNNY_PULL_ZONE_ID,
POLL_SECONDS (default 15), SSH_AUTH_SOCK (for git over ssh).
"""

from __future__ import annotations

import mimetypes
import os
import re
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

# storage.bunnycdn.com round-robins to occasionally-unreachable IPv6 IPs; pin v4.
_orig = socket.getaddrinfo
socket.getaddrinfo = lambda h, p, f=0, *a, **k: _orig(h, p, socket.AF_INET, *a, **k)

INGESTS = Path(
    os.environ.get("INGESTS_DIR", str(Path.home() / "repos/anomalica/ingests"))
)
SNAPSHOT = Path(os.environ.get("SNAPSHOT_DIR", "/tmp/wb-snapshot"))
STORAGE_HOST = os.environ.get("BUNNY_STORAGE_HOST", "storage.bunnycdn.com")
ZONE = os.environ["BUNNY_STORAGE_ZONE"]
STORAGE_KEY = os.environ["BUNNY_STORAGE_PASSWORD"]
API_KEY = os.environ["BUNNY_API_KEY"]
PULL_ZONE_ID = os.environ["BUNNY_PULL_ZONE_ID"]
PULL_HOST = os.environ.get("BUNNY_WB_PULL_HOST", f"{ZONE}.b-cdn.net")
POLL = int(os.environ.get("POLL_SECONDS", "15"))

RECORD_RE = re.compile(r"^store/([a-f0-9]{64})(?:\.v\d+)?\.md$")


def _git(*args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(INGESTS), *args],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def advance_to_origin() -> None:
    """Bring local main up to origin/main.

    Fast-forwards in the normal case. When the clone carries a local-only
    commit (e.g. a .githooksrc policy override), the branch has diverged and
    `merge --ff-only` aborts every cycle - silently wedging the daemon and
    leaving the workbench reading a stale clone. Fall back to rebasing the
    local commit onto origin so the clone keeps advancing. On an unexpected
    conflict, abort so the clone stays clean and the error surfaces rather
    than leaving a half-applied rebase behind.
    """
    try:
        _git("merge", "--ff-only", "origin/main")
    except subprocess.CalledProcessError:
        try:
            _git("rebase", "origin/main")
        except subprocess.CalledProcessError:
            _git("rebase", "--abort")
            raise


def changed_record_hashes(old: str, new: str) -> set[str]:
    """Content hashes of records touched by commits in old..new."""
    out: set[str] = set()
    for line in _git("diff", "--name-only", f"{old}..{new}").splitlines():
        m = RECORD_RE.match(line.strip())
        if m:
            out.add(m.group(1))
    return out


def _put(rel: str, body: bytes) -> int:
    ct = mimetypes.guess_type(rel)[0] or "application/octet-stream"
    req = urllib.request.Request(
        f"https://{STORAGE_HOST}/{ZONE}/{rel}",
        data=body,
        method="PUT",
        headers={"AccessKey": STORAGE_KEY, "Content-Type": ct},
    )
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status
        except Exception:  # noqa: BLE001 - retry transient/dead-IP failures
            time.sleep(0.3 * (attempt + 1))
    return 0


def _purge(url: str) -> None:
    req = urllib.request.Request(
        f"https://api.bunny.net/purge?url={urllib.parse.quote(url, safe='')}",
        method="POST",
        headers={"AccessKey": API_KEY},
    )
    try:
        urllib.request.urlopen(req, timeout=30).read()
    except Exception:  # noqa: BLE001
        pass


def push_record_files(hashes: set[str]) -> int:
    """Push the re-rendered JSON for the changed records + the always-rewritten
    ingests.json, and purge each. Returns the count of files pushed."""
    api = SNAPSHOT / "api"
    rels = ["ingests.json"]
    for h in hashes:
        rels += [
            f"ingests/{h}.json",
            f"ingests/{h}/digest.json",
            f"ingests/{h}/coverage.json",
        ]
    pushed = 0
    for rel in rels:
        f = api / rel
        if not f.is_file():
            continue
        if _put(f"api/{rel}", f.read_bytes()) in (200, 201):
            pushed += 1
            _purge(f"https://{PULL_HOST}/api/{rel}")
    return pushed


def main() -> int:
    from backend.prerender import prerender_records_only

    print(f"refresh-on-review: watching {INGESTS} -> {ZONE} (poll {POLL}s)", flush=True)
    last = _git("rev-parse", "HEAD")
    while True:
        try:
            _git("fetch", "--quiet", "origin", "main")
            remote = _git("rev-parse", "origin/main")
            if remote != last:
                hashes = changed_record_hashes(last, remote)
                advance_to_origin()
                last = remote
                if hashes:
                    prerender_records_only(SNAPSHOT, list(hashes))
                    n = push_record_files(hashes)
                    print(
                        f"refreshed {len(hashes)} record(s) ({n} files): "
                        f"{', '.join(h[:12] for h in hashes)}",
                        flush=True,
                    )
        except subprocess.CalledProcessError as e:
            print(f"git error: {e.stderr.strip()}", file=sys.stderr, flush=True)
        except Exception as e:  # noqa: BLE001 - keep the daemon alive
            print(f"cycle error: {e}", file=sys.stderr, flush=True)
        time.sleep(POLL)


if __name__ == "__main__":
    raise SystemExit(main())
