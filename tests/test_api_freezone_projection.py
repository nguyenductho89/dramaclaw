from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def projection_client(monkeypatch, tmp_path):
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

    async def fake_resolve(
        project: str,
        user: dict,
        *,
        required_role: str = "editor",
        require_home_node: bool = True,
    ):
        return ctx, "alice", "demo", project_dir, str(project_dir)

    monkeypatch.setattr(freezone, "_resolve_freezone_project", fake_resolve)
    monkeypatch.setattr(freezone, "_append_canvas_event", lambda **_kwargs: None)

    app = FastAPI()
    app.include_router(freezone.router, prefix="/api/v1")
    app.dependency_overrides[get_api_user] = lambda: {
        "id": "u-alice",
        "username": "alice",
    }
    return TestClient(app), project_dir


def _project(client: TestClient, canvas_id: str, **body) -> tuple[int, dict]:
    response = client.post(
        f"/api/v1/projects/proj_demo/freezone/canvases/{canvas_id}/projections:from-preset",
        json={
            "scope": "blank",
            "projection_key": "blank:user",
            "base_revision": 0,
            **body,
        },
    )
    return response.status_code, response.json()


def _build_projection(client: TestClient, **body) -> tuple[int, dict]:
    response = client.post(
        "/api/v1/projects/proj_demo/freezone/projections:build-from-preset",
        json={
            "scope": "blank",
            "projection_key": "blank:user",
            "base_revision": 0,
            **body,
        },
    )
    return response.status_code, response.json()


def test_projection_creates_target_canvas(projection_client) -> None:
    client, project_dir = projection_client

    status, body = _project(client, "user_alice_abc123")

    assert status == 200, body
    assert body["data"]["canvas_id"] == "user_alice_abc123"
    assert body["data"]["projection_key"] == "blank:user"
    assert body["data"]["revision"] == 1
    canvas_file = project_dir / "freezone" / "canvases" / "user_alice_abc123.json"
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert "preset" not in payload["metadata"]
    assert payload["metadata"]["projections"]["blank:user"]["facts_signature"]
    assert payload["metadata"]["last_projection_key"] == "blank:user"


def test_build_projection_from_preset_does_not_write_canvas(
    projection_client,
    monkeypatch,
) -> None:
    from novelvideo.api.routes import freezone

    client, project_dir = projection_client

    async def fake_build_canvas_payload_for_preset_request(**_kwargs):
        return {
            "nodes": [
                {
                    "id": "beat_ctx",
                    "type": "beatContextNode",
                    "position": {"x": 100, "y": 100},
                    "style": {"width": 260, "height": 160},
                    "data": {"preset_managed": True},
                },
            ],
            "edges": [],
            "metadata": {},
        }

    monkeypatch.setattr(
        freezone,
        "_build_canvas_payload_for_preset_request",
        fake_build_canvas_payload_for_preset_request,
    )

    status, body = _build_projection(
        client,
        scope="beat",
        episode=1,
        beat=4,
        projection_key="beat:1:4",
    )

    assert status == 200, body
    data = body["data"]
    assert data["projection_key"] == "beat:1:4"
    assert data["facts_signature"]
    group = next(node for node in data["nodes"] if node["type"] == "groupNode")
    assert group["id"] == freezone._projection_group_id("beat:1:4")
    assert data["metadata"]["projections"]["beat:1:4"]["facts_signature"]
    projection = data["metadata"]["projections"]["beat:1:4"]
    assert projection["request"] == {
        "scope": "beat",
        "episode": 1,
        "beat": 4,
        "primary_slot": "render",
        "projection_key": "beat:1:4",
    }
    assert "force_refresh" not in projection["request"]
    assert not (project_dir / "freezone" / "canvases").exists()


