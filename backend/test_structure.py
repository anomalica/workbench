"""ADR 0051 structural preview and atomic commit."""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

import pytest
import yaml
from anomalica_common.identity import record_identity
from anomalica_common.pre_digest import prepare_page_record
from fastapi.testclient import TestClient

from backend import server


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def _asset(
    records: Path,
    content: bytes,
    *,
    source_type: str,
    pages: int,
    status: str = "licensed",
    image_format: str = "png",
) -> dict:
    digest = hashlib.sha256(content).hexdigest()
    file_format = "pdf" if source_type == "pdf" else image_format
    (records / f"{digest}.{file_format}").write_bytes(content)
    return {
        "asset_hash": f"sha256:{digest}",
        "file_format": file_format,
        "archived_ext": file_format,
        "source_type": source_type,
        "pages": pages,
        "acquisition": {"acquired_at": "2026-09-22T09:00:00Z"},
        "copyright": {"status": status},
    }


def _record_text(frontmatter: dict, body: str) -> str:
    return (
        "---\n"
        + yaml.safe_dump(frontmatter, sort_keys=False, allow_unicode=True)
        + "---\n"
        + body
    )


def _add_parent(
    repo: Path,
    asset: dict,
    page_texts: list[str],
    *,
    title: str,
    selection: list[dict] | None = None,
) -> str:
    if selection is None:
        selection = [{"asset_hash": asset["asset_hash"], "selector": {"type": "whole"}}]
    content_hash = record_identity(selection)
    bare = content_hash.removeprefix("sha256:")
    page_map = [
        {
            "record_page": index,
            "asset_hash": asset["asset_hash"],
            "asset_file_page": index,
        }
        for index in range(1, len(page_texts) + 1)
    ]
    frontmatter = {
        "schema": "anomalica/record/3",
        "content_hash": content_hash,
        "title": title,
        "source_types": [asset["source_type"]],
        "source_type": asset["source_type"],
        "assets": [asset],
        "selection": selection,
        "page_map": page_map,
        "structure_status": "temporary",
        "processing": {
            "asset_pipeline_versions": [
                {
                    "asset_hash": asset["asset_hash"],
                    "source_type": asset["source_type"],
                    "pipeline_version": 1,
                }
            ]
        },
    }
    body = "".join(
        f"<!-- file_page: {index} -->\n{text}\n"
        for index, text in enumerate(page_texts, 1)
    )
    (repo / "store" / f"{bare}.md").write_text(_record_text(frontmatter, body))
    prepared = prepare_page_record(frontmatter, body)
    map_path = (
        repo
        / "source-maps"
        / f"{prepared.source_map_sha256.removeprefix('sha256:')}.json"
    )
    map_path.parent.mkdir(exist_ok=True)
    map_path.write_bytes(prepared.source_map_json)
    return bare


@pytest.fixture
def structure_api(tmp_path: Path, monkeypatch):
    repo = tmp_path / "ingests"
    records = tmp_path / "records"
    (repo / "store").mkdir(parents=True)
    records.mkdir()
    pdf = _asset(records, b"%PDF-1.4\nparent-a\n", source_type="pdf", pages=3)
    parent = _add_parent(
        repo,
        pdf,
        ["First physical page.", "Second physical page.", "Third physical page."],
        title="Temporary bundle",
    )
    # Authorities on a parent are audit history. The structural writer must not
    # copy any of them to a child.
    for suffix in (
        "review.json",
        "housekeeping.json",
        "gold.json",
        "verification.json",
        "digest.json",
        "graph.json",
    ):
        (repo / "store" / f"{parent}.{suffix}").write_text('{"parent":true}\n')
    (repo / "roles.yaml").write_text("editor: editor\n")
    _git(repo, "init", "-q")
    _git(repo, "config", "user.name", "Test")
    _git(repo, "config", "user.email", "test@example.invalid")
    _git(repo, "config", "core.hooksPath", "/dev/null")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "temporary parent")

    local = server.LocalIngestSource(repo)
    monkeypatch.setattr(server, "source", local)
    monkeypatch.setattr(server, "ingests_path", repo)
    monkeypatch.setattr(server, "records_path", records)
    user = {"login": "editor", "name": "Editor", "email": "editor@example.invalid"}
    monkeypatch.setattr(server, "_require_role", lambda _request, _minimum: user)
    return TestClient(server.app), repo, records, local, parent, pdf


