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
"""

from __future__ import annotations

import concurrent.futures
import mimetypes
import os
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
    return 1 if errs else 0


if __name__ == "__main__":
    raise SystemExit(main())
