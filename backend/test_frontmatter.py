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