def _split_request(base_ref: str, parent: str, asset_hash: str) -> dict:
    return {
        "schema": "anomalica/structure-request/1",
        "base_ref": base_ref,
        "parents": [parent],
        "outputs": [
            {
                "metadata": {"title": "Later pages", "document_type": "report"},
                "selection": [
                    {
                        "asset_hash": asset_hash,
                        "selector": {"type": "pdf_page_range", "start": 2, "end": 3},
                    }
                ],
            },
            {
                "metadata": {"title": "Opening page"},
                "selection": [
                    {
                        "asset_hash": asset_hash,
                        "selector": {"type": "pdf_page", "page": 1},
                    }
                ],
            },
        ],
    }


def test_candidates_and_preview_are_server_derived_without_writes(structure_api):
    client, repo, _records, _local, parent, asset = structure_api
    before_ref = _git(repo, "rev-parse", "HEAD")
    before_status = _git(repo, "status", "--porcelain")

    candidates = client.get("/api/records/structure")
    assert candidates.status_code == 200
    view = candidates.json()
    assert view["base_ref"] == before_ref
    assert view["blocked"] == []
    assert view["parents"][0]["content_hash"] == parent
    assert [page["asset_file_page"] for page in view["parents"][0]["pages"]] == [
        1,
        2,
        3,
    ]
    assert view["parents"][0]["assets"][0]["copyright_status"] == "licensed"

    response = client.post(
        "/api/records/structure/preview",
        json=_split_request(before_ref, parent, asset["asset_hash"]),
    )
    assert response.status_code == 200, response.text
    preview = response.json()
    assert preview["schema"] == "anomalica/structure-preview/1"
    assert preview["preview_sha256"].startswith("sha256:")
    first = preview["outputs"][0]
    assert [item["selector"] for item in first["selection"]] == [
        {"type": "pdf_page", "page": 2},
        {"type": "pdf_page", "page": 3},
    ]
    assert [page["record_page"] for page in first["page_map"]] == [1, 2]
    assert [page["asset_file_page"] for page in first["page_map"]] == [2, 3]
    assert "file_page: 1" in first["body"]
    assert "file_page: 2" in first["body"]
    assert "file_page: 3" not in first["body"]
    assert _git(repo, "rev-parse", "HEAD") == before_ref
    assert _git(repo, "status", "--porcelain") == before_status


def test_split_commit_creates_every_output_and_retires_parent_atomically(structure_api):
    client, repo, _records, local, parent, asset = structure_api
    base_ref = _git(repo, "rev-parse", "HEAD")
    request = _split_request(base_ref, parent, asset["asset_hash"])
    preview = client.post("/api/records/structure/preview", json=request).json()

    response = client.post(
        "/api/records/structure/commit",
        json={**request, "preview_sha256": preview["preview_sha256"]},
    )

    assert response.status_code == 200, response.text
    result = response.json()
    assert result["commit_ref"] == _git(repo, "rev-parse", "HEAD")
    assert result["commit_ref"] != base_ref
    assert result["created"] == [item["content_hash"] for item in preview["outputs"]]
    parent_text = (repo / "store" / f"{parent}.md").read_text()
    parent_frontmatter = yaml.safe_load(parent_text.split("---", 2)[1])
    assert parent_frontmatter["structure_status"] == "temporary"
    assert parent_frontmatter["retired_into"] == result["created"]
    assert "superseded_by" not in parent_frontmatter

    changed = set(_git(repo, "show", "--name-only", "--format=", "HEAD").splitlines())
    assert f"store/{parent}.md" in changed
    for output in preview["outputs"]:
        bare = output["content_hash"].removeprefix("sha256:")
        path = repo / "store" / f"{bare}.md"
        assert path.is_file()
        frontmatter = yaml.safe_load(path.read_text().split("---", 2)[1])
        assert frontmatter["content_hash"] == output["content_hash"]
        assert frontmatter["selection"] == output["selection"]
        assert frontmatter["page_map"] == output["page_map"]
        assert frontmatter["assets"][0]["copyright"] == {"status": "licensed"}
        assert frontmatter["structural_parents"] == [f"sha256:{parent}"]
        assert "structure_status" not in frontmatter
        for suffix in (
            "review.json",
            "housekeeping.json",
            "gold.json",
            "verification.json",
            "digest.json",
            "graph.json",
        ):
            assert not (repo / "store" / f"{bare}.{suffix}").exists()
        assert f"store/{bare}.md" in changed
        source_map = output["pre_digest"]["source_map_sha256"].removeprefix("sha256:")
        predigest = output["pre_digest"]["sha256"].removeprefix("sha256:")
        assert (repo / "source-maps" / f"{source_map}.json").is_file()
        assert (repo / "pre-digests" / f"{predigest}.md").is_file()

    assert parent not in {item["content_hash"] for item in local.list_ingests()}
    assert set(result["created"]) == {
        f"sha256:{item['content_hash']}" for item in local.list_ingests()
    }
    assert _git(repo, "diff", "--cached", "--name-only", "HEAD") == ""


