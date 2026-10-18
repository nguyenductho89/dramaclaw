from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def folders_client(monkeypatch, tmp_path):
    from novelvideo.api.auth import get_api_user
    from novelvideo.api.routes import freezone

    project_dir = tmp_path / "project"
    project_dir.mkdir(parents=True, exist_ok=True)

    ctx = SimpleNamespace(
        project_id="proj_demo",
        owner_username="alice",
        project_name="demo",
        output_dir=str(project_dir),
        state_dir=str(project_dir),
        runtime_dir=str(project_dir / "_runtime"),
        is_home_node=True,
    )

    async def fake_resolve(project: str, user: dict, *, required_role: str = "editor"):
        return ctx, "alice", "demo", project_dir, str(project_dir)

    monkeypatch.setattr(freezone, "_resolve_freezone_project", fake_resolve)

    app = FastAPI()
    app.include_router(freezone.router, prefix="/api/v1")
    app.dependency_overrides[get_api_user] = lambda: {
        "id": "u-alice",
        "username": "alice",
    }
    return TestClient(app), project_dir


_FOLDERS = "/api/v1/projects/proj_demo/freezone/video/asset-library/folders"


def _new_folder(client: TestClient, name: str = "Episode One Assets") -> str:
    response = client.post(_FOLDERS, json={"name": name})
    assert response.status_code == 200, response.text
    return str(response.json()["data"]["id"])


def _cover(client: TestClient, folder_id: str) -> str | None:
    response = client.get(_FOLDERS)
    assert response.status_code == 200, response.text
    for folder in response.json()["data"]:
        if str(folder["id"]) == folder_id:
            return folder.get("cover")
    raise AssertionError(f"folder {folder_id} missing from listing")


def test_folder_cover_accepts_same_origin_asset(folders_client) -> None:
    client, project_dir = folders_client
    asset = project_dir / "freezone" / "_uploads" / "cover.png"
    asset.parent.mkdir(parents=True)
    asset.write_bytes(b"png")
    folder_id = _new_folder(client)

    response = client.patch(
        f"{_FOLDERS}/{folder_id}",
        json={"cover": "/freezone/_uploads/cover.png"},
    )

    assert response.status_code == 200, response.text
    assert _cover(client, folder_id) == "/freezone/_uploads/cover.png"


@pytest.mark.parametrize(
    "cover",
    [
        "https://evil.example/freezone/_uploads/foo.png",
        "//evil.example/freezone/_uploads/foo.png",
        "/\\evil.example/freezone/_uploads/foo.png",
    ],
)
def test_folder_cover_rejects_cross_origin_url(folders_client, cover: str) -> None:
    """The cover is the <img src> of every collaborator, and an external link makes other people's browsers visit a third-party address.

    An attacker appends the real path of an asset they uploaded after an external-link domain, and the path cut out lands inside the project
    -- so validation must look at the whole string, and the value stored must be the same one that was validated.
    """
    client, project_dir = folders_client
    decoy = project_dir / "freezone" / "_uploads" / "foo.png"
    decoy.parent.mkdir(parents=True)
    decoy.write_bytes(b"png")
    folder_id = _new_folder(client)

    response = client.patch(f"{_FOLDERS}/{folder_id}", json={"cover": cover})

    assert response.status_code == 400, response.text
    assert _cover(client, folder_id) in (None, "")


def test_folder_cover_missing_file_does_not_leak_server_path(folders_client) -> None:
    client, project_dir = folders_client
    folder_id = _new_folder(client)

    response = client.patch(
        f"{_FOLDERS}/{folder_id}",
        json={"cover": "/freezone/_uploads/nope.png"},
    )

    assert response.status_code == 404, response.text
    detail = str(response.json().get("detail", ""))
    assert str(project_dir) not in detail
    assert "/freezone/_uploads/nope.png" in detail
