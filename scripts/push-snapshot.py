#!/usr/bin/env python3
"""Push a built tree (the static-read SPA + the pre-rendered snapshot) to a Bunny
Storage zone, via concurrent PUTs. Deploy glue for the serverless workbench: run
after `vite build` (VITE_STATIC_READS=1) + `python -m backend.prerender <dir>`.

Creds come from the env and are NEVER logged. Decrypt them from the Safe first:

    cd ~/repos/secrets
    export SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt
    export BUNNY_STORAGE_HOST="$(sops -d --extract '["BUNNY_WB_STORAGE_HOST"]' store/anomalica.yaml)"
    export BUNNY_STORAGE_PASSWORD="$(sops -d --extract '["BUNNY_WB_STORAGE_PASSWORD"]' store/anomalica.yaml)"
    export BUNNY_STORAGE_ZONE=anomalica-wb
    python scripts/push-snapshot.py path/to/dist

storage.bunnycdn.com round-robins to several IPs, some of which can be
unreachable from a given network, so each file is retried (a retry usually lands
on a healthy IP). PUTs are idempotent, so re-running is safe.

After uploading it PURGES the pull zone and ASSERTS that the public host now
serves the bundle just uploaded, failing loudly if it does not. Both halves are
needed: an unpurged deploy is invisible, and a purge nobody verifies fails the
same silent way. Set BUNNY_API_KEY (the account key, not the storage password)
to enable them; without it the script says plainly that it did not purge rather
than implying the deploy is live.
"""

from __future__ import annotations

import concurrent.futures
import mimetypes
import os
import re
import socket
import sys
import time
import urllib.request
from pathlib import Path

# storage.bunnycdn.com publishes AAAA records that are often unreachable from a
# v4-only path ("No route to host"); pin resolution to IPv4 so every connection
# lands on a reachable address instead of retrying past dead v6 IPs.
_orig_getaddrinfo = socket.getaddrinfo


def _ipv4_only(host, port, family=0, *args, **kwargs):
    return _orig_getaddrinfo(host, port, socket.AF_INET, *args, **kwargs)


socket.getaddrinfo = _ipv4_only

HOST = os.environ.get("BUNNY_STORAGE_HOST", "storage.bunnycdn.com")
ZONE = os.environ["BUNNY_STORAGE_ZONE"]
KEY = os.environ["BUNNY_STORAGE_PASSWORD"]
ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else "dist")
WORKERS = int(os.environ.get("PUSH_WORKERS", "8"))

# Purge + verify. Optional only in the sense that a push without them still
# uploads; if they are absent the script says so rather than implying the deploy
# is visible. BUNNY_API_KEY is the account key (not the storage password).
API_KEY = os.environ.get("BUNNY_API_KEY", "")
PULLZONE = os.environ.get("BUNNY_PULLZONE_ID", "6043673")  # anomalica-wb
PUBLIC_URL = os.environ.get("BUNNY_PUBLIC_URL", "https://workbench.anomalica.is/")
ASSET_RE = re.compile(rb"/assets/index-[A-Za-z0-9_-]+\.js")


def put(path: Path) -> tuple[str, object]:
    rel = path.relative_to(ROOT).as_posix()
    content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    body = path.read_bytes()
    last: object = "no attempt"
    for attempt in range(6):
        req = urllib.request.Request(
            f"https://{HOST}/{ZONE}/{rel}",
            data=body,
            method="PUT",
            headers={"AccessKey": KEY, "Content-Type": content_type},
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return rel, resp.status
        except Exception as exc:  # noqa: BLE001 - retry any transport error
            last = f"ERR {exc}"
            time.sleep(0.3 * (attempt + 1))
    return rel, last


def local_entry_asset() -> bytes | None:
    """The hashed entry bundle this push is shipping, read from its index.html.

    None when the tree has no index.html - a snapshot-only push has nothing to
    assert against, and inventing a pass there would be worse than saying so.
    """
    index = ROOT / "index.html"
    if not index.is_file():
        return None
    found = ASSET_RE.search(index.read_bytes())
    return found.group(0) if found else None


def purge() -> bool:
    req = urllib.request.Request(
        f"https://api.bunny.net/pullzone/{PULLZONE}/purgeCache",
        data=b"",
        method="POST",
        headers={"AccessKey": API_KEY},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.status in (200, 204)
    except Exception as exc:  # noqa: BLE001
        print(f"  purge FAILED: {exc}")
        return False


def served_entry_asset() -> bytes | None:
    req = urllib.request.Request(
        f"{PUBLIC_URL}?deploy-check={int(time.time())}",
        headers={"Cache-Control": "no-cache"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            found = ASSET_RE.search(resp.read())
            return found.group(0) if found else None
    except Exception as exc:  # noqa: BLE001
        print(f"  verify FAILED: {exc}")
        return None


def confirm_visible(expected: bytes) -> int:
    """Assert the public host now serves the bundle we just uploaded.

    A purge you forget to verify fails the same silent way an unpurged deploy
    does. This cost a day: the upload succeeded, `/` kept serving a month-old
    cached entry, and every rendered check passed because it happened to hit a
    path with no cache entry. The asset hash is the check that cannot be fooled,
    and uniquely it is comparable ACROSS paths - a per-path cache can serve two
    URLs different bundles, but it cannot make them agree on a stale name.
    """
    for attempt in range(6):
        live = served_entry_asset()
        if live == expected:
            print(f"  verified: {PUBLIC_URL} serves {expected.decode()}")
            return 0
        time.sleep(2 * (attempt + 1))
    print(f"  MISMATCH: uploaded {expected.decode()}, public host serves {live!r}")
    print("  The deploy is NOT visible. Do not report it as shipped.")
    return 1


def main() -> int:
    files = [p for p in ROOT.rglob("*") if p.is_file()]
    ok = 0
    errs: list[tuple[str, object]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for rel, status in pool.map(put, files):
            if status in (200, 201):
                ok += 1
            else:
                errs.append((rel, status))
    print(f"uploaded {ok}/{len(files)} to {ZONE}")
    for rel, status in errs[:20]:
        print("  FAIL", rel, status)
    if errs:
        return 1

    if not API_KEY:
        print("  NOT PURGED: set BUNNY_API_KEY to purge and verify.")
        print("  Until the cache expires, readers may keep the previous build.")
        return 0

    print(f"  purging pull zone {PULLZONE}...")
    if not purge():
        return 1

    expected = local_entry_asset()
    if expected is None:
        print("  purged. No index.html in this tree, so nothing to verify.")
        return 0
    return confirm_visible(expected)


if __name__ == "__main__":
    raise SystemExit(main())
