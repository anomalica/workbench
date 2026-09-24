"""The record-level access gate across record generations.

record/1 and record/2 state it at `copyright.status`. record/3 states it on
each Asset (decision 0051), so a consumer reading only the legacy field gates
that whole generation closed - a publicly_accessible YouTube transcript read as
`restricted` while its record/2 twin was public.
"""

import backend.server as server

LEGACY = "---\ntitle: A Record\ncopyright:\n  status: {status}\n---\nbody\n"

RECORD3 = """---
schema: anomalica/record/3
title: A Video
source_type: video
assets:
- asset_hash: sha256:aaaa
  file_format: opus
  source_type: video
  copyright:
    status: {first}
- asset_hash: sha256:bbbb
  file_format: opus
  source_type: video
  copyright:
    status: {second}
selection:
- asset_hash: sha256:aaaa
  selector:
    type: whole
- asset_hash: sha256:bbbb
  selector:
    type: whole
---

body
"""

RECORD3_ONE = """---
schema: anomalica/record/3
title: A Video
source_type: video
assets:
- asset_hash: sha256:aaaa
  file_format: opus
  source_type: video
  copyright:
    status: {status}
selection:
- asset_hash: sha256:aaaa
  selector:
    type: whole
{extra}---

body
"""


def _gate(text: str) -> str:
    frontmatter, _body, raw = server.parse_frontmatter(text)
    return server.record_copyright_status(frontmatter, raw)


def test_legacy_status_is_the_gate_for_record_1_and_2():
    assert _gate(LEGACY.format(status="publicly_accessible")) == "publicly_accessible"
    assert _gate(LEGACY.format(status="licensed")) == "licensed"


def test_absent_status_fails_closed():
    assert _gate("---\ntitle: A Record\n---\nbody\n") == "restricted"


def test_record_3_reads_the_asset_status():
    # The two broken records: a YouTube transcript whose Asset says
    # publicly_accessible, with no top-level copyright block at all.
    assert _gate(RECORD3_ONE.format(status="publicly_accessible", extra="")) == (
        "publicly_accessible"
    )


def test_a_licensed_record_3_stays_gated():
    # The ebook ingested alongside them must not open with the videos.
    assert _gate(RECORD3_ONE.format(status="licensed", extra="")) == "licensed"


def test_mixed_asset_rights_project_to_the_most_restrictive():
    # One scalar cannot express mixed rights; the body is derived from all of
    # the Assets, and over-gating is recoverable where a leak is not.
    assert (
        _gate(RECORD3.format(first="publicly_accessible", second="licensed"))
        == "licensed"
    )
    assert (
        _gate(RECORD3.format(first="restricted", second="public_domain"))
        == "restricted"
    )


def test_a_record_level_value_may_tighten_but_not_widen():
    # ingest-format.md: "no Record-level value may widen a member decision".
    extra = "copyright:\n  status: restricted\n"
    assert _gate(RECORD3_ONE.format(status="publicly_accessible", extra=extra)) == (
        "restricted"
    )
    extra = "copyright:\n  status: public_domain\n"
    assert _gate(RECORD3_ONE.format(status="licensed", extra=extra)) == "licensed"


def test_an_unknown_asset_status_is_not_an_opening():
    # Whatever it means, it is not on the serving allow-lists, so it gates.
    text = RECORD3_ONE.format(status="who_knows", extra="")
    assert _gate(text) == "who_knows"
    # An Asset with no status at all fails closed rather than inheriting open.
    text = RECORD3_ONE.format(status="who_knows", extra="").replace(
        "    status: who_knows\n", ""
    )
    assert _gate(text) == "restricted"


def test_a_malformed_envelope_fails_closed():
    assert server.record_copyright_status({}, "") == "restricted"
    assert _gate("---\nschema: anomalica/record/3\nassets: [broken\n---\nbody\n") == (
        "restricted"
    )
