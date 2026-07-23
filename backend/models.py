"""Model-comparison (ADR 0039, Layer 1): detect ingests digested by more than one
model, compare the variants' outputs side by side (aligned by provenance overlap),
and persist a human judgment of which model is better.

Model-variants live OUTSIDE records/ at
``digests/variants/{friendly-name}/{model-id}-{version}.yaml`` (each a full digest
YAML). Reconciliation/canonical (Layer 2) is deferred; this is comparison + judge
only. Judgments persist in a workbench-owned SQLite table (queryable for later
analysis), not the assimilator's graph-curation ledger (a judgment is analysis
about models, not a graph mutation that replays on rebuild).
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import yaml

_ANOMALICA = Path(__file__).resolve().parents[2]


def _variants_dir() -> Path:
    return Path(
        os.environ.get("DIGESTS_VARIANTS", str(_ANOMALICA / "digests" / "variants"))
    )


def _state_dir() -> Path:
    return Path(
        os.environ.get(
            "RUNNER_STATE_DIR",
            str(Path.home() / ".local" / "share" / "anomalica-workbench"),
        )
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# --- variant loading + detection -------------------------------------------


def _load(path: Path) -> dict | None:
    try:
        d = yaml.safe_load(path.read_text())
        return d if isinstance(d, dict) else None
    except (OSError, yaml.YAMLError):
        return None


def _claims(v: dict) -> list[dict]:
    return (v.get("domain_claims") or []) + (v.get("infrastructure_claims") or [])


def _content_hash(v: dict) -> str:
    return ((v.get("record") or {}).get("content_hash") or "").removeprefix("sha256:")


def _store_dir() -> Path:
    """The ACTIVE record store. Archiving moves a record to store/v1/ and deletes
    its records/ symlink, so presence here is what "in the active corpus" means -
    and a name-based lookup through records/ cannot tell you, because the symlink
    is exactly what archiving removes."""
    return (
        Path(
            os.environ.get(
                "INGESTS_PATH", str(Path(__file__).resolve().parents[2] / "ingests")
            )
        )
        / "store"
    )


def _is_active(content_hash: str) -> bool:
    """Is this record still in the active corpus? Resolve by CONTENT HASH against
    store/, never by directory name: the variants directory is named for a record
    and keeps that name after the record is archived out from under it."""
    if not content_hash:
        return False
    return (_store_dir() / f"{content_hash}.md").is_file() or (
        _store_dir() / f"{content_hash}.v2.md"
    ).is_file()


def _variant_dirs() -> list[Path]:
    base = _variants_dir()
    if not base.exists():
        return []
    return sorted(d for d in base.iterdir() if d.is_dir())


# list_comparable parses EVERY variant YAML just to read a title and model name
# - ~6s over 45 files, on every call, which held the Digests tab on its empty
# state long enough to read as "no data". The parse only changes when a variant
# file does, so the result is cached against a signature of (path, mtime, size)
# for every yaml under variants/. Any add/remove/rewrite changes the signature
# and recomputes; an archived record flips _is_active, which is why the records/
# directory mtime joins the signature.
_comparable_cache: tuple | None = None


def _comparable_signature() -> tuple:
    sig = []
    for d in _variant_dirs():
        for f in sorted(d.glob("*.yaml")):
            try:
                st = f.stat()
                sig.append((str(f), st.st_mtime_ns, st.st_size))
            except OSError:
                continue
    # _is_active resolves against store/, so that directory's mtime is the
    # invalidation signal for archive/unarchive (a store file added or removed
    # touches the dir).
    try:
        sig.append(("store", _store_dir().stat().st_mtime_ns))
    except OSError:
        pass
    return tuple(sig)


def list_comparable() -> list[dict]:
    """Ingests that have more than one model-variant digest, for the compare list.
    Each: {content_hash, title, slug, models:[...], variant_count}."""
    global _comparable_cache
    sig = _comparable_signature()
    if _comparable_cache is not None and _comparable_cache[0] == sig:
        return _comparable_cache[1]
    out = []
    for d in _variant_dirs():
        files = sorted(d.glob("*.yaml"))
        if len(files) < 2:
            continue
        variants = [(f, _load(f)) for f in files]
        variants = [(f, v) for f, v in variants if v]
        if len(variants) < 2:
            continue
        first = variants[0][1]
        # Archived records are not offered. Mark archived pantex while its
        # variants stayed on disk, so the list kept advertising it and opening it
        # 404'd - the audit resolves a record by name through records/, and
        # archiving deletes that symlink. Choosing a model for a record that has
        # been dropped from the corpus is wasted grading either way.
        if not _is_active(_content_hash(first)):
            continue
        out.append(
            {
                "content_hash": _content_hash(first),
                "title": (first.get("record") or {}).get("title") or d.name,
                "slug": d.name,
                "models": [v.get("model") or f.stem for f, v in variants],
                "variant_count": len(variants),
            }
        )
    out.sort(key=lambda x: x["title"].lower())
    _comparable_cache = (sig, out)
    return out


def _metrics(d: Path) -> dict:
    """The optional per-variant metrics sidecar (wall-time etc.), or {}."""
    m = _load(d / "metrics.json")
    return m if isinstance(m, dict) else {}


def _wall_seconds(metrics: dict, model: str, prompt_variant: str, stem: str):
    """Best-effort wall_seconds for a variant from the metrics sidecar, tolerant
    of its keying (by model id, by filename stem, or a list of entries)."""
    if not metrics:
        return None
    candidates = []
    if isinstance(metrics, dict):
        for key in (model, stem, f"{model}-{prompt_variant}"):
            if key and isinstance(metrics.get(key), dict):
                candidates.append(metrics[key])
        if isinstance(metrics.get("variants"), list):
            candidates.extend(metrics["variants"])
    for c in candidates:
        if not isinstance(c, dict):
            continue
        if c.get("model") and c["model"] != model:
            continue
        for k in ("wall_seconds", "wall_time", "seconds", "duration_s"):
            if isinstance(c.get(k), (int, float)):
                return float(c[k])
    return None


def _find_variants(content_hash: str) -> tuple[Path | None, list[dict]]:
    """The variant dir + a list of {model, prompt_variant, stem, data} for an
    ingest, located by content_hash."""
    for d in _variant_dirs():
        files = sorted(d.glob("*.yaml"))
        loaded = [(f, _load(f)) for f in files]
        loaded = [(f, v) for f, v in loaded if v]
        if loaded and _content_hash(loaded[0][1]) == content_hash:
            return d, [
                {
                    "model": v.get("model") or f.stem,
                    "prompt_variant": v.get("prompt_variant"),
                    "stem": f.stem,
                    "data": v,
                }
                for f, v in loaded
            ]
    return None, []


# --- provenance-overlap alignment ------------------------------------------

_TS = re.compile(r"(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?")


def _to_seconds(token: str) -> float | None:
    m = _TS.fullmatch(token.strip())
    if not m:
        return None
    h, mnt, s, frac = m.groups()
    total = (int(h or 0) * 3600) + int(mnt) * 60 + int(s)
    if frac:
        total += float("0." + frac)
    return total


def _interval(location) -> tuple[float, float] | None:
    """Parse a claim location ('00:01:02.3-00:01:10.0', 'page 21') to a numeric
    interval for overlap, or None if it isn't a parseable range."""
    if not location:
        return None
    loc = str(location)
    parts = loc.split("-")
    if len(parts) == 2:
        a, b = _to_seconds(parts[0]), _to_seconds(parts[1])
        if a is not None and b is not None:
            return (min(a, b), max(a, b))
    pages = re.findall(r"\d+", loc)  # 'page 21' / 'p21-23' -> page numbers
    if pages:
        nums = [int(n) for n in pages]
        return (float(min(nums)), float(max(nums)))
    return None