def test_build_projection_from_preset_stamps_mainline_context_project_id(
    projection_client,
    monkeypatch,
) -> None:
    """The frontend "sync update" writes the nodes here directly into the in-memory canvas; a beat context missing projectId
    is treated by the frontend as standalone and must be filled in exactly as when the canvas is read."""
    from novelvideo.api.routes import freezone

    client, _project_dir = projection_client

    async def fake_build_canvas_payload_for_preset_request(**_kwargs):
        return {
            "nodes": [
                {
                    "id": "beat_ctx",
                    "type": "beatContextNode",
                    "position": {"x": 100, "y": 100},
                    "style": {"width": 260, "height": 160},
                    "data": {
                        "preset_managed": True,
                        "mainline_context": [
                            {"kind": "beat", "projectId": None, "episode": 1, "beat": 4},
                        ],
                    },
                },
            ],
            "edges": [],
            "metadata": {},
        }

    monkeypatch.setattr(
        freezone,
        "_build_canvas_payload_for_preset_request",
        fake_build_canvas_payload_for_preset_request,
    )

    status, body = _build_projection(
        client,
        scope="beat",
        episode=1,
        beat=4,
        projection_key="beat:1:4",
    )

    assert status == 200, body
    beat_node = next(node for node in body["data"]["nodes"] if node["id"] == "beat_ctx")
    assert beat_node["data"]["mainline_context"][0]["projectId"] == "proj_demo"


def test_projection_scene_asset_includes_derived_base_master_input(
    projection_client,
    monkeypatch,
) -> None:
    from novelvideo.api.routes import freezone

    client, project_dir = projection_client
    base_master_path = project_dir / "assets" / "scenes" / "CityStreet" / "master.png"
    base_master_path.parent.mkdir(parents=True)
    base_master_path.write_bytes(b"fake image")

    class Store:
        async def get_scene(self, scene_id: str):
            scenes = {
                "CityStreet": {
                    "scene_id": "CityStreet",
                    "name": "CityStreet",
                    "scene_type": "exterior",
                    "environment_prompt": "Front: neon shops and a bus stop",
                },
                "CityStreet_RainyNight": {
                    "scene_id": "CityStreet_RainyNight",
                    "name": "CityStreet_RainyNight",
                    "scene_type": "exterior",
                    "base_scene_id": "CityStreet",
                    "variant_id": "RainyNight",
                    "variant_prompt": "Puddles reflect the neon, heavy curtain of rain",
                },
            }
            return scenes.get(scene_id)

        async def close(self):
            return None

    async def fake_make_sqlite_store_for_context(_ctx):
        return Store()

    monkeypatch.setattr(
        freezone,
        "make_sqlite_store_for_context",
        fake_make_sqlite_store_for_context,
    )

    status, body = _project(
        client,
        "user_alice_abc123",
        scope="asset",
        asset_kind="scene",
        asset_id="CityStreet_RainyNight",
        projection_key="scene:CityStreet_RainyNight",
    )

    assert status == 200, body
    canvas_file = project_dir / "freezone" / "canvases" / "user_alice_abc123.json"
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    base_nodes = [
        node
        for node in payload["nodes"]
        if node.get("data", {}).get("displayName") == "CityStreet base master"
    ]
    assert len(base_nodes) == 1
    groups = {node["id"]: node for node in payload["nodes"] if node["type"] == "groupNode"}
    assert base_nodes[0].get("parentId") in groups
    edges = {(edge["source"], edge["target"]) for edge in payload["edges"]}
    assert (base_nodes[0]["id"], "ref_scene_master_1") in edges


def test_projection_group_id_is_unique_per_non_ascii_asset() -> None:
    """One mainline projection group per character.

    The group id is sanitized from projection_key; a non-ASCII character name has every character replaced by ``_`` via ``[^A-Za-z0-9]``
    and then stripped, so both characters collapse to ``projection_group_asset_character`` -- the group name of the second character
    was displaced when entering the canvas, and the nodes of both characters were crammed into one group.
    """
    from novelvideo.api.routes import freezone

    lin = freezone._projection_group_id("asset:character:Анна")
    gu = freezone._projection_group_id("asset:character:Борис")
    assert lin != gu
    # The group id is the node id and must be stable across requests, otherwise every projection grows a new group.
    assert lin == freezone._projection_group_id("asset:character:Анна")
    # Keys that never collided anyway (ASCII / beat / episode) must still each be unique.
    assert freezone._projection_group_id("beat:1:4") != freezone._projection_group_id(
        "beat:1:6"
    )


