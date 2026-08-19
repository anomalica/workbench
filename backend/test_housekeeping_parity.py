"""The Python and TypeScript applies must agree, byte for byte.

edge/lib/housekeeping.ts is a hand port of anomalica_common.housekeeping.apply_items,
and it exists only because production runs no Python. Two implementations of the one
function that guarantees housekeeping never touches prose is a standing drift risk,
and parallel unit suites do not close it - they can both pass while disagreeing on a
case neither thought to cover.

This runs BOTH over the same inputs and compares the output text exactly. It uses the
real store when it is present, so the cases are whatever the corpus actually contains
rather than what someone imagined.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest
from anomalica_common import housekeeping as hk

EDGE = Path(__file__).resolve().parents[1] / "edge"
INGESTS = Path(
    __import__("os").environ.get(
        "INGESTS_PATH", str(Path.home() / "repos" / "anomalica" / "ingests")
    )
)

RUNNER = """
import { applyItems } from "./lib/housekeeping.ts";
const cases = JSON.parse(await Deno.readTextFile(Deno.args[0]));
const out = [];
for (const c of cases) {
  try {
    out.push({ name: c.name, text: await applyItems(c.original, c.items) });
  } catch (e) {
    out.push({ name: c.name, error: String(e && e.constructor && e.constructor.name) });
  }
}
console.log(JSON.stringify(out));
"""

SYNTHETIC = """---
title: 'A Record (1967)'
publisher: 'Eyes On Cinema'
date_published: '2026-08-11'
source_type: 'video'
content_hash: 'sha256:abc'
---

Body prose that must survive untouched.

***

A thematic break.
"""


def _item(**over):
    d = {
        "id": "i",
        "check": "c",
        "field": "publisher",
        "to_field": "posted_by",
        "operation": "move",
        "current": "Eyes On Cinema",
        "proposed": "Eyes On Cinema",
        "confidence": "high",
        "evidence": {"reasoning": "r"},
        "status": "approved",
    }
    d.update(over)
    return d


def _to_items(dicts: list[dict]) -> list[hk.Item]:
    return [
        hk.Item(
            id=d["id"],
            check=d["check"],
            field=d["field"],
            operation=d["operation"],
            current=d["current"],
            proposed=d["proposed"],
            confidence=d["confidence"],
            evidence=hk.Evidence(reasoning=d["evidence"]["reasoning"]),
            status=d["status"],
            to_field=d.get("to_field"),
        )
        for d in dicts
    ]


def _cases(tmp_path: Path) -> list[dict]:
    """Real records that carry proposals, plus synthetic edge shapes."""
    cases: list[dict] = []

    # The real committed sidecars, paired with their records. Using what is on
    # disk rather than re-deriving proposals keeps this test independent of the
    # scheduler repo, and exercises exactly the proposals a reviewer will approve.
    store = INGESTS / "store"
    if store.exists():
        for sc_path in sorted(store.glob("*.housekeeping.json")):
            sc = hk.load_sidecar_file(sc_path)
            if sc is None or not sc.items:
                continue
            stem = sc_path.name.removesuffix(".housekeeping.json")
            record = next(iter(sorted(store.glob(f"{stem}*.md"))), None)
            if record is None:
                continue
            for i in sc.items:
                i.status = "approved"
            cases.append(
                {
                    "name": record.name,
                    "original": record.read_text(errors="replace"),
                    "items": [_json_item(i) for i in sc.items],
                }
            )

    synth = tmp_path / "synthetic.md"
    synth.write_text(SYNTHETIC)
    for name, items in (
        ("move-only", [_item()]),
        (
            "set-absent",
            [
                _item(
                    id="s",
                    field="container_title",
                    operation="set",
                    to_field=None,
                    current=None,
                    proposed="A Programme",
                )
            ],
        ),
        ("clear", [_item(id="c", operation="clear", to_field=None)]),
        ("quoted-value", [_item(id="q", proposed='a "quoted" name')]),
        ("rejected-noop", [_item(id="r", status="rejected")]),
        (
            "year-string",
            [
                _item(
                    id="y",
                    field="date_published",
                    operation="set",
                    to_field=None,
                    current=None,
                    proposed="1967",
                )
            ],
        ),
    ):
        cases.append({"name": name, "original": SYNTHETIC, "items": items})
    return cases


def _json_item(i: hk.Item) -> dict:
    return {
        "id": i.id,
        "check": i.check,
        "field": i.field,
        "to_field": i.to_field,
        "operation": i.operation,
        "current": i.current,
        "proposed": i.proposed,
        "confidence": i.confidence,
        "evidence": {"reasoning": i.evidence.reasoning},
        "status": i.status,
    }


@pytest.mark.skipif(shutil.which("deno") is None, reason="deno not installed")
def test_python_and_typescript_apply_identically(tmp_path: Path):
    cases = _cases(tmp_path)
    assert cases, "no cases to compare"

    infile = tmp_path / "cases.json"
    infile.write_text(json.dumps(cases))
    runner = tmp_path / "run.ts"
    runner.write_text(RUNNER)
    # The runner imports ./lib/housekeeping.ts, so it has to live in edge/.
    local = EDGE / "_parity_run.ts"
    local.write_text(RUNNER)
    try:
        proc = subprocess.run(
            ["deno", "run", "--allow-read", str(local), str(infile)],
            cwd=EDGE,
            capture_output=True,
            text=True,
            timeout=120,
        )
    finally:
        local.unlink(missing_ok=True)
    assert proc.returncode == 0, proc.stderr[-2000:]
    ts = {r["name"]: r for r in json.loads(proc.stdout)}

    diverged = []
    for case in cases:
        items = _to_items(case["items"])
        src = tmp_path / "rec.md"
        src.write_text(case["original"])
        try:
            py_out = {"text": hk.apply_items(src, items)}
        except hk.MultilineField:
            py_out = {"error": "MultilineField"}
        except hk.BodyChanged:
            py_out = {"error": "BodyChanged"}

        got = ts[case["name"]]
        if py_out.get("text") != got.get("text") or (
            ("error" in py_out) != ("error" in got)
        ):
            diverged.append(case["name"])

    assert not diverged, (
        f"{len(diverged)} of {len(cases)} cases diverged between the Python and "
        f"TypeScript applies: {diverged[:5]}"
    )
