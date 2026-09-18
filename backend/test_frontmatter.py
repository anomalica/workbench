import backend.server as server


def test_double_quoted_title_is_unescaped():
    fm, _, _ = server.parse_frontmatter(
        '---\ntitle: "He said \\"hi\\" loudly"\nsource_type: video\n---\nbody\n'
    )
    assert fm["title"] == 'He said "hi" loudly'


def test_single_quoted_value_unescaped():
    fm, _, _ = server.parse_frontmatter(
        "---\ntitle: 'it''s fine'\nsource_type: web\n---\nx\n"
    )
    assert fm["title"] == "it's fine"


def test_plain_value_unchanged():
    fm, _, _ = server.parse_frontmatter(
        "---\ntitle: Plain Title\nsource_type: pdf\n---\nx\n"
    )
    assert fm["title"] == "Plain Title"


def test_crlf_frontmatter_preserves_exact_body():
    text = "---\r\ntitle: CRLF\r\nsource_type: video\r\n---\r\nBody.\r\n"
    fm, body, raw = server.parse_frontmatter(text)

    assert fm["title"] == "CRLF"
    assert raw == "---\r\ntitle: CRLF\r\nsource_type: video\r\n---\r\n"
    assert body == "Body.\r\n"


def test_bare_cr_frontmatter_preserves_exact_body():
    text = "---\rtitle: CR\rsource_type: video\r---\rBody.\r"
    fm, body, raw = server.parse_frontmatter(text)

    assert fm["title"] == "CR"
    assert raw == "---\rtitle: CR\rsource_type: video\r---\r"
    assert body == "Body.\r"