def test_projection_group_encloses_nodes_without_explicit_size() -> None:
    """The group frame must enclose the members' **real** rendered size.

    Most nodes produced by presets carry no explicit width/height (`_text_node` / `_upload_node`),
    and those that carry a size (`_skill_node` / `_beat_context_node`) write it only in `measured`. Estimating with a uniform
    320x180 badly underestimates these nodes, and the computed group frame cannot enclose the members -- members carry
    `extent: "parent"`, so React Flow clamps them back into the small frame in a heap (user-visible symptom).
    """
    from novelvideo.api.routes import freezone

    projection_key = "asset:character:Анна"
    nodes = [
        # _text_node: no width/height/style; the frontend actually renders 440x320
        {
            "id": "character_profile",
            "type": "textAnnotationNode",
            "position": {"x": -1040, "y": -560},
            "data": {"preset_managed": True, "projection_key": projection_key},
        },
        # _upload_node: no size; the frontend actually renders 320x350
        {
            "id": "portrait_ref",
            "type": "uploadNode",
            "position": {"x": -560, "y": -220},
            "data": {"preset_managed": True, "projection_key": projection_key},
        },
        # _skill_node: the size is written only in measured
        {
            "id": "skill_portrait",
            "type": "skillNode",
            "position": {"x": -100, "y": -220},
            "measured": {"width": 380, "height": 520},
            "data": {"preset_managed": True, "projection_key": projection_key},
        },
    ]
    expected_sizes = {
        "character_profile": (440, 320),
        "portrait_ref": (320, 350),
        "skill_portrait": (380, 520),
    }

    payload = freezone._wrap_projection_payload_in_group(
        {"nodes": [dict(node) for node in nodes], "edges": []},
        projection_key=projection_key,
        label="Анна",
    )
    group = next(node for node in payload["nodes"] if node["type"] == "groupNode")
    group_width = group["style"]["width"]
    group_height = group["style"]["height"]

    for child in payload["nodes"]:
        if child["type"] == "groupNode":
            continue
        width, height = expected_sizes[child["id"]]
        assert child["position"]["x"] >= 0, child["id"]
        assert child["position"]["y"] >= 0, child["id"]
        assert child["position"]["x"] + width <= group_width, child["id"]
        assert child["position"]["y"] + height <= group_height, child["id"]


def test_projection_wraps_preset_nodes_in_group(projection_client, monkeypatch) -> None:
    from novelvideo.api.routes import freezone

    client, project_dir = projection_client

    async def fake_build_canvas_payload_for_preset_request(**_kwargs):
        return {
            "nodes": [
                {
                    "id": "beat_ctx",
                    "type": "beatContextNode",
                    "position": {"x": 100, "y": 100},
                    "style": {"width": 260, "height": 160},
                    "data": {"preset_managed": True},
                },
                {
                    "id": "skill_node",
                    "type": "skillNode",
                    "position": {"x": 440, "y": 100},
                    "style": {"width": 260, "height": 160},
                    "data": {"preset_managed": True},
                },
            ],
            "edges": [],
            "metadata": {},
        }

    monkeypatch.setattr(
        freezone,
        "_build_canvas_payload_for_preset_request",
        fake_build_canvas_payload_for_preset_request,
    )

    status, body = _project(
        client,
        "user_alice_abc123",
        scope="beat",
        episode=1,
        beat=4,
        projection_key="beat:1:4",
    )

    assert status == 200, body
    canvas_file = project_dir / "freezone" / "canvases" / "user_alice_abc123.json"
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    group = next(node for node in payload["nodes"] if node["type"] == "groupNode")
    assert group["id"] == freezone._projection_group_id("beat:1:4")
    assert group["data"]["displayName"] == "EP1/B4"
    children = [node for node in payload["nodes"] if node.get("parentId") == group["id"]]
    assert {node["id"] for node in children} == {"beat_ctx", "skill_node"}
    assert all(node.get("extent") == "parent" for node in children)


def test_projection_same_facts_noops_before_revision_check(projection_client) -> None:
    client, project_dir = projection_client

    status, body = _project(client, "user_alice_abc123")
    assert status == 200, body
    status, body = _project(client, "user_alice_abc123", base_revision=1)
    assert status == 200, body
    assert body["data"]["no_op"] is True
    assert body["data"]["revision"] == 1

    # A stale replay should also short-circuit before revision checking because
    # the projection facts are unchanged.
    status, body = _project(client, "user_alice_abc123", base_revision=0)

    canvas_file = project_dir / "freezone" / "canvases" / "user_alice_abc123.json"
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    history_dir = canvas_file.parent / "_history"
    history_entries = sorted(history_dir.glob("user_alice_abc123.rev*.json"))

    assert status == 200, body
    assert payload["revision"] == 1
    assert history_entries == []