def test_composition_reorders_complete_pages_and_whole_image(structure_api):
    client, repo, records, _local, parent, pdf = structure_api
    image = _asset(
        records,
        b"\xff\xd8\xffwhole-image",
        source_type="image",
        pages=1,
        status="public_domain",
        image_format="jpeg",
    )
    image_parent = _add_parent(
        repo, image, ["Standalone image transcription."], title="Temporary image"
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "second temporary parent")
    base_ref = _git(repo, "rev-parse", "HEAD")
    request = {
        "schema": "anomalica/structure-request/1",
        "base_ref": base_ref,
        "parents": [parent, image_parent],
        "outputs": [
            {
                "metadata": {"title": "Composed evidence"},
                "selection": [
                    {"asset_hash": image["asset_hash"], "selector": {"type": "whole"}},
                    {
                        "asset_hash": pdf["asset_hash"],
                        "selector": {"type": "pdf_page_range", "start": 1, "end": 3},
                    },
                ],
            }
        ],
    }

    preview_response = client.post("/api/records/structure/preview", json=request)
    assert preview_response.status_code == 200, preview_response.text
    preview = preview_response.json()
    output = preview["outputs"][0]
    assert [asset["asset_hash"] for asset in output["assets"]] == [
        image["asset_hash"],
        pdf["asset_hash"],
    ]
    assert [page["asset_file_page"] for page in output["page_map"]] == [1, 1, 2, 3]
    assert [page["asset_hash"] for page in output["page_map"]] == [
        image["asset_hash"],
        pdf["asset_hash"],
        pdf["asset_hash"],
        pdf["asset_hash"],
    ]
    assert output["body"].index("Standalone image") < output["body"].index(
        "First physical"
    )

    committed = client.post(
        "/api/records/structure/commit",
        json={**request, "preview_sha256": preview["preview_sha256"]},
    )
    assert committed.status_code == 200, committed.text
    for retired in (parent, image_parent):
        frontmatter = yaml.safe_load(
            (repo / "store" / f"{retired}.md").read_text().split("---", 2)[1]
        )
        assert frontmatter["retired_into"] == committed.json()["created"]


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (
            lambda request: request["outputs"][0]["selection"].append(
                {
                    "asset_hash": request["outputs"][0]["selection"][0]["asset_hash"],
                    "selector": {"type": "pdf_page", "page": 3},
                }
            ),
            "repeats or overlaps",
        ),
        (
            lambda request: request["outputs"][1].update(
                {
                    "selection": [
                        {
                            "asset_hash": request["outputs"][0]["selection"][0][
                                "asset_hash"
                            ],
                            "selector": {"type": "pdf_page", "page": 4},
                        }
                    ]
                }
            ),
            "outside",
        ),
        (
            lambda request: request["outputs"][1].update(
                {
                    "selection": [
                        {
                            "asset_hash": request["outputs"][0]["selection"][0][
                                "asset_hash"
                            ],
                            "selector": {"type": "whole"},
                        }
                    ]
                }
            ),
            "whole selectors",
        ),
    ],
)
def test_invalid_ranges_duplicates_and_media_types_fail_without_writes(
    structure_api, mutate, message
):
    client, repo, _records, _local, parent, asset = structure_api
    base_ref = _git(repo, "rev-parse", "HEAD")
    request = _split_request(base_ref, parent, asset["asset_hash"])
    mutate(request)

    response = client.post("/api/records/structure/preview", json=request)

    assert response.status_code == 400
    assert message in response.json()["detail"]
    assert _git(repo, "rev-parse", "HEAD") == base_ref
    assert not (repo / "pre-digests").exists()


