"""The snapshot's media copy obeys the same copyright gate as the body.

Extracted images are page scans and figures lifted from the source. For a
licensed book they ARE the verbatim content, so shipping them would walk around
the gate the snapshot just applied to that book's text - and the public CDN is
irreversible. These tests exist to make that impossible to regress quietly.
"""

from pathlib import Path

import pytest

from backend import prerender


@pytest.fixture
def media_root(tmp_path, monkeypatch):
    """A fake ingests/media tree, so nothing touches the real corpus."""
    from backend import server

    root = tmp_path / "ingests"
    (root / "media").mkdir(parents=True)
    monkeypatch.setattr(server, "ingests_path", root)
    return root / "media"


def _record(media_root: Path, content_hash: str, *names: str) -> None:
    d = media_root / content_hash
    d.mkdir(parents=True)
    for n in names:
        (d / n).write_bytes(b"\xff\xd8\xff" + n.encode())  # jpeg-ish bytes


PUBLIC_HASH = "a" * 64
GATED_HASH = "b" * 64


def test_public_record_media_is_copied(tmp_path, media_root):
    _record(media_root, PUBLIC_HASH, "0123456789ab.jpg", "fedcba987654.png")
    base = tmp_path / "snap" / "api"

    copied = prerender._copy_record_media(base, PUBLIC_HASH, public=True)

    assert copied == 2
    out = base / "ingests" / PUBLIC_HASH / "media"
    assert (out / "0123456789ab.jpg").read_bytes().startswith(b"\xff\xd8\xff")
    assert (out / "fedcba987654.png").exists()


def test_gated_record_media_is_NEVER_copied(tmp_path, media_root):
    """The whole point. A licensed book's 33 page scans must not reach the CDN."""
    _record(media_root, GATED_HASH, "0123456789ab.jpg", "fedcba987654.jpg")
    base = tmp_path / "snap" / "api"

    copied = prerender._copy_record_media(base, GATED_HASH, public=False)

    assert copied == 0
    assert not (base / "ingests" / GATED_HASH).exists()
    # Not one byte of it anywhere in the snapshot, under any name.
    assert not list(base.rglob("*.jpg")) if base.exists() else True


def test_the_gate_is_the_body_gate_not_a_second_list(tmp_path, media_root):
    """`public` must come from serves_verbatim, so a status can never be public
    for images and gated for text (or the reverse). Pinning the coupling."""
    assert prerender.serves_verbatim("publicly_accessible") is True
    assert prerender.serves_verbatim("public_domain") is True
    assert prerender.serves_verbatim("open_licence") is True
    assert prerender.serves_verbatim("licensed") is False
    assert prerender.serves_verbatim("restricted") is False
    # Fail-safe: unknown/absent is gated, so a new status added upstream cannot
    # start publishing images before anyone decides it should.
    assert prerender.serves_verbatim("some_new_status") is False
    assert prerender.serves_verbatim(None) is False


def test_only_the_ingester_filename_shape_is_published(tmp_path, media_root):
    """A stray file sitting in the media directory is not published just for
    being there - the snapshot applies the live endpoint's own constraint."""
    _record(media_root, PUBLIC_HASH, "0123456789ab.jpg")
    d = media_root / PUBLIC_HASH
    (d / "notes.txt").write_text("private working note")
    (d / "..%2fescape.jpg").write_bytes(b"x")
    (d / "ABCDEF123456.jpg").write_bytes(b"x")  # uppercase hex: not the shape
    base = tmp_path / "snap" / "api"

    copied = prerender._copy_record_media(base, PUBLIC_HASH, public=True)

    assert copied == 1
    published = {p.name for p in (base / "ingests" / PUBLIC_HASH / "media").iterdir()}
    assert published == {"0123456789ab.jpg"}


def test_record_with_no_media_is_not_an_error(tmp_path, media_root):
    base = tmp_path / "snap" / "api"
    assert prerender._copy_record_media(base, "c" * 64, public=True) == 0