def test_projection_changed_facts_bypass_idempotency_cache(
    projection_client,
    monkeypatch,
) -> None:
    from novelvideo.api.routes import freezone

    client, project_dir = projection_client
    scene_prompt = {"value": "old scene prompt"}

    async def fake_build_canvas_payload_for_preset_request(**_kwargs):
        return {
            "nodes": [
                {
                    "id": "scene_prompt",
                    "type": "textAnnotationNode",
                    "position": {"x": 100, "y": 100},
                    "data": {
                        "preset_managed": True,
                        "content": scene_prompt["value"],
                    },
                },
            ],
            "edges": [],
            "metadata": {},
        }

    monkeypatch.setattr(
        freezone,
        "_build_canvas_payload_for_preset_request",
        fake_build_canvas_payload_for_preset_request,
    )

    status, body = _project(
        client,
        "user_alice_abc123",
        scope="beat",
        episode=1,
        beat=4,
        projection_key="beat:1:4",
    )
    assert status == 200, body
    assert body["data"]["revision"] == 1

    status, body = _project(
        client,
        "user_alice_abc123",
        scope="beat",
        episode=1,
        beat=4,
        projection_key="beat:1:4",
        base_revision=1,
    )
    assert status == 200, body
    assert body["data"]["no_op"] is True
    assert body["data"]["revision"] == 1

    scene_prompt["value"] = "new scene prompt"
    status, body = _project(
        client,
        "user_alice_abc123",
        scope="beat",
        episode=1,
        beat=4,
        projection_key="beat:1:4",
        base_revision=1,
    )

    assert status == 200, body
    assert body["data"]["no_op"] is False
    assert body["data"]["revision"] == 2
    canvas_file = project_dir / "freezone" / "canvases" / "user_alice_abc123.json"
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    node = next(node for node in payload["nodes"] if node["id"] == "scene_prompt")
    assert node["data"]["content"] == "new scene prompt"


def test_projection_force_refresh_rewrites_dirty_projection_nodes(
    projection_client,
    monkeypatch,
) -> None:
    from novelvideo.api.routes import freezone

    client, project_dir = projection_client

    async def fake_build_canvas_payload_for_preset_request(**_kwargs):
        return {
            "nodes": [
                {
                    "id": "scene_prompt",
                    "type": "textAnnotationNode",
                    "position": {"x": 100, "y": 100},
                    "data": {
                        "preset_managed": True,
                        "content": "mainline scene prompt",
                    },
                },
            ],
            "edges": [],
            "metadata": {},
        }

    monkeypatch.setattr(
        freezone,
        "_build_canvas_payload_for_preset_request",
        fake_build_canvas_payload_for_preset_request,
    )

    status, body = _project(
        client,
        "user_alice_abc123",
        scope="beat",
        episode=1,
        beat=4,
        projection_key="beat:1:4",
    )
    assert status == 200, body

    canvas_file = project_dir / "freezone" / "canvases" / "user_alice_abc123.json"
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    node = next(node for node in payload["nodes"] if node["id"] == "scene_prompt")
    node["data"]["content"] = "dirty local edit"
    payload["revision"] = 2
    canvas_file.write_text(json.dumps(payload), encoding="utf-8")

    status, body = _project(
        client,
        "user_alice_abc123",
        scope="beat",
        episode=1,
        beat=4,
        projection_key="beat:1:4",
        base_revision=2,
    )
    assert status == 200, body
    assert body["data"]["no_op"] is True
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    node = next(node for node in payload["nodes"] if node["id"] == "scene_prompt")
    assert node["data"]["content"] == "dirty local edit"

    status, body = _project(
        client,
        "user_alice_abc123",
        scope="beat",
        episode=1,
        beat=4,
        projection_key="beat:1:4",
        base_revision=2,
        force_refresh=True,
    )

    assert status == 200, body
    assert body["data"]["no_op"] is False
    assert body["data"]["revision"] == 3
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    node = next(node for node in payload["nodes"] if node["id"] == "scene_prompt")
    assert node["data"]["content"] == "mainline scene prompt"
    projection = payload["metadata"]["projections"]["beat:1:4"]
    assert "force_refresh" not in projection["request"]


