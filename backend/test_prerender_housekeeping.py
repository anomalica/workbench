"""The housekeeping sidecar follows the same copyright allow-list as the body."""

from __future__ import annotations

from backend.prerender import GATED_FRONTMATTER_ALLOW, _gate_housekeeping

SIDECAR = {
    "schema": "anomalica/housekeeping/1",
    "content_hash": "sha256:abc",
    "items": [
        {"id": "a", "field": "description", "proposed": "a publisher blurb"},
        {"id": "b", "field": "date_published", "proposed": "1967"},
        {"id": "c", "field": "title", "proposed": "A Title"},
        {"id": "d", "field": "word_timestamps", "proposed": True},
    ],
}


def test_a_proposal_about_a_gated_field_is_withheld():
    """A proposal carries the CURRENT and PROPOSED values of a field, so publishing
    one publishes that field. `description` is withheld from a gated record's
    frontmatter precisely because it holds publisher blurbs - a proposal about it
    would walk straight around that."""
    kept = {i["id"] for i in _gate_housekeeping(SIDECAR)["items"]}
    assert "a" not in kept, "description proposal must not ship for a gated record"
    assert "d" not in kept, "word_timestamps is the verbatim transcript"
    assert kept == {"b", "c"}


def test_item_ids_survive_gating():
    """An approval posted from the public tab must still address the same item in
    the full sidecar the writer reads."""
    for item in _gate_housekeeping(SIDECAR)["items"]:
        assert item["id"] in {"a", "b", "c", "d"}


def test_a_move_is_gated_on_its_destination_too():
    sc = {
        "items": [
            {
                "id": "m",
                "field": "title",
                "to_field": "description",
                "operation": "move",
                "proposed": "x",
            }
        ]
    }
    assert _gate_housekeeping(sc)["items"] == [], (
        "moving an allowed field INTO a gated one would publish the gated field"
    )


def test_the_gated_flag_is_set_so_the_ui_can_say_so():
    assert _gate_housekeeping(SIDECAR)["gated"] is True


def test_the_allow_list_is_unchanged_by_housekeeping():
    """Housekeeping must not widen the copyright gate. posted_by/posted_date are
    deliberately absent: adding them is a widening and needs Mark's sign-off.
    Impact today is nil - all 19 gated records are books and papers, and the
    redistributor check only fires on YouTube channels."""
    assert "posted_by" not in GATED_FRONTMATTER_ALLOW
    assert "source_hash" not in GATED_FRONTMATTER_ALLOW