def _overlaps(a, b) -> bool:
    ia, ib = _interval(a), _interval(b)
    if ia and ib:
        return ia[0] <= ib[1] and ib[0] <= ia[1]
    return bool(a) and str(a).strip() == str(b).strip()  # fall back to exact location


def _claim_view(c: dict) -> dict:
    sp = c.get("speaker")
    return {
        "id": c.get("id"),
        "type": c.get("type"),
        "location": c.get("location"),
        "text": c.get("text"),
        "quote": c.get("quote"),
        "speaker": sp.get("name") if isinstance(sp, dict) else sp,
        "refs": [r.get("name") for r in (c.get("refs") or []) if isinstance(r, dict)],
    }


def load_comparison(content_hash: str) -> dict | None:
    """Side-by-side comparison of an ingest's model-variants. Each model's claims
    are tagged shared (a provenance-overlapping claim exists in another model) or
    unique. Entities are aligned by name. None if fewer than two variants."""
    vdir, variants = _find_variants(content_hash)
    if len(variants) < 2:
        return None
    metrics = _metrics(vdir) if vdir else {}

    first = variants[0]["data"]
    title = (first.get("record") or {}).get("title") or content_hash[:12]
    per_model = []
    claims_by_model = {var["model"]: _claims(var["data"]) for var in variants}

    for var in variants:
        model, v = var["model"], var["data"]
        mine = _claims(v)
        others = [c for m2, cs in claims_by_model.items() if m2 != model for c in cs]
        claims = []
        shared = 0
        for c in mine:
            is_shared = any(
                _overlaps(c.get("location"), o.get("location")) for o in others
            )
            shared += is_shared
            claims.append({**_claim_view(c), "shared": is_shared})
        nodes = v.get("nodes") or []
        per_model.append(
            {
                "model": model,
                "prompt_variant": var.get("prompt_variant"),
                "domain_count": len(v.get("domain_claims") or []),
                "infra_count": len(v.get("infrastructure_claims") or []),
                "claim_count": len(mine),
                "node_count": len(nodes),
                "shared_count": shared,
                "unique_count": len(mine) - shared,
                "extracted_at": v.get("extracted_at"),
                "wall_seconds": _wall_seconds(
                    metrics, model, var.get("prompt_variant") or "", var["stem"]
                ),
                "claims": claims,
                "node_names": sorted(
                    {
                        n.get("name")
                        for n in nodes
                        if isinstance(n, dict) and n.get("name")
                    }
                ),
            }
        )

    # Entity alignment: which models extracted each entity name.
    all_names: dict[str, list[str]] = {}
    for m in per_model:
        for name in m["node_names"]:
            all_names.setdefault(name, []).append(m["model"])
    entities = sorted(
        ({"name": name, "models": models} for name, models in all_names.items()),
        key=lambda e: (-len(e["models"]), e["name"].lower()),
    )

    return {
        "content_hash": content_hash,
        "title": title,
        "models": [m["model"] for m in per_model],
        "per_model": per_model,
        "entities": entities,
    }