def test_projection_force_refresh_preserves_existing_group_position(
    projection_client,
    monkeypatch,
) -> None:
    from novelvideo.api.routes import freezone

    client, project_dir = projection_client
    scene_prompt = {"value": "mainline scene prompt"}

    async def fake_build_canvas_payload_for_preset_request(**_kwargs):
        return {
            "nodes": [
                {
                    "id": "scene_prompt",
                    "type": "textAnnotationNode",
                    "position": {"x": 100, "y": 100},
                    "style": {"width": 320, "height": 180},
                    "data": {
                        "preset_managed": True,
                        "content": scene_prompt["value"],
                    },
                },
            ],
            "edges": [],
            "metadata": {},
        }

    monkeypatch.setattr(
        freezone,
        "_build_canvas_payload_for_preset_request",
        fake_build_canvas_payload_for_preset_request,
    )

    status, body = _project(
        client,
        "user_alice_abc123",
        scope="beat",
        episode=1,
        beat=4,
        projection_key="beat:1:4",
    )
    assert status == 200, body

    canvas_file = project_dir / "freezone" / "canvases" / "user_alice_abc123.json"
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    group = next(node for node in payload["nodes"] if node["type"] == "groupNode")
    group["position"] = {"x": 840, "y": 360}
    payload["revision"] = 2
    canvas_file.write_text(json.dumps(payload), encoding="utf-8")

    scene_prompt["value"] = "updated mainline scene prompt"
    status, body = _project(
        client,
        "user_alice_abc123",
        scope="beat",
        episode=1,
        beat=4,
        projection_key="beat:1:4",
        base_revision=2,
        force_refresh=True,
    )

    assert status == 200, body
    assert body["data"]["revision"] == 3
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    group = next(node for node in payload["nodes"] if node["type"] == "groupNode")
    assert group["position"] == {"x": 840, "y": 360}
    node = next(node for node in payload["nodes"] if node["id"] == "scene_prompt")
    assert node["data"]["content"] == "updated mainline scene prompt"


def test_projection_force_refresh_preserves_existing_node_layout(
    projection_client,
    monkeypatch,
) -> None:
    from novelvideo.api.routes import freezone

    client, project_dir = projection_client
    scene_prompt = {"value": "mainline scene prompt"}

    async def fake_build_canvas_payload_for_preset_request(**_kwargs):
        return {
            "nodes": [
                {
                    "id": "scene_prompt",
                    "type": "textAnnotationNode",
                    "position": {"x": 100, "y": 100},
                    "style": {"width": 320, "height": 180},
                    "data": {
                        "preset_managed": True,
                        "content": scene_prompt["value"],
                    },
                },
            ],
            "edges": [],
            "metadata": {},
        }

    monkeypatch.setattr(
        freezone,
        "_build_canvas_payload_for_preset_request",
        fake_build_canvas_payload_for_preset_request,
    )

    status, body = _project(
        client,
        "user_alice_abc123",
        scope="beat",
        episode=1,
        beat=4,
        projection_key="beat:1:4",
    )
    assert status == 200, body

    canvas_file = project_dir / "freezone" / "canvases" / "user_alice_abc123.json"
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    node = next(node for node in payload["nodes"] if node["id"] == "scene_prompt")
    node["position"] = {"x": 444, "y": 222}
    node["style"] = {"width": 520, "height": 260}
    payload["revision"] = 2
    canvas_file.write_text(json.dumps(payload), encoding="utf-8")

    scene_prompt["value"] = "updated mainline scene prompt"
    status, body = _project(
        client,
        "user_alice_abc123",
        scope="beat",
        episode=1,
        beat=4,
        projection_key="beat:1:4",
        base_revision=2,
        force_refresh=True,
    )

    assert status == 200, body
    assert body["data"]["revision"] == 3
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    node = next(node for node in payload["nodes"] if node["id"] == "scene_prompt")
    assert node["position"] == {"x": 444, "y": 222}
    assert node["style"] == {"width": 520, "height": 260}
    assert node["data"]["content"] == "updated mainline scene prompt"