def test_missing_or_stale_source_inputs_fail_closed(structure_api):
    client, repo, records, _local, parent, asset = structure_api
    source_map = next((repo / "source-maps").glob("*.json"))
    source_map.unlink()
    _git(repo, "add", "-u")
    _git(repo, "commit", "-q", "-m", "remove source map")
    base_ref = _git(repo, "rev-parse", "HEAD")

    missing_map = client.post(
        "/api/records/structure/preview",
        json=_split_request(base_ref, parent, asset["asset_hash"]),
    )
    assert missing_map.status_code == 400
    assert "source map is missing" in missing_map.json()["detail"]
    candidates = client.get("/api/records/structure").json()
    assert candidates["parents"] == []
    assert "source map is missing" in candidates["blocked"][0]["detail"]

    # Restore the map, then make the immutable Asset unavailable. The candidate
    # can still be listed, but preview/commit cannot proceed without exact bytes.
    record_raw = (repo / "store" / f"{parent}.md").read_bytes()
    frontmatter, body, _ = server.parse_frontmatter(record_raw.decode())
    # parse_frontmatter is intentionally shallow; full YAML is needed here.
    full_frontmatter = yaml.safe_load(record_raw.decode().split("---", 2)[1])
    prepared = prepare_page_record(full_frontmatter, body)
    source_map.write_bytes(prepared.source_map_json)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "restore source map")
    archive = records / f"{asset['asset_hash'].removeprefix('sha256:')}.pdf"
    archive.unlink()
    request = _split_request(
        _git(repo, "rev-parse", "HEAD"), parent, asset["asset_hash"]
    )
    missing_asset = client.post("/api/records/structure/preview", json=request)
    assert missing_asset.status_code == 400
    assert "Archived Asset is missing" in missing_asset.json()["detail"]


def test_stale_ref_and_preview_token_write_nothing(structure_api):
    client, repo, _records, _local, parent, asset = structure_api
    request = _split_request(
        _git(repo, "rev-parse", "HEAD"), parent, asset["asset_hash"]
    )
    preview = client.post("/api/records/structure/preview", json=request).json()

    wrong_token = client.post(
        "/api/records/structure/commit",
        json={**request, "preview_sha256": f"sha256:{'f' * 64}"},
    )
    assert wrong_token.status_code == 409
    assert _git(repo, "rev-parse", "HEAD") == request["base_ref"]

    (repo / "unrelated.txt").write_text("new committed state\n")
    _git(repo, "add", "unrelated.txt")
    _git(repo, "commit", "-q", "-m", "unrelated")
    stale = client.post(
        "/api/records/structure/commit",
        json={**request, "preview_sha256": preview["preview_sha256"]},
    )
    assert stale.status_code == 409
    assert "stale" in stale.json()["detail"]
    for output in preview["outputs"]:
        bare = output["content_hash"].removeprefix("sha256:")
        assert not (repo / "store" / f"{bare}.md").exists()
    assert "retired_into" not in (repo / "store" / f"{parent}.md").read_text()


def test_commit_rejects_a_staged_parent_even_when_the_worktree_matches_head(
    structure_api,
):
    client, repo, _records, _local, parent, asset = structure_api
    base_ref = _git(repo, "rev-parse", "HEAD")
    request = _split_request(base_ref, parent, asset["asset_hash"])
    preview = client.post("/api/records/structure/preview", json=request).json()
    parent_path = repo / "store" / f"{parent}.md"
    committed = parent_path.read_bytes()
    parent_path.write_bytes(committed.replace(b"Temporary bundle", b"Staged title"))
    _git(repo, "add", str(parent_path.relative_to(repo)))
    parent_path.write_bytes(committed)

    response = client.post(
        "/api/records/structure/commit",
        json={**request, "preview_sha256": preview["preview_sha256"]},
    )

    assert response.status_code == 409
    assert "staged changes" in response.json()["detail"]
    assert _git(repo, "rev-parse", "HEAD") == base_ref
    assert "retired_into" not in parent_path.read_text()


def test_commit_failure_leaves_all_structural_files_unchanged(
    structure_api, monkeypatch
):
    client, repo, _records, local, parent, asset = structure_api
    request = _split_request(
        _git(repo, "rev-parse", "HEAD"), parent, asset["asset_hash"]
    )
    preview = client.post("/api/records/structure/preview", json=request).json()
    before_parent = (repo / "store" / f"{parent}.md").read_bytes()

    def fail_commit(*_args, **_kwargs):
        raise subprocess.CalledProcessError(1, ["git", "commit-tree"])

    monkeypatch.setattr(local, "_commit_bytes_locked", fail_commit)
    response = client.post(
        "/api/records/structure/commit",
        json={**request, "preview_sha256": preview["preview_sha256"]},
    )

    assert response.status_code == 500
    assert (repo / "store" / f"{parent}.md").read_bytes() == before_parent
    assert _git(repo, "rev-parse", "HEAD") == request["base_ref"]
    for output in preview["outputs"]:
        bare = output["content_hash"].removeprefix("sha256:")
        assert not (repo / "store" / f"{bare}.md").exists()
    assert not (repo / "pre-digests").exists()
    # Parent sidecars were never staged, rewritten or deleted.
    assert json.loads((repo / "store" / f"{parent}.review.json").read_text()) == {
        "parent": True
    }