# --- judgment store (workbench-owned SQLite, queryable) ---------------------


def _conn() -> sqlite3.Connection:
    p = _state_dir() / "judgments.db"
    p.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(p)
    con.row_factory = sqlite3.Row
    con.execute(
        "CREATE TABLE IF NOT EXISTS model_judgments ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " content_hash TEXT NOT NULL,"
        " models_compared TEXT NOT NULL,"
        " chosen_model TEXT NOT NULL,"
        " judged_by TEXT,"
        " created_at TEXT NOT NULL,"
        " notes TEXT)"
    )
    return con


def save_judgment(
    content_hash: str,
    models_compared: list[str],
    chosen_model: str,
    judged_by: str = "",
    notes: str = "",
) -> dict:
    """Persist a 'which model is better' judgment. Validated; returns the row."""
    if not content_hash or not chosen_model:
        return {"ok": False, "error": "content_hash and chosen_model are required"}
    if models_compared and chosen_model not in models_compared:
        return {"ok": False, "error": "chosen_model must be one of the models compared"}
    row = {
        "content_hash": content_hash,
        "models_compared": models_compared,
        "chosen_model": chosen_model,
        "judged_by": judged_by,
        "created_at": _now(),
        "notes": notes,
    }
    con = _conn()
    try:
        con.execute(
            "INSERT INTO model_judgments"
            " (content_hash, models_compared, chosen_model, judged_by, created_at, notes)"
            " VALUES (?,?,?,?,?,?)",
            (
                content_hash,
                json.dumps(models_compared),
                chosen_model,
                judged_by,
                row["created_at"],
                notes,
            ),
        )
        con.commit()
    finally:
        con.close()
    return {"ok": True, **row}


def latest_judgment(content_hash: str) -> dict | None:
    """The most recent judgment for an ingest, or None."""
    con = _conn()
    try:
        r = con.execute(
            "SELECT content_hash, models_compared, chosen_model, judged_by, created_at, notes"
            " FROM model_judgments WHERE content_hash = ?"
            " ORDER BY created_at DESC, id DESC LIMIT 1",
            (content_hash,),
        ).fetchone()
    finally:
        con.close()
    if not r:
        return None
    d = dict(r)
    try:
        d["models_compared"] = json.loads(d["models_compared"])
    except (json.JSONDecodeError, TypeError):
        d["models_compared"] = []
    return d