def test_projection_status_reports_stale_when_mainline_facts_changed(projection_client) -> None:
    client, project_dir = projection_client
    status, body = _project(client, "user_alice_abc123")
    assert status == 200, body

    response = client.post(
        "/api/v1/projects/proj_demo/freezone/canvases/user_alice_abc123/projections:status",
        json={"projection_keys": ["blank:user"]},
    )
    assert response.status_code == 200, response.json()
    item = response.json()["data"]["projections"][0]
    assert item["projection_key"] == "blank:user"
    assert item["stale"] is False

    canvas_file = project_dir / "freezone" / "canvases" / "user_alice_abc123.json"
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    payload["metadata"]["projections"]["blank:user"]["facts_signature"] = "old"
    canvas_file.write_text(json.dumps(payload), encoding="utf-8")

    response = client.post(
        "/api/v1/projects/proj_demo/freezone/canvases/user_alice_abc123/projections:status",
        json={"projection_keys": ["blank:user"]},
    )

    assert response.status_code == 200, response.json()
    item = response.json()["data"]["projections"][0]
    assert item["projection_key"] == "blank:user"
    assert item["stored_facts_signature"] == "old"
    assert item["current_facts_signature"]
    assert item["stale"] is True


def test_projection_remove_deletes_projection_without_touching_user_nodes(projection_client) -> None:
    client, project_dir = projection_client
    status, body = _project(client, "user_alice_abc123")
    assert status == 200, body

    canvas_file = project_dir / "freezone" / "canvases" / "user_alice_abc123.json"
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    payload["nodes"].append(
        {
            "id": "user_note",
            "type": "textAnnotation",
            "position": {"x": 10, "y": 10},
            "data": {"user_spawned": True},
        }
    )
    payload["revision"] = 2
    canvas_file.write_text(json.dumps(payload), encoding="utf-8")

    response = client.post(
        "/api/v1/projects/proj_demo/freezone/canvases/user_alice_abc123/projections:remove",
        json={"projection_key": "blank:user", "base_revision": 2},
    )

    assert response.status_code == 200, response.json()
    assert response.json()["data"]["projection_key"] == "blank:user"
    assert response.json()["data"]["revision"] == 3
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert "blank:user" not in payload["metadata"]["projections"]
    node_ids = {node["id"] for node in payload["nodes"]}
    assert "user_note" in node_ids


def test_projection_remove_allows_empty_canvas_when_only_projection_nodes_remain(
    projection_client,
) -> None:
    client, project_dir = projection_client
    status, body = _project(client, "user_alice_abc123")
    assert status == 200, body

    canvas_file = project_dir / "freezone" / "canvases" / "user_alice_abc123.json"
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    payload["nodes"] = [
        {
            "id": "projected_context",
            "type": "beatContext",
            "position": {"x": 0, "y": 0},
            "data": {
                "preset_managed": True,
                "projection_key": "blank:user",
            },
        }
    ]
    payload["revision"] = 2
    canvas_file.write_text(json.dumps(payload), encoding="utf-8")

    response = client.post(
        "/api/v1/projects/proj_demo/freezone/canvases/user_alice_abc123/projections:remove",
        json={"projection_key": "blank:user", "base_revision": 2},
    )

    assert response.status_code == 200, response.json()
    assert response.json()["data"]["projection_key"] == "blank:user"
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert payload["nodes"] == []
    assert payload["edges"] == []
    assert "blank:user" not in payload["metadata"]["projections"]


def test_projection_remove_missing_canvas_returns_404(projection_client) -> None:
    client, _project_dir = projection_client

    response = client.post(
        "/api/v1/projects/proj_demo/freezone/canvases/missing_canvas/projections:remove",
        json={"projection_key": "blank:user", "base_revision": 1},
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "canvas not found"


def _projection_payload_with_group() -> dict:
    """One projection: one group node + two members in place."""
    return {
        "nodes": [
            {
                "id": "scoped__projection_group_asset_character_abc",
                "type": "groupNode",
                "data": {
                    "preset_managed": True,
                    "projection_key": "asset:character:Анна",
                    "label": "Анна",
                },
            },
            {
                "id": "scoped__ref_identity_costume_1",
                "type": "imageGenNode",
                "parentId": "scoped__projection_group_asset_character_abc",
                "data": {
                    "preset_managed": True,
                    "projection_key": "asset:character:Анна",
                },
            },
            {
                "id": "scoped__character_profile",
                "type": "textAnnotationNode",
                "parentId": "scoped__projection_group_asset_character_abc",
                "data": {
                    "preset_managed": True,
                    "projection_key": "asset:character:Анна",
                },
            },
        ]
    }


def test_projection_is_intact_when_every_member_sits_in_its_own_group() -> None:
    from novelvideo.api.routes import freezone

    assert (
        freezone._projection_is_intact_in_payload(
            _projection_payload_with_group(), "asset:character:Анна"
        )
        is True
    )


def test_projection_is_broken_when_members_lost_their_group() -> None:
    """The group is gone and members are scattered on the canvas -- it must be rebuilt even if facts are unchanged, otherwise it can never be repaired."""
    from novelvideo.api.routes import freezone

    payload = _projection_payload_with_group()
    payload["nodes"] = [
        node for node in payload["nodes"] if node.get("type") != "groupNode"
    ]
    for node in payload["nodes"]:
        node.pop("parentId", None)

    assert (
        freezone._projection_is_intact_in_payload(payload, "asset:character:Анна")
        is False
    )


def test_projection_is_broken_when_members_hang_under_another_characters_group() -> None:
    """Legacy of an id collision: the member's parent is someone else's group."""
    from novelvideo.api.routes import freezone

    payload = _projection_payload_with_group()
    payload["nodes"][0]["data"]["projection_key"] = "asset:character:Борис"

    assert (
        freezone._projection_is_intact_in_payload(payload, "asset:character:Анна")
        is False
    )


def test_projection_with_no_members_is_not_reported_broken() -> None:
    from novelvideo.api.routes import freezone

    assert freezone._projection_is_intact_in_payload({"nodes": []}, "blank:user") is True
    assert freezone._projection_is_intact_in_payload(None, "blank:user") is True


def test_projection_refresh_rebuilds_group_when_facts_unchanged(
    projection_client,
    monkeypatch,
) -> None:
    """Facts unchanged but the group is lost: it must not noop, the members must be gathered back into the group.

    Group loss is the aftermath of a historical id collision / namespace migration. Upstream facts are unchanged, and looking only at facts_signature,
    refresh would noop all the way and the scattered members could never return to the group.
    """
    from novelvideo.api.routes import freezone

    client, project_dir = projection_client

    async def fake_build_canvas_payload_for_preset_request(**_kwargs):
        return {
            "nodes": [
                {
                    "id": "ref_identity_costume_1",
                    "type": "imageGenNode",
                    "position": {"x": 100, "y": 100},
                    "style": {"width": 260, "height": 160},
                    "data": {"preset_managed": True},
                },
                {
                    "id": "character_profile",
                    "type": "textAnnotationNode",
                    "position": {"x": 420, "y": 100},
                    "style": {"width": 260, "height": 160},
                    "data": {"preset_managed": True},
                },
            ],
            "edges": [],
            "metadata": {},
        }

    monkeypatch.setattr(
        freezone,
        "_build_canvas_payload_for_preset_request",
        fake_build_canvas_payload_for_preset_request,
    )

    status, body = _project(client, "user_alice_abc123")
    assert status == 200, body

    canvas_file = project_dir / "freezone" / "canvases" / "user_alice_abc123.json"
    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert any(node.get("type") == "groupNode" for node in payload["nodes"])
    revision = payload["revision"]

    # Simulate the aftermath of a namespace migration: the group is gone and the members become scattered nodes.
    payload["nodes"] = [
        {key: value for key, value in node.items() if key not in {"parentId", "extent"}}
        for node in payload["nodes"]
        if node.get("type") != "groupNode"
    ]
    canvas_file.write_text(json.dumps(payload), encoding="utf-8")

    status, body = _project(client, "user_alice_abc123", base_revision=revision)
    assert status == 200, body
    assert body["data"].get("noop_reason") != "projection_facts_unchanged"

    payload = json.loads(canvas_file.read_text(encoding="utf-8"))
    groups = [
        node
        for node in payload["nodes"]
        if node.get("type") == "groupNode"
        and (node.get("data") or {}).get("projection_key") == "blank:user"
    ]
    assert len(groups) == 1
    members = [
        node
        for node in payload["nodes"]
        if node.get("type") != "groupNode"
        and (node.get("data") or {}).get("projection_key") == "blank:user"
    ]
    assert members
    assert all(node.get("parentId") == groups[0]["id"] for node in members)
