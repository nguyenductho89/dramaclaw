import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.api.routes.freezone import (
    _asset_record_from_path,
    _beat_context_asset_from_ref,
    _default_push_target_for_preset,
    _is_freezone_scene_library_role,
)
from novelvideo.api.schemas import PresetCanvasRequest
from novelvideo.freezone import presets as freezone_presets
from novelvideo.freezone.presets import (
    _add_file_ref,
    _add_scene_refs,
    _is_asset_library_reference,
    _nearest_supported_image_aspect_ratio,
    _project_sketch_aspect_ratio,
    build_episode_preset_context,
    build_asset_preset_context,
    build_canvas_payload_from_context,
)
from novelvideo.generators.nanobanana_prop import build_prop_reference_prompt


def test_preset_file_refs_include_media_type_for_beat_video_and_audio(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    video_path = project_dir / "videos" / "beats" / "ep001" / "beat_02.mp4"
    audio_path = project_dir / "audio" / "ep001" / "beat_02.mp3"
    video_path.parent.mkdir(parents=True)
    audio_path.parent.mkdir(parents=True)
    video_path.write_bytes(b"fake video")
    audio_path.write_bytes(b"fake audio")

    refs = []
    _add_file_ref(
        refs,
        project_id="proj_demo",
        username="admin",
        project="demo",
        project_dir=project_dir,
        kind="video",
        role="current_video",
        label="current beat video",
        rel_path="videos/beats/ep001/beat_02.mp4",
    )
    _add_file_ref(
        refs,
        project_id="proj_demo",
        username="admin",
        project="demo",
        project_dir=project_dir,
        kind="audio",
        role="current_audio",
        label="current beat audio",
        rel_path="audio/ep001/beat_02.mp3",
    )

    payload = [ref.model_dump() for ref in refs]
    assert payload[0]["media_type"] == "video"
    assert payload[0]["aspect_ratio"] == "16:9"
    assert payload[0]["mainline_context"][0]["kind"] == "video"
    assert payload[0]["mainline_context"][0]["role"] == "current_video"
    assert payload[1]["media_type"] == "audio"
    assert payload[1]["aspect_ratio"] == "1:1"
    assert payload[1]["mainline_context"][0]["kind"] == "audio"
    assert payload[1]["mainline_context"][0]["audioRole"] == "beat_audio"


def test_beat_context_asset_excludes_freezone_runtime_outputs() -> None:
    asset = _beat_context_asset_from_ref(
        ref={
            "kind": "video",
            "role": "current_video",
            "label": "current beat video",
            "rel_path": "videos/beats/ep001/beat_02.mp4",
            "url": "/static/admin/demo/videos/beats/ep001/beat_02.mp4",
            "exists": True,
            "media_type": "video",
            "aspect_ratio": "16:9",
            "meta": {},
        },
        project_id="proj_1",
        episode=1,
        beat=2,
    )
    assert asset is not None
    assert asset["tab"] == "beat"
    assert asset["media_type"] == "video"
    assert asset["sublabel"] == "EP1 / Beat 2"
    assert asset["mainline_context"][0]["kind"] == "video"
    assert asset["mainline_context"][0]["projectId"] == "proj_1"
    assert asset["slot_target"] == {"kind": "video", "episode": 1, "beat": 2}
    assert asset["pushable"] is True
    assert not any(ctx.get("kind") == "beat" for ctx in asset["mainline_context"])

    assert (
        _beat_context_asset_from_ref(
            ref={
                "kind": "image",
                "role": "candidate",
                "label": "temporary output",
                "rel_path": "freezone/_outputs/freezone_gen/x.png",
                "url": "/static/admin/demo/freezone/_outputs/freezone_gen/x.png",
                "exists": True,
            },
            project_id="proj_1",
            episode=1,
            beat=2,
        )
        is None
    )


def test_beat_audio_asset_has_push_target() -> None:
    asset = _beat_context_asset_from_ref(
        ref={
            "kind": "audio",
            "role": "current_audio",
            "label": "current beat audio",
            "rel_path": "audio/ep001/beat_02.mp3",
            "url": "/static/admin/demo/audio/ep001/beat_02.mp3",
            "exists": True,
            "media_type": "audio",
            "aspect_ratio": "1:1",
            "meta": {},
        },
        project_id="proj_1",
        episode=1,
        beat=2,
    )

    assert asset is not None
    assert asset["media_type"] == "audio"
    assert asset["slot_target"] == {"kind": "beat_audio", "episode": 1, "beat": 2}
    assert asset["pushable"] is True
    assert asset["mainline_context"][0]["kind"] == "audio"


def test_scene_asset_records_include_push_targets() -> None:
    project_dir = Path(__file__).resolve().parents[1]
    existing_file = Path(__file__).resolve()
    cases = [
        ("scene", "scene_master", existing_file, {"kind": "scene_master", "scene_id": "compound"}),
        (
            "scene",
            "scene_reverse_master",
            existing_file,
            {"kind": "scene_reverse_master", "scene_id": "compound"},
        ),
        (
            "scene",
            "scene_director_pano_360",
            existing_file,
            {"kind": "scene_director_pano_360", "scene_id": "compound"},
        ),
        (
            "scene",
            "scene_3gs_pano_ply",
            existing_file,
            {"kind": "scene_3gs_pano_ply", "scene_id": "compound"},
        ),
        (
            "scene",
            "scene_3gs_collision_glb",
            existing_file,
            {"kind": "scene_3gs_collision_glb", "scene_id": "compound"},
        ),
    ]

    for kind, role, path, target in cases:
        record = _asset_record_from_path(
            username="admin",
            project="demo",
            project_dir=project_dir,
            project_id="proj_1",
            tab="scenes",
            kind=kind,
            role=role,
            label=role,
            abs_path=path,
            meta={"scene_id": "compound"},
        )
        assert record["slot_target"] == target
        assert record["pushable"] is True


def test_freezone_scene_asset_library_roles_match_assets_scene_ui() -> None:
    visible_roles = {
        "scene_master",
        "scene_reverse_master",
        "scene_director_pano_360",
        "scene_3gs_master_ply",
        "scene_3gs_reverse_ply",
        "scene_3gs_pano_ply",
        "scene_3gs_custom_scene",
    }
    hidden_roles = {
        "scene_360",
        "scene_3gs_active_ply",
        "scene_3gs_collision_glb",
    }

    assert all(_is_freezone_scene_library_role(role) for role in visible_roles)
    assert not any(_is_freezone_scene_library_role(role) for role in hidden_roles)


def test_identity_costume_asset_record_has_push_target() -> None:
    project_dir = Path(__file__).resolve().parents[1]
    record = _asset_record_from_path(
        username="admin",
        project="demo",
        project_dir=project_dir,
        project_id="proj_1",
        tab="characters",
        kind="identity_costume",
        role="identity_costume",
        label="LinZhao / young_adult costume",
        abs_path=Path(__file__).resolve(),
        meta={"character": "LinZhao", "identity_id": "LinZhao_young_adult"},
    )

    assert record["slot_target"] == {
        "kind": "identity_costume",
        "character": "LinZhao",
        "identity_id": "LinZhao_young_adult",
    }
    assert record["pushable"] is True
    assert record["history_url"] == (
        "/api/v1/projects/proj_1/characters/LinZhao/"
        "asset-history?kind=identity_costume&identity_id=LinZhao_young_adult"
    )
    assert record["restore_url"] == (
        "/api/v1/projects/proj_1/characters/LinZhao/asset-history/restore"
    )


def test_identity_portrait_asset_record_has_push_target() -> None:
    project_dir = Path(__file__).resolve().parents[1]
    record = _asset_record_from_path(
        username="admin",
        project="demo",
        project_dir=project_dir,
        project_id="proj_1",
        tab="characters",
        kind="identity_portrait",
        role="identity_portrait",
        label="LinZhao / young_adult portrait",
        abs_path=Path(__file__).resolve(),
        meta={"character": "LinZhao", "identity_id": "LinZhao_young_adult"},
    )

    assert record["slot_target"] == {
        "kind": "identity_portrait",
        "character": "LinZhao",
        "identity_id": "LinZhao_young_adult",
    }
    assert record["pushable"] is True


def test_director_combined_asset_record_carries_control_bundle(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    bundle_dir = project_dir / "director_control_frames" / "ep001" / "beat_06"
    bundle_dir.mkdir(parents=True)
    (bundle_dir / "combined.png").write_bytes(b"combined")
    (bundle_dir / "env_only.png").write_bytes(b"env")
    (bundle_dir / "frame_meta.json").write_text('{"frame_aspect": "16:9"}', encoding="utf-8")

    record = _asset_record_from_path(
        username="admin",
        project="demo",
        project_dir=project_dir,
        project_id="proj_1",
        tab="beat",
        kind="director",
        role="director_combined",
        label="Director composite image",
        abs_path=bundle_dir / "combined.png",
        aspect_ratio="16:9",
        meta={"episode": 1, "beat": 6},
    )

    bundle = record["director_control_bundle"]
    assert bundle["schema_version"] == "director_control_bundle_v1"
    assert bundle["rel_paths"] == {
        "combined": "director_control_frames/ep001/beat_06/combined.png",
        "env_only": "director_control_frames/ep001/beat_06/env_only.png",
        "frame_meta": "director_control_frames/ep001/beat_06/frame_meta.json",
    }
    assert bundle["urls"]["combined"].endswith(
        "/director_control_frames/ep001/beat_06/combined.png"
    )
    assert bundle["urls"]["env_only"].endswith(
        "/director_control_frames/ep001/beat_06/env_only.png"
    )
    assert bundle["urls"]["frame_meta"].endswith(
        "/director_control_frames/ep001/beat_06/frame_meta.json"
    )


def test_scene_preset_refs_include_all_scene_reference_images(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    scene_dir = project_dir / "assets" / "scenes" / "compound"
    pano_dir = project_dir / "director_worlds" / "compound" / "v1"
    scene_dir.mkdir(parents=True)
    pano_dir.mkdir(parents=True)
    for filename in ("master.png", "reverse_master.png", "spatial_layout.png"):
        (scene_dir / filename).write_bytes(b"fake scene image")
    # scene_360 (sketch-stage panorama) is deliberately written here to assert
    # that _add_scene_refs ignores it even when the file exists — scene_360 was
    # deprecated in favor of scene_director_pano_360 (the director-stage SHARP
    # render from master+reverse) and is no longer surfaced as a canvas node.
    (scene_dir / "scene_panorama_sketch_360.png").write_bytes(b"fake scene 360 image")
    (pano_dir / "pano_360.png").write_bytes(b"fake pano image")
    (pano_dir / "pano_sharp_merged.ply").write_bytes(b"fake ply")
    (pano_dir / "stage_manifest.json").write_text(
        '{"pano_path": "pano_360.png", "ply_path": "pano_sharp_merged.ply", '
        '"pano_ply_path": "pano_sharp_merged.ply"}'
    )

    refs = []
    _add_scene_refs(
        refs,
        project_id="proj_demo",
        username="admin",
        project="demo",
        project_dir=project_dir,
        scene_name="compound",
        scene_info={"environment_prompt": "Compound courtyard, white buildings, lush greenery"},
    )

    payload_refs = [ref.model_dump() for ref in refs]
    assert [ref["role"] for ref in payload_refs] == [
        "scene_master",
        "scene_reverse_master",
        "scene_director_pano_360",
        "scene_3gs_pano_ply",
    ]
    assert "scene_360" not in {ref["role"] for ref in payload_refs}
    assert "scene_spatial_layout" not in {ref["role"] for ref in payload_refs}
    assert all(ref["exists"] for ref in payload_refs)
    assert all(ref["meta"]["scene_id"] == "compound" for ref in payload_refs)
    assert all(ref["mainline_context"][0]["kind"] == "scene" for ref in payload_refs)
    assert all(
        ref["meta"]["environment_prompt"] == "Compound courtyard, white buildings, lush greenery" for ref in payload_refs
    )


def test_scene_asset_preset_creates_missing_ply_workflow_nodes() -> None:
    context = {
        "scope": "asset",
        "asset_kind": "scene",
        "asset_id": "lanzhou",
        "refs": [
            {
                "kind": "scene",
                "role": "scene_master",
                "label": "lanzhou master",
                "rel_path": "assets/scenes/lanzhou/master.png",
                "url": "/static/admin/demo/assets/scenes/lanzhou/master.png",
                "exists": True,
                "aspect_ratio": "16:9",
                "meta": {"scene_id": "lanzhou", "environment_prompt": "Noodle shop front"},
            },
            {
                "kind": "scene",
                "role": "scene_reverse_master",
                "label": "lanzhou reverse",
                "rel_path": "assets/scenes/lanzhou/reverse_master.png",
                "url": "/static/admin/demo/assets/scenes/lanzhou/reverse_master.png",
                "exists": True,
                "aspect_ratio": "16:9",
                "meta": {"scene_id": "lanzhou", "environment_prompt": "Noodle shop back"},
            },
            {
                "kind": "scene",
                "role": "scene_360",
                "label": "lanzhou 360",
                "rel_path": "assets/scenes/lanzhou/scene_panorama_sketch_360.png",
                "url": "/static/admin/demo/assets/scenes/lanzhou/scene_panorama_sketch_360.png",
                "exists": True,
                "aspect_ratio": "2:1",
                "meta": {"scene_id": "lanzhou", "environment_prompt": "Noodle shop panorama"},
            },
        ],
    }

    payload = build_canvas_payload_from_context(
        context=context,
        preset_key="asset:scene:::lanzhou",
        default_push_target={"kind": "scene_master", "scene_id": "lanzhou"},
    )
    nodes = {node["id"]: node for node in payload["nodes"]}
    edges = {(edge["source"], edge["target"]) for edge in payload["edges"]}

    assert nodes["skill_scene_360"]["type"] == "skillNode"
    assert nodes["skill_scene_360"]["data"]["skill_id"] == "freezone.scene_360"
    assert nodes["skill_scene_360"]["data"]["preset_managed"] is True
    assert nodes["skill_scene_360"]["measured"] == {"width": 380, "height": 520}
    assert "workflow_scene_director_pano_360" not in nodes
    assert "workflow_scene_lanzhou_master_ply" not in nodes
    assert "workflow_scene_lanzhou_reverse_ply" not in nodes
    assert "workflow_scene_lanzhou_pano_ply" not in nodes
    world = nodes["director_world_scene_lanzhou"]
    assert world["type"] == "threeDWorldNode"
    assert world["data"]["displayName"] == "lanzhou director world"
    assert ("ref_scene_master_1", "director_world_scene_lanzhou") in edges
    assert ("ref_scene_reverse_master_1", "director_world_scene_lanzhou") in edges
    assert ("ref_scene_360_1", "director_world_scene_lanzhou") in edges
    assert world["data"]["sources"] == [
        {
            "id": "scene-pano:lanzhou",
            "source_type": "pano360",
            "source_kind": "pano",
            "label": "lanzhou 360",
            "url": "/static/admin/demo/assets/scenes/lanzhou/scene_panorama_sketch_360.png",
            "pano_url": "/static/admin/demo/assets/scenes/lanzhou/scene_panorama_sketch_360.png",
            "slot_kind": "scene_director_pano_360",
        }
    ]

    role_edges = {
        (
            edge["source"],
            edge["target"],
            edge.get("targetHandle"),
            (edge.get("data") or {}).get("role"),
        )
        for edge in payload["edges"]
        if (edge.get("data") or {}).get("edgeKind") == "role_binding"
    }
    assert (
        "ref_scene_master_1",
        "skill_scene_360",
        "scene_master",
        "scene_master",
    ) in role_edges
    assert (
        "ref_scene_reverse_master_1",
        "skill_scene_360",
        "scene_reverse_master",
        "scene_reverse_master",
    ) in role_edges
    assert ("prompt_scene_lanzhou", "skill_scene_360", "scene", "scene") in role_edges
    skill_output_edges = [
        edge
        for edge in payload["edges"]
        if edge["source"] == "skill_scene_360" and edge["target"] == "ref_scene_360_1"
    ]
    assert skill_output_edges[0]["sourceHandle"] == "scene_360_candidate"


def test_scene_asset_preset_prompt_nodes_show_final_style_prompt() -> None:
    context = {
        "scope": "asset",
        "asset_kind": "scene",
        "asset_id": "lanzhou",
        "refs": [
            {
                "kind": "scene",
                "role": "scene_master",
                "label": "lanzhou master",
                "rel_path": "assets/scenes/lanzhou/master.png",
                "url": None,
                "exists": False,
                "aspect_ratio": "16:9",
                "meta": {
                    "scene_id": "lanzhou",
                    "scene_type": "interior",
                    "environment_prompt": "Noodle shop front, old wooden tables, warm yellow lighting",
                    "style_name": "Cinematic realism (cinematic)",
                    "style_prompt": "cinematic realism, natural skin texture, grounded lighting",
                    "avoid_instructions": "no cartoon rendering, no plastic surfaces",
                },
            },
            {
                "kind": "scene",
                "role": "scene_reverse_master",
                "label": "lanzhou reverse",
                "rel_path": "assets/scenes/lanzhou/reverse_master.png",
                "url": None,
                "exists": False,
                "aspect_ratio": "16:9",
                "meta": {
                    "scene_id": "lanzhou",
                    "scene_type": "interior",
                    "environment_prompt": "Noodle shop back, cashier counter and kitchen door",
                    "style_name": "Cinematic realism (cinematic)",
                    "style_prompt": "cinematic realism, natural skin texture, grounded lighting",
                    "avoid_instructions": "no cartoon rendering, no plastic surfaces",
                },
            },
            {
                "kind": "scene",
                "role": "scene_director_pano_360",
                "label": "lanzhou pano",
                "rel_path": "director_worlds/lanzhou/v1/pano_360.png",
                "url": None,
                "exists": False,
                "aspect_ratio": "2:1",
                "meta": {
                    "scene_id": "lanzhou",
                    "scene_type": "interior",
                    "environment_prompt": "Noodle shop full space",
                    "style_name": "Cinematic realism (cinematic)",
                    "style_prompt": "cinematic realism, natural skin texture, grounded lighting",
                    "avoid_instructions": "no cartoon rendering, no plastic surfaces",
                },
            },
        ],
    }

    payload = build_canvas_payload_from_context(
        context=context,
        preset_key="asset:scene:::lanzhou",
        default_push_target={"kind": "scene_master", "scene_id": "lanzhou"},
    )
    nodes = {node["id"]: node for node in payload["nodes"]}

    for node_id in ["prompt_scene_lanzhou_master", "prompt_scene_lanzhou"]:
        content = nodes[node_id]["data"]["content"]
        assert "PROJECT STYLE PRESET:" in content
        assert "- Style id/name: Cinematic realism (cinematic)" in content
        assert "cinematic realism, natural skin texture, grounded lighting" in content
        assert "no cartoon rendering, no plastic surfaces" in content
    reverse_content = nodes["prompt_scene_lanzhou_reverse_master"]["data"]["content"]
    assert "STYLE SOURCE:" in reverse_content
    assert "REFERENCE 1's pixels" in reverse_content


def test_derived_scene_asset_preset_projects_base_master_dependency() -> None:
    context = {
        "scope": "asset",
        "asset_kind": "scene",
        "asset_id": "bathroom_leak",
        "refs": [
            {
                "kind": "scene",
                "role": "scene_master",
                "label": "bathroom_leak master",
                "rel_path": "assets/scenes/bathroom_leak/master.png",
                "url": "/static/admin/demo/assets/scenes/bathroom_leak/master.png",
                "exists": True,
                "aspect_ratio": "16:9",
                "meta": {
                    "scene_id": "bathroom_leak",
                    "base_scene_id": "bathroom",
                    "variant_id": "leak",
                    "variant_prompt": "Standing water on the floor, with the ceiling dripping continuously.",
                    "base_master_url": "/static/admin/demo/assets/scenes/bathroom/master.png",
                    "base_master_rel_path": "assets/scenes/bathroom/master.png",
                    "base_environment_prompt": "White-tile walls, with a washbasin at the front.",
                },
            },
        ],
    }

    payload = build_canvas_payload_from_context(
        context=context,
        preset_key="asset:scene:::bathroom_leak",
        default_push_target={"kind": "scene_master", "scene_id": "bathroom_leak"},
    )
    nodes = {node["id"]: node for node in payload["nodes"]}
    edges = {(edge["source"], edge["target"]) for edge in payload["edges"]}

    base_node_id = "ref_scene_base_master_bathroom_leak"
    assert nodes[base_node_id]["type"] == "imageGenNode"
    assert nodes[base_node_id]["data"]["displayName"] == "bathroom base master"
    assert nodes[base_node_id]["data"]["imageUrl"].endswith("assets/scenes/bathroom/master.png")
    assert (base_node_id, "ref_scene_master_1") in edges
    assert ("prompt_scene_bathroom_leak_master", "ref_scene_master_1") in edges


def test_scene_asset_preset_folds_existing_3gs_sources_into_director_world() -> None:
    context = {
        "scope": "asset",
        "asset_kind": "scene",
        "asset_id": "lanzhou",
        "refs": [
            {
                "kind": "scene",
                "role": "scene_master",
                "label": "lanzhou master",
                "rel_path": "assets/scenes/lanzhou/master.png",
                "url": "/static/admin/demo/assets/scenes/lanzhou/master.png",
                "exists": True,
                "aspect_ratio": "16:9",
                "meta": {"scene_id": "lanzhou"},
            },
            {
                "kind": "scene",
                "role": "scene_director_pano_360",
                "label": "lanzhou pano",
                "rel_path": "director_worlds/lanzhou/v1/pano_360.png",
                "url": "/static/admin/demo/director_worlds/lanzhou/v1/pano_360.png",
                "exists": True,
                "aspect_ratio": "2:1",
                "meta": {"scene_id": "lanzhou"},
            },
            {
                "kind": "scene",
                "role": "scene_3gs_pano_ply",
                "label": "lanzhou 3D world (360)",
                "rel_path": "director_worlds/lanzhou/v1/world.sog",
                "url": "/static/admin/demo/director_worlds/lanzhou/v1/world.sog",
                "exists": True,
                "media_type": "file",
                "aspect_ratio": "1:1",
                "meta": {"scene_id": "lanzhou", "ply_kind": "pano"},
            },
        ],
    }

    payload = build_canvas_payload_from_context(
        context=context,
        preset_key="asset:scene:::lanzhou",
        default_push_target={"kind": "scene_master", "scene_id": "lanzhou"},
    )
    nodes = {node["id"]: node for node in payload["nodes"]}
    edges = {(edge["source"], edge["target"]) for edge in payload["edges"]}

    assert "ref_scene_3gs_pano_ply_1" not in nodes
    world = nodes["director_world_scene_lanzhou"]
    assert ("ref_scene_director_pano_360_1", "director_world_scene_lanzhou") in edges
    assert world["data"]["activeSourceId"] == "scene-sog:pano:lanzhou"
    assert world["data"]["plyUrl"] == "/static/admin/demo/director_worlds/lanzhou/v1/world.sog"
    assert world["data"]["panoUrl"] == "/static/admin/demo/director_worlds/lanzhou/v1/pano_360.png"
    assert [source["source_type"] for source in world["data"]["sources"]] == ["pano360", "sog"]


@pytest.mark.asyncio
async def test_scene_asset_preset_emits_missing_scene_slot_placeholders(tmp_path: Path) -> None:
    class Store:
        async def get_scene(self, scene_id: str):
            return {
                "scene_id": scene_id,
                "scene_type": "interior",
                "environment_prompt": "Inside the Lanzhou noodle shop, dim lighting, old tables and chairs",
            }

    _write_fake_image(tmp_path / "assets/scenes/lanzhou/spatial_layout.png")

    context = await build_asset_preset_context(
        project_id="proj_demo",
        username="admin",
        project="demo",
        project_dir=tmp_path,
        store=Store(),
        asset_kind="scene",
        asset_id="lanzhou",
    )

    refs_by_role = {ref["role"]: ref for ref in context["refs"]}
    assert refs_by_role["scene_master"]["exists"] is False
    assert refs_by_role["scene_master"]["url"] is None
    assert refs_by_role["scene_master"]["rel_path"] == "assets/scenes/lanzhou/master.png"
    assert refs_by_role["scene_reverse_master"]["exists"] is False
    assert refs_by_role["scene_reverse_master"]["url"] is None
    assert (
        refs_by_role["scene_reverse_master"]["rel_path"]
        == "assets/scenes/lanzhou/reverse_master.png"
    )
    assert refs_by_role["scene_director_pano_360"]["exists"] is False
    assert refs_by_role["scene_director_pano_360"]["url"] is None
    assert (
        refs_by_role["scene_director_pano_360"]["rel_path"]
        == "director_worlds/lanzhou/v1/pano_360.png"
    )
    assert "scene_spatial_layout" not in refs_by_role

    payload = build_canvas_payload_from_context(
        context=context,
        preset_key="asset:scene:::lanzhou",
        default_push_target={"kind": "scene_master", "scene_id": "lanzhou"},
    )
    nodes = {node["id"]: node for node in payload["nodes"]}
    edges = {(edge["source"], edge["target"]) for edge in payload["edges"]}

    assert nodes["ref_scene_master_1"]["type"] == "imageGenNode"
    assert nodes["ref_scene_master_1"]["data"]["imageUrl"] is None
    assert nodes["ref_scene_master_1"]["data"]["slot_target"] == {
        "kind": "scene_master",
        "scene_id": "lanzhou",
    }
    assert nodes["ref_scene_master_1"]["data"]["autoCommitOnGenerate"] is True
    assert nodes["ref_scene_reverse_master_1"]["type"] == "imageGenNode"
    assert nodes["ref_scene_reverse_master_1"]["data"]["imageUrl"] is None
    assert nodes["ref_scene_reverse_master_1"]["data"]["slot_target"] == {
        "kind": "scene_reverse_master",
        "scene_id": "lanzhou",
    }
    assert nodes["ref_scene_reverse_master_1"]["data"]["autoCommitOnGenerate"] is True
    assert nodes["ref_scene_director_pano_360_1"]["type"] == "imageGenNode"
    assert nodes["ref_scene_director_pano_360_1"]["data"]["media_kind"] == "pano360"
    assert (
        nodes["ref_scene_director_pano_360_1"]["data"]["output_role"] == "scene_director_pano_360"
    )
    assert nodes["ref_scene_director_pano_360_1"]["data"]["slot_target"] == {
        "kind": "scene_director_pano_360",
        "scene_id": "lanzhou",
    }
    assert "skill_scene_360" in nodes
    assert ("ref_scene_master_1", "skill_scene_360") in edges
    assert ("ref_scene_reverse_master_1", "skill_scene_360") in edges
    assert ("skill_scene_360", "ref_scene_director_pano_360_1") in edges
    assert "director_world_scene_lanzhou" in nodes
    assert ("ref_scene_master_1", "director_world_scene_lanzhou") in edges
    assert ("ref_scene_reverse_master_1", "director_world_scene_lanzhou") in edges
    assert ("ref_scene_director_pano_360_1", "director_world_scene_lanzhou") in edges
    assert not any(node["type"] == "pano360ViewerNode" for node in nodes.values())
    assert not any("scene_spatial_layout" in node_id for node_id in nodes)


class _FakeEpisodeWorkbenchStore:
    async def get_beats_as_dicts(self, episode: int) -> list[dict]:
        assert episode == 1
        return [
            {
                "beat_number": 1,
                "visual_description": "ChenMo picks up [[resident_rules]] beside {{ChenMo_young_adult}}.",
                "narration_segment": "ChenMo finds the rules wrong.",
                "scene_ref": {"scene_id": "compound"},
                "detected_identities": [
                    {"identity_id": "ChenMo_young_adult"},
                    {"identity_id": "ChenMo_young_adult"},
                ],
                "detected_props": [{"prop_id": "resident_rules"}, {"prop_id": "resident_rules"}],
            },
            {
                "beat_number": 2,
                "visual_description": "DuChen stands in front of {{DuChen_formal}}.",
                "narration_segment": "DuChen appears.",
                "scene_ref": {"scene_id": "office"},
                "detected_identities": [{"identity_id": "DuChen_formal"}],
                "detected_props": [],
            },
        ]

    async def get_episode_from_graph(self, episode: int):
        assert episode == 1
        return SimpleNamespace(title="Episode 1")

    async def get_scene(self, scene_id: str):
        return {"scene_id": scene_id, "scene_type": "interior"}


def _write_fake_image(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"fake image")


@pytest.mark.asyncio
async def test_episode_preset_creates_overview_context_graph(tmp_path: Path) -> None:
    _write_fake_image(tmp_path / "director_control_frames/ep001/beat_01/selected_background.png")
    _write_fake_image(tmp_path / "director_control_frames/ep001/beat_02/selected_background.png")

    context = await build_episode_preset_context(
        project_id="proj_demo",
        username="admin",
        project="demo",
        project_dir=tmp_path,
        store=_FakeEpisodeWorkbenchStore(),
        episode=1,
    )

    payload = build_canvas_payload_from_context(
        context=context,
        preset_key="episode:ep001",
        default_push_target={"kind": "manual", "episode": 1},
    )
    nodes = {node["id"]: node for node in payload["nodes"]}
    edges = {(edge["source"], edge["target"]) for edge in payload["edges"]}
    edge_ids = [edge["id"] for edge in payload["edges"]]
    edge_by_pair = {(edge["source"], edge["target"]): edge for edge in payload["edges"]}

    assert len(edge_ids) == len(set(edge_ids))
    assert "context_episode" in nodes
    assert "context_beat_001" in nodes
    assert "context_beat_002" in nodes
    assert nodes["context_beat_001"]["type"] == "beatContextNode"
    assert nodes["context_beat_001"]["measured"] == {"width": 420, "height": 560}
    assert "context_scene____" not in nodes
    assert "context_background_001" in nodes
    assert "context_background_002" in nodes
    assert "ref_character_identity_1" not in nodes
    assert "ref_prop_reference_1" not in nodes
    assert "ref_selected_background_1" not in nodes
    assert nodes["context_beat_001"]["data"]["mainline_context"][0]["kind"] == "beat"
    assert nodes["context_beat_001"]["data"]["workbench_target"] == {
        "scope": "beat",
        "episode": 1,
        "beat": 1,
    }
    identity_nodes = [
        node
        for node in nodes.values()
        if (node.get("data") or {}).get("mainline_context", [{}])[0].get("kind") == "identity"
    ]
    prop_nodes = [
        node
        for node in nodes.values()
        if (node.get("data") or {}).get("mainline_context", [{}])[0].get("kind") == "prop"
    ]
    assert {node["data"]["mainline_context"][0]["identityId"] for node in identity_nodes} == {
        "DuChen_formal",
        "ChenMo_young_adult",
    }
    assert {node["data"]["mainline_context"][0]["propId"] for node in prop_nodes} == {
        "resident_rules",
    }
    assert ("context_beat_001", "context_episode") in edges
    assert ("context_beat_002", "context_episode") in edges
    assert ("context_beat_001", "context_background_001") in edges
    assert ("context_beat_002", "context_background_002") in edges
    assert (
        nodes["context_background_001"]["position"]["y"]
        == nodes["context_beat_001"]["position"]["y"]
    )
    assert (
        nodes["context_background_002"]["position"]["y"]
        == nodes["context_beat_002"]["position"]["y"]
    )
    assert edge_by_pair[("context_beat_001", "context_background_001")]["data"] == {
        "edgeKind": "mainline_data",
        "propagates": True,
        "preset_managed": True,
    }
    assert any(
        edge[0] == "context_beat_001" and edge[1].startswith("context_identity_") for edge in edges
    )
    assert any(
        edge[0] == "context_beat_001" and edge[1].startswith("context_prop_") for edge in edges
    )
    assert payload["metadata"]["preset"]["scope"] == "episode"
    assert payload["metadata"]["default_push_target"] == {"kind": "manual", "episode": 1}


@pytest.mark.asyncio
async def test_episode_preset_uses_one_best_ref_per_context_asset(tmp_path: Path) -> None:
    # ChenMo has a canonical identity image (assets/characters/ChenMo/identities/...).
    # DuChen has only portrait + deprecated reference_front — i.e. canonical identity is
    # MISSING. EP preset now skips portrait fallback for
    # identity refs (Q1 fix: avoid surfacing a portrait stand-in as if it were
    # a generated identity at the EP scope), so DuChen should NOT appear in the
    # EP-scope refs. The beat workbench preset still keeps the fallback.
    _write_fake_image(tmp_path / "assets/characters/ChenMo/identities/young_adult.png")
    _write_fake_image(tmp_path / "assets/characters/ChenMo/portrait.png")
    _write_fake_image(tmp_path / "assets/characters/ChenMo/reference_front.png")
    _write_fake_image(tmp_path / "assets/characters/DuChen/portrait.png")
    _write_fake_image(tmp_path / "assets/characters/DuChen/reference_front.png")
    _write_fake_image(tmp_path / "assets/props/resident_rules/reference_3view.png")
    _write_fake_image(tmp_path / "assets/scenes/compound/master.png")
    _write_fake_image(tmp_path / "assets/scenes/compound/reverse_master.png")
    _write_fake_image(tmp_path / "assets/scenes/office/master.png")
    _write_fake_image(tmp_path / "director_control_frames/ep001/beat_01/selected_background.png")
    _write_fake_image(tmp_path / "director_control_frames/ep001/beat_02/selected_background.png")

    context = await build_episode_preset_context(
        project_id="proj_demo",
        username="admin",
        project="demo",
        project_dir=tmp_path,
        store=_FakeEpisodeWorkbenchStore(),
        episode=1,
    )

    refs = context["refs"]
    identity_refs = [ref for ref in refs if ref["kind"] == "identity"]
    background_refs = [ref for ref in refs if ref["role"] == "selected_background"]
    prop_refs = [ref for ref in refs if ref["kind"] == "prop"]

    # Only ChenMo has a canonical four-view identity file → only ChenMo is emitted at EP scope.
    assert {
        (ref["role"], ref["meta"].get("identity_id"), ref["meta"].get("character"))
        for ref in identity_refs
    } == {
        ("character_identity", "ChenMo_young_adult", "ChenMo"),
    }
    assert [ref["role"] for ref in background_refs] == [
        "selected_background",
        "selected_background",
    ]
    assert [ref["meta"].get("beat") for ref in background_refs] == [1, 2]
    assert [ref["role"] for ref in prop_refs] == ["prop_reference"]


class _FakeBeatWorkbenchStore:
    _characters = {"ChenMo": object()}

    async def get_beats_as_dicts(self, episode: int) -> list[dict]:
        assert episode == 1
        return [
            {
                "beat_number": 2,
                "visual_description": "{{ChenMo_young_adult}} picks up [[resident_rules]].",
                "narration_segment": "ChenMo finds the rules wrong.",
                "scene_ref": {"scene_id": "compound"},
                "detected_identities": [{"identity_id": "ChenMo_young_adult"}],
                "detected_props": [{"prop_id": "resident_rules"}],
            }
        ]

    async def get_episode_from_graph(self, episode: int):
        assert episode == 1
        return SimpleNamespace(title="Episode 1", prop_menu=[])

    async def get_scene(self, scene_id: str):
        return {"scene_id": scene_id, "scene_type": "exterior"}

    def get_all_characters(self) -> list:
        return []


@pytest.mark.asyncio
async def test_beat_preset_keeps_minimal_context_refs(tmp_path: Path) -> None:
    _write_fake_image(tmp_path / "assets/characters/ChenMo/identities/young_adult.png")
    _write_fake_image(tmp_path / "assets/characters/ChenMo/portrait.png")
    _write_fake_image(tmp_path / "assets/characters/ChenMo/reference_front.png")
    _write_fake_image(tmp_path / "assets/props/resident_rules/reference_3view.png")
    _write_fake_image(tmp_path / "assets/scenes/compound/master.png")
    _write_fake_image(tmp_path / "assets/scenes/compound/reverse_master.png")
    _write_fake_image(tmp_path / "assets/scenes/compound/scene_panorama_sketch_360.png")
    _write_fake_image(tmp_path / "sketches/ep001/beat_02.png")
    _write_fake_image(tmp_path / "frames/ep001/beat_02.png")
    _write_fake_image(tmp_path / "director_control_frames/ep001/beat_02/combined.png")
    _write_fake_image(tmp_path / "director_control_frames/ep001/beat_02/selected_background.png")

    context = await freezone_presets.build_beat_preset_context(
        project_id="proj_demo",
        username="admin",
        project="demo",
        project_dir=tmp_path,
        store=_FakeBeatWorkbenchStore(),
        episode=1,
        beat=2,
        primary_slot="render",
    )

    refs = context["refs"]
    identity_refs = [ref for ref in refs if ref["kind"] == "identity"]
    scene_refs = [ref for ref in refs if ref["kind"] == "scene"]
    selected_background_refs = [ref for ref in refs if ref["role"] == "selected_background"]
    roles = [ref["role"] for ref in refs]

    assert [
        (ref["role"], ref["meta"].get("identity_id"), ref["meta"].get("character"))
        for ref in identity_refs
    ] == [("character_identity", "ChenMo_young_adult", "ChenMo")]
    # Beat canvas should not project scene assets as nodes. The background
    # source picker on the set-selected-background SkillNode owns master /
    # reverse / 360 / 3GS source selection.
    assert scene_refs == []
    assert "scene_master" not in roles
    assert "scene_reverse_master" not in roles
    assert "scene_360" not in roles
    assert "character_portrait" not in roles
    assert "character_reference" not in roles
    assert "director_combined" in roles
    assert [
        (ref["role"], ref["label"], ref["meta"].get("beat")) for ref in selected_background_refs
    ] == [("selected_background", "Current background · Beat 2", 2)]


@pytest.mark.asyncio
async def test_beat_preset_current_sketch_ignores_pool_fallback(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    from novelvideo.utils import state_index_files

    monkeypatch.setattr(state_index_files, "OUTPUT_DIR", str(tmp_path))
    monkeypatch.setattr(state_index_files, "STATE_DIR", str(tmp_path / "state"))
    pool_cell = tmp_path / "grids/ep001/sketch/beat_02_t20260101010101.png"
    _write_fake_image(pool_cell)
    (tmp_path / "grids/ep001/pool_index.json").write_text(
        json.dumps(
            {
                "episode": 1,
                "generated_at": "2026-01-01T00:00:00",
                "version": 2,
                "modes": {},
                "grids": [],
                "images": [
                    {
                        "id": "sketch_beat_02_t20260101010101",
                        "mode": "sketch",
                        "grid_index": 0,
                        "cell_index": 0,
                        "grid_path": "",
                        "cell_path": "sketch/beat_02_t20260101010101.png",
                        "row": 0,
                        "col": 0,
                        "original_beat": 2,
                        "generated_at": "2026-01-01T00:00:00",
                        "type": "sketch",
                    }
                ],
                "beat_assignments": {},
            }
        ),
        encoding="utf-8",
    )

    context = await freezone_presets.build_beat_preset_context(
        project_id="proj_demo",
        username="admin",
        project="demo",
        project_dir=tmp_path,
        store=_FakeBeatWorkbenchStore(),
        episode=1,
        beat=2,
        primary_slot="sketch",
    )

    current_sketch_refs = [ref for ref in context["refs"] if ref["role"] == "current_sketch"]
    assert current_sketch_refs == []
    assert all("grids/ep001/sketch" not in str(ref.get("rel_path")) for ref in context["refs"])


@pytest.mark.asyncio
async def test_beat_preset_falls_back_to_scene_master_for_missing_selected_background(
    tmp_path: Path,
) -> None:
    _write_fake_image(tmp_path / "assets/scenes/compound/master.png")
    _write_fake_image(tmp_path / "sketches/ep001/beat_02.png")

    context = await freezone_presets.build_beat_preset_context(
        project_id="proj_demo",
        username="admin",
        project="demo",
        project_dir=tmp_path,
        store=_FakeBeatWorkbenchStore(),
        episode=1,
        beat=2,
        primary_slot="sketch",
    )

    selected_background = next(
        ref for ref in context["refs"] if ref["role"] == "selected_background"
    )
    assert selected_background["rel_path"] == (
        "director_control_frames/ep001/beat_02/selected_background.png"
    )
    assert selected_background["exists"] is True
    assert "assets/scenes/compound/master.png" in selected_background["url"]
    assert selected_background["meta"]["fallback_source"] == "scene_master"
    assert selected_background["meta"]["fallback_rel_path"] == "assets/scenes/compound/master.png"

    payload = build_canvas_payload_from_context(
        context=context,
        preset_key="beat:ep001:beat002:sketch",
        default_push_target={"kind": "sketch", "episode": 1, "beat": 2},
    )
    nodes = {node["id"]: node for node in payload["nodes"]}
    background_node = nodes["ref_selected_background_1"]
    assert background_node["data"]["imageUrl"] == selected_background["url"]
    assert background_node["data"]["slot_target"] == {
        "kind": "selected_background",
        "episode": 1,
        "beat": 2,
    }


def test_beat_preset_includes_refs_as_workflow_nodes() -> None:
    context = {
        "scope": "beat",
        "episode": 1,
        "beat": 2,
        "primary_slot": "render",
        "beat_data": {
            "beat_number": 2,
            "visual_description": "ChenMo picks up [[resident_rules]] and stands at the compound gate.",
            "keyframe_prompt": "Keep the characters and props clear",
            "scene_ref": {"scene_id": "compound"},
        },
        "prop_menu": [{"prop_id": "resident_rules"}],
        "refs": [
            {
                "kind": "sketch",
                "role": "current_sketch",
                "label": "current sketch",
                "rel_path": "sketches/ep001/beat_02.png",
                "url": "/static/admin/demo/sketches/ep001/beat_02.png",
                "exists": True,
                "aspect_ratio": "16:9",
                "meta": {"episode": 1, "beat": 2},
            },
            {
                "kind": "render",
                "role": "current_frame",
                "label": "current render",
                "rel_path": "renders/ep001/beat_02.png",
                "url": "/static/admin/demo/renders/ep001/beat_02.png",
                "exists": True,
                "aspect_ratio": "16:9",
                "meta": {"episode": 1, "beat": 2},
            },
            {
                "kind": "identity",
                "role": "character_identity",
                "label": "ChenMo_young_adult",
                "rel_path": "assets/characters/ChenMo/identities/young_adult.png",
                "url": "/static/admin/demo/assets/characters/ChenMo/identities/young_adult.png",
                "exists": True,
                "aspect_ratio": "1:1",
                "meta": {"character": "ChenMo", "identity_id": "ChenMo_young_adult"},
            },
            {
                "kind": "prop",
                "role": "prop_reference",
                "label": "resident_rules",
                "rel_path": "assets/props/resident_rules/reference_3view.png",
                "url": "/static/admin/demo/assets/props/resident_rules/reference_3view.png",
                "exists": True,
                "aspect_ratio": "1:1",
                "meta": {"prop_id": "resident_rules"},
            },
            {
                "kind": "scene",
                "role": "scene_master",
                "label": "compound master",
                "rel_path": "assets/scenes/compound/master.png",
                "url": "/static/admin/demo/assets/scenes/compound/master.png",
                "exists": True,
                "aspect_ratio": "16:9",
                "meta": {"scene_id": "compound"},
            },
            {
                "kind": "scene",
                "role": "director_combined",
                "label": "3GS director composite",
                "rel_path": "freezone/director_control_frames/ep001/beat_02/combined.png",
                "url": "/static/admin/demo/freezone/director_control_frames/ep001/beat_02/combined.png",
                "exists": True,
                "aspect_ratio": "16:9",
                "meta": {"episode": 1, "beat": 2},
            },
            {
                "kind": "director",
                "role": "selected_background",
                "label": "selected background",
                "rel_path": "freezone/director_control_frames/ep001/beat_02/selected_background.png",
                "url": "/static/admin/demo/freezone/director_control_frames/ep001/beat_02/selected_background.png",
                "exists": True,
                "aspect_ratio": "16:9",
                "meta": {"episode": 1, "beat": 2},
            },
        ],
    }

    payload = build_canvas_payload_from_context(
        context=context,
        preset_key="beat:ep001:beat002:render",
        default_push_target={"kind": "director_render", "episode": 1, "beat": 2},
    )
    nodes = {node["id"]: node for node in payload["nodes"]}
    edges = {(edge["source"], edge["target"]) for edge in payload["edges"]}
    edge_by_pair = {(edge["source"], edge["target"]): edge for edge in payload["edges"]}

    assert "prompt_beat_visual" in nodes
    assert "Colorize this" in nodes["prompt_beat_visual"]["data"]["content"]
    assert "context_beat" in nodes
    assert nodes["context_beat"]["type"] == "beatContextNode"
    assert nodes["context_beat"]["measured"] == {"width": 420, "height": 560}
    assert nodes["context_beat"]["data"]["displayName"] == "EP1 / Beat 2 / render"
    assert nodes["context_beat"]["data"]["content"] == "ChenMo picks up [[resident_rules]] and stands at the compound gate."
    assert "Episode:" not in nodes["context_beat"]["data"]["content"]
    assert "Video Prompt" not in nodes["context_beat"]["data"]["content"]
    assert nodes["context_beat"]["data"]["mainline_context"][0]["kind"] == "beat"
    assert nodes["context_beat"]["data"]["mainline_context"][0]["episode"] == 1
    assert nodes["context_beat"]["data"]["mainline_context"][0]["beat"] == 2
    assert "ChenMo picks up [[resident_rules]]" in nodes["context_beat"]["data"]["snapshot"]["visualDescription"]
    assert "ref_current_frame_1" in nodes
    assert "ref_character_identity_1" in nodes
    assert "ref_prop_reference_1" in nodes
    assert not any(node_id.startswith("ref_scene_") for node_id in nodes)
    assert "ref_director_combined_1" in nodes
    assert "ref_selected_background_1" in nodes
    assert nodes["ref_selected_background_1"]["data"]["slot_target"] == {
        "kind": "selected_background",
        "episode": 1,
        "beat": 2,
    }
    # Skill Hub cleanup: legacy workflow trigger nodes and embedded
    # mainline_slot panels are gone. Canonical source nodes keep slot metadata,
    # but executable dependencies go through SkillNode edges.
    assert "workflow_selected_background_to_sketch" not in nodes
    assert "workflow_director_combined_to_sketch" not in nodes
    assert "workflow_background_sketch_to_frame" not in nodes
    frame_data = nodes["ref_current_frame_1"]["data"]
    assert frame_data["preset_managed"] is True
    assert frame_data["slot_target"] == {"kind": "frame", "episode": 1, "beat": 2}
    assert "workflow_kind" not in frame_data
    assert "typed_backend_action" not in frame_data
    assert "default_push_target" not in payload["metadata"]
    assert payload["metadata"]["workbench"] == {"kind": "beat", "primary_slot": "render"}
    assert nodes["ref_character_identity_1"]["type"] == "imageGenNode"
    assert nodes["ref_prop_reference_1"]["type"] == "imageGenNode"
    assert nodes["ref_current_frame_1"]["data"]["mainline_context"][0]["kind"] == "frame"
    assert not any(
        ctx.get("kind") == "beat"
        for ctx in nodes["ref_current_frame_1"]["data"]["mainline_context"]
    )
    assert nodes["ref_character_identity_1"]["data"]["mainline_context"][0]["kind"] == "identity"
    assert ("context_beat", "prompt_beat_visual") in edges
    role_edges = {
        (edge["source"], edge["target"], (edge.get("data") or {}).get("role"))
        for edge in payload["edges"]
        if (edge.get("data") or {}).get("edgeKind") == "role_binding"
    }
    assert ("context_beat", "skill_frame_from_context", "beat_context") in role_edges
    assert ("ref_current_sketch_1", "skill_frame_from_context", "sketch") in role_edges
    assert ("ref_selected_background_1", "skill_frame_from_context", "background") in role_edges
    assert ("ref_character_identity_1", "skill_frame_from_context", "identity") not in role_edges
    assert ("ref_prop_reference_1", "skill_frame_from_context", "prop") not in role_edges
    assert ("skill_frame_from_context", "ref_current_frame_1") in edges
    assert ("prompt_beat_visual", "ref_current_frame_1") not in edges
    assert ("ref_current_sketch_1", "ref_current_frame_1") not in edges
    frame_output_edge = edge_by_pair[("skill_frame_from_context", "ref_current_frame_1")]
    assert frame_output_edge["sourceHandle"] == "current_frame_candidate"
    assert frame_output_edge["data"]["role"] == "current_frame_candidate"


def test_freezone_preset_maps_unknown_image_ratios_to_supported_generation_ratios() -> None:
    assert _nearest_supported_image_aspect_ratio("17:25") == "2:3"
    assert _nearest_supported_image_aspect_ratio("75:112") == "2:3"
    assert _nearest_supported_image_aspect_ratio("56:75") == "3:4"
    assert _nearest_supported_image_aspect_ratio("43:24") == "16:9"


def test_project_sketch_aspect_ratio_uses_episode_config_and_supported_fallback() -> None:
    assert (
        _project_sketch_aspect_ratio(
            {"sketch_aspect_ratio_by_episode": {"1": "16:9"}},
            1,
        )
        == "16:9"
    )
    assert (
        _project_sketch_aspect_ratio(
            {"sketch_aspect_ratio_by_episode": {"1": "17:25"}},
            1,
        )
        == "2:3"
    )
    assert _project_sketch_aspect_ratio({}, 1) == "2:3"


def test_beat_context_asset_omits_beat_director_control_frames() -> None:
    director_combined = _beat_context_asset_from_ref(
        ref={
            "kind": "director",
            "role": "director_combined",
            "label": "Director composite image",
            "rel_path": "freezone/director_control_frames/ep001/beat_03/combined.png",
            "url": "/static/admin/demo/freezone/director_control_frames/ep001/beat_03/combined.png",
            "exists": True,
            "media_type": "image",
            "aspect_ratio": "16:9",
        },
        project_id="proj_1",
        episode=1,
        beat=3,
    )
    assert director_combined is not None
    assert director_combined["role"] == "director_combined"
    assert director_combined["director_control_bundle"]["rel_paths"] == {
        "combined": "freezone/director_control_frames/ep001/beat_03/combined.png",
        "env_only": "freezone/director_control_frames/ep001/beat_03/env_only.png",
        "frame_meta": "freezone/director_control_frames/ep001/beat_03/frame_meta.json",
    }

    selected_background = _beat_context_asset_from_ref(
        ref={
            "kind": "director",
            "role": "selected_background",
            "label": "selected background",
            "rel_path": "freezone/director_control_frames/ep001/beat_03/selected_background.png",
            "url": "/static/admin/demo/freezone/director_control_frames/ep001/beat_03/selected_background.png",
            "exists": True,
            "media_type": "image",
            "aspect_ratio": "16:9",
        },
        project_id="proj_1",
        episode=1,
        beat=3,
    )
    assert selected_background is not None
    assert selected_background["role"] == "selected_background"
    assert selected_background["mainline_context"][0]["kind"] == "selected_background"

    asset = _beat_context_asset_from_ref(
        ref={
            "kind": "director",
            "role": "director_env",
            "label": "3GS environment plate",
            "rel_path": "freezone/director_control_frames/ep001/beat_03/env_only.png",
            "url": "/static/admin/demo/freezone/director_control_frames/ep001/beat_03/env_only.png",
            "exists": True,
        },
        project_id="proj_1",
        episode=1,
        beat=3,
    )
    assert asset is None


def test_beat_context_asset_omits_director_blocking_json() -> None:
    ref = {
        "kind": "director",
        "role": "director_blocking",
        "label": "director blocking state",
        "rel_path": "director_blockings/ep001/beat_06.json",
        "url": "/static/admin/demo/director_blockings/ep001/beat_06.json",
        "exists": True,
        "media_type": "file",
    }

    assert _beat_context_asset_from_ref(ref=ref, project_id="proj_1", episode=1, beat=6) is None
    assert _is_asset_library_reference(ref) is False


def test_asset_library_reference_omits_director_json_metadata() -> None:
    assert (
        _is_asset_library_reference(
            {
                "kind": "director",
                "role": "director_view",
                "rel_path": "assets/director_refs/ep001/beat_06/director_view.json",
                "url": "/static/admin/demo/assets/director_refs/ep001/beat_06/director_view.json",
                "exists": True,
            }
        )
        is False
    )


def test_beat_frame_preset_uses_readable_backend_layout(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    def _fake_render_prompt(render_context: dict) -> str:
        render_context["_freezone_render_reference_paths"] = [
            str(tmp_path / "assets/characters/ChenMo/portrait.png"),
            str(
                tmp_path / "freezone/director_control_frames/ep001/beat_03/selected_background.png"
            ),
        ]
        return "render prompt"

    monkeypatch.setattr(freezone_presets, "_beat_render_prompt", _fake_render_prompt)
    context = {
        "scope": "beat",
        "project_dir": str(tmp_path),
        "episode": 1,
        "beat": 3,
        "primary_slot": "frame",
        "sketch_aspect_ratio": "2:3",
        "beat_data": {
            "beat_number": 3,
            "visual_description": "{{ChenMo_young_adult}} looks down at [[resident_rules]].",
            "keyframe_prompt": "",
            "scene_ref": {"scene_id": "bldg3_7f_corridor"},
            "detected_identities": ["ChenMo_young_adult"],
            "detected_props": ["resident_rules"],
        },
        "refs": [
            {
                "kind": "sketch",
                "role": "current_sketch",
                "label": "current sketch",
                "rel_path": "sketches/ep001/beat_03.png",
                "url": "/static/admin/demo/sketches/ep001/beat_03.png",
                "exists": True,
                "aspect_ratio": "17:25",
                "meta": {"episode": 1, "beat": 3, "primary_slot": "frame"},
            },
            {
                "kind": "frame",
                "role": "current_frame",
                "label": "current frame",
                "rel_path": "frames/ep001/beat_03.png",
                "url": "/static/admin/demo/frames/ep001/beat_03.png",
                "exists": True,
                "aspect_ratio": "75:112",
                "meta": {"episode": 1, "beat": 3, "primary_slot": "frame"},
            },
            {
                "kind": "identity",
                "role": "character_portrait",
                "label": "ChenMo portrait",
                "rel_path": "assets/characters/ChenMo/portrait.png",
                "url": "/static/admin/demo/assets/characters/ChenMo/portrait.png",
                "exists": True,
                "aspect_ratio": "56:75",
                "meta": {"character": "ChenMo"},
            },
            {
                "kind": "prop",
                "role": "prop_reference",
                "label": "resident_rules",
                "rel_path": "assets/props/resident_rules/reference_3view.png",
                "url": "/static/admin/demo/assets/props/resident_rules/reference_3view.png",
                "exists": True,
                "aspect_ratio": "43:24",
                "meta": {"prop_id": "resident_rules"},
            },
            {
                "kind": "scene",
                "role": "scene_master",
                "label": "bldg3_7f_corridor master",
                "rel_path": "assets/scenes/bldg3_7f_corridor/master.png",
                "url": "/static/admin/demo/assets/scenes/bldg3_7f_corridor/master.png",
                "exists": True,
                "aspect_ratio": "16:9",
                "meta": {"scene_id": "bldg3_7f_corridor"},
            },
            {
                "kind": "scene",
                "role": "scene_reverse_master",
                "label": "bldg3_7f_corridor reverse master",
                "rel_path": "assets/scenes/bldg3_7f_corridor/reverse_master.png",
                "url": "/static/admin/demo/assets/scenes/bldg3_7f_corridor/reverse_master.png",
                "exists": True,
                "aspect_ratio": "16:9",
                "meta": {"scene_id": "bldg3_7f_corridor"},
            },
            {
                "kind": "scene",
                "role": "scene_3gs_active_ply",
                "label": "3GS active",
                "rel_path": "director_worlds/bldg3_7f_corridor/v1/master_sharp.ply",
                "url": "/static/admin/demo/director_worlds/bldg3_7f_corridor/v1/master_sharp.ply",
                "exists": True,
                "media_type": "file",
                "aspect_ratio": "1:1",
                "meta": {"scene_id": "bldg3_7f_corridor", "ply_kind": "active"},
            },
            {
                "kind": "director",
                "role": "director_combined",
                "label": "3GS director composite",
                "rel_path": "freezone/director_control_frames/ep001/beat_03/combined.png",
                "url": "/static/admin/demo/freezone/director_control_frames/ep001/beat_03/combined.png",
                "exists": True,
                "aspect_ratio": "16:9",
                "meta": {"episode": 1, "beat": 3},
            },
            {
                "kind": "director",
                "role": "selected_background",
                "label": "selected background",
                "rel_path": "freezone/director_control_frames/ep001/beat_03/selected_background.png",
                "url": "/static/admin/demo/freezone/director_control_frames/ep001/beat_03/selected_background.png",
                "exists": True,
                "aspect_ratio": "16:9",
                "meta": {"episode": 1, "beat": 3},
            },
            {
                "kind": "director",
                "role": "director_env",
                "label": "3GS environment plate",
                "rel_path": "freezone/director_control_frames/ep001/beat_03/env_only.png",
                "url": "/static/admin/demo/freezone/director_control_frames/ep001/beat_03/env_only.png",
                "exists": True,
                "aspect_ratio": "16:9",
                "meta": {"episode": 1, "beat": 3},
            },
            {
                "kind": "director",
                "role": "actor_mask",
                "label": "actor mask",
                "rel_path": "freezone/director_control_frames/ep001/beat_03/actor_mask.png",
                "url": "/static/admin/demo/freezone/director_control_frames/ep001/beat_03/actor_mask.png",
                "exists": True,
                "aspect_ratio": "1:1",
                "meta": {"episode": 1, "beat": 3},
            },
            {
                "kind": "sketch",
                "role": "sketch_candidate",
                "label": "beat_03_t1",
                "rel_path": "grids/ep001/sketch/beat_03_t1.png",
                "url": "/static/admin/demo/grids/ep001/sketch/beat_03_t1.png",
                "exists": True,
                "aspect_ratio": "17:26",
                "meta": {"episode": 1, "beat": 3},
            },
        ],
    }

    payload = build_canvas_payload_from_context(
        context=context,
        preset_key="beat:ep001:beat003:frame",
        default_push_target={"kind": "frame", "episode": 1, "beat": 3},
    )
    nodes = {node["id"]: node for node in payload["nodes"]}
    edges = {(edge["source"], edge["target"]) for edge in payload["edges"]}

    assert "director_capture" not in nodes
    assert payload["metadata"]["director_capture"] == {
        "episode": 1,
        "beat": 3,
        "scene_id": "bldg3_7f_corridor",
        "node_id": "director_capture",
    }
    assert nodes["context_beat"]["position"] == {"x": -1840, "y": -720}
    assert nodes["prompt_beat_visual"]["position"] == {"x": -1840, "y": -260}
    assert nodes["ref_current_sketch_1"]["position"] == {"x": 520, "y": -700}
    assert nodes["ref_current_frame_1"]["position"] == {"x": 1680, "y": 260}
    assert nodes["ref_character_portrait_1"]["position"] == {"x": -1500, "y": 420}
    assert nodes["ref_prop_reference_1"]["position"] == {"x": -1080, "y": 1040}
    assert not any(node_id.startswith("ref_scene_") for node_id in nodes)
    assert nodes["ref_selected_background_1"]["type"] == "imageGenNode"
    assert nodes["ref_director_combined_1"]["type"] == "imageGenNode"
    assert nodes["ref_director_env_1"]["type"] == "imageGenNode"
    assert nodes["ref_actor_mask_1"]["type"] == "imageGenNode"
    assert nodes["ref_selected_background_1"]["position"] == {"x": -1080, "y": -1040}
    assert nodes["ref_director_combined_1"]["position"] == {"x": -1080, "y": -360}
    assert nodes["ref_director_env_1"]["position"] == {"x": -1500, "y": 1560}
    assert nodes["ref_actor_mask_1"]["position"] == {"x": -1060, "y": 1940}
    assert nodes["ref_sketch_candidate_1"]["position"] == {"x": 520, "y": 1040}
    assert nodes["skill_set_selected_background"]["position"] == {"x": -1560, "y": -1240}
    assert nodes["skill_set_director_combined"]["position"] == {"x": -1560, "y": -620}
    assert nodes["skill_sketch_from_background"]["position"] == {"x": -360, "y": -1040}
    assert nodes["skill_sketch_from_director_combined"]["position"] == {"x": -360, "y": -360}
    assert nodes["skill_frame_from_context"]["position"] == {"x": 1020, "y": 260}
    assert not any(node_id.startswith("prompt_scene_") for node_id in nodes)
    assert nodes["ref_current_frame_1"]["data"]["aspectRatio"] == "2:3"
    assert nodes["ref_current_frame_1"]["data"]["actualAspectRatio"] == "75:112"
    assert nodes["context_beat"]["data"]["beat_edit_fields"] == {
        "visual_description": "{{ChenMo_young_adult}} looks down at [[resident_rules]].",
        "scene_id": "bldg3_7f_corridor",
        "time_of_day": "",
        "detected_identities": ["ChenMo_young_adult"],
        "detected_props": ["resident_rules"],
    }
    role_edges = {
        (edge["source"], edge["target"], (edge.get("data") or {}).get("role"))
        for edge in payload["edges"]
        if (edge.get("data") or {}).get("edgeKind") == "role_binding"
    }
    assert ("context_beat", "skill_frame_from_context", "beat_context") in role_edges
    assert ("ref_selected_background_1", "skill_frame_from_context", "background") in role_edges
    assert ("ref_director_env_1", "context_beat") not in edges
    slot_target = "ref_current_frame_1"
    slot_inputs = {edge["source"] for edge in payload["edges"] if edge["target"] == slot_target}
    assert slot_inputs == {"skill_frame_from_context"}
    assert (
        nodes["ref_current_sketch_1"]["position"]["x"]
        > nodes["skill_sketch_from_background"]["position"]["x"]
    )
    assert (
        nodes["ref_current_sketch_1"]["position"]["x"]
        > nodes["skill_sketch_from_director_combined"]["position"]["x"]
    )
    assert (
        nodes["ref_current_sketch_1"]["position"]["x"]
        < nodes["skill_frame_from_context"]["position"]["x"]
    )
    assert (
        nodes["ref_current_frame_1"]["position"]["x"]
        > nodes["skill_frame_from_context"]["position"]["x"]
    )
    reference_paths = {
        ref.get("rel_path") for ref in payload["metadata"]["references"] if ref.get("rel_path")
    }
    assert (
        "freezone/director_control_frames/ep001/beat_03/selected_background.png"
        not in reference_paths
    )
    assert "freezone/director_control_frames/ep001/beat_03/env_only.png" not in reference_paths
    assert "freezone/director_control_frames/ep001/beat_03/combined.png" not in reference_paths


def test_beat_sketch_preset_uses_current_sketch_as_primary() -> None:
    context = {
        "scope": "beat",
        "episode": 1,
        "beat": 1,
        "primary_slot": "sketch",
        "beat_data": {
            "beat_number": 1,
            "visual_description": "Black-screen title card",
            "keyframe_prompt": "",
            "scene_ref": None,
        },
        "refs": [
            {
                "kind": "frame",
                "role": "current_frame",
                "label": "current frame",
                "rel_path": "frames/ep001/beat_01.png",
                "url": "/static/admin/demo/frames/ep001/beat_01.png",
                "exists": True,
                "aspect_ratio": "2:3",
                "meta": {"episode": 1, "beat": 1},
            },
            {
                "kind": "sketch",
                "role": "current_sketch",
                "label": "current sketch",
                "rel_path": "sketches/ep001/beat_01.png",
                "url": "/static/admin/demo/sketches/ep001/beat_01.png",
                "exists": True,
                "aspect_ratio": "2:3",
                "meta": {"episode": 1, "beat": 1},
            },
            {
                "kind": "director",
                "role": "selected_background",
                "label": "selected background",
                "rel_path": "freezone/director_control_frames/ep001/beat_01/selected_background.png",
                "url": "/static/admin/demo/freezone/director_control_frames/ep001/beat_01/selected_background.png",
                "exists": True,
                "aspect_ratio": "2:3",
                "meta": {"episode": 1, "beat": 1},
            },
        ],
    }

    payload = build_canvas_payload_from_context(
        context=context,
        preset_key="beat:ep001:beat001:sketch",
        default_push_target={"kind": "sketch", "episode": 1, "beat": 1},
    )
    nodes = {node["id"]: node for node in payload["nodes"]}
    edges = {(edge["source"], edge["target"]) for edge in payload["edges"]}

    assert "skill_frame_from_context" not in nodes
    assert ("skill_sketch_from_background", "ref_current_sketch_1") in edges
    assert ("skill_sketch_from_director_combined", "ref_current_sketch_1") in edges
    assert ("prompt_beat_visual", "ref_current_sketch_1") not in edges
    assert "default_push_target" not in payload["metadata"]
    assert payload["metadata"]["workbench"] == {"kind": "beat", "primary_slot": "sketch"}


def test_beat_sketch_preset_uses_marker_prompt_not_image_refs() -> None:
    context = {
        "scope": "beat",
        "episode": 1,
        "beat": 3,
        "primary_slot": "sketch",
        "beat_data": {
            "beat_number": 3,
            "visual_description": "{{ChenMo_young_adult}} holds a stack of [[resident_rules]].",
            "keyframe_prompt": "",
            "scene_ref": None,
            "detected_identities": [],
            "detected_props": [],
        },
        "prop_menu": [
            {
                "prop_id": "resident_rules",
                "prop_type": "document",
                "visual_prompt": "A sheet of white A4 printer paper",
            }
        ],
        "sketch_context": {
            "sketch_colors": {"ChenMo_young_adult": "#00FFFF FLUORESCENT CYAN"},
            "characters": {
                "ChenMo": {
                    "name": "ChenMo",
                    "gender": "male",
                    "body_type": "Average build",
                    "identities": [
                        {
                            "identity_id": "ChenMo_young_adult",
                            "identity_name": "young_adult",
                            "appearance_details": "Dark gray hoodie",
                        }
                    ],
                }
            },
        },
        "refs": [
            {
                "kind": "sketch",
                "role": "current_sketch",
                "label": "current sketch",
                "rel_path": "sketches/ep001/beat_03.png",
                "url": "/static/admin/demo/sketches/ep001/beat_03.png",
                "exists": True,
                "aspect_ratio": "2:3",
                "meta": {"episode": 1, "beat": 3},
            },
            {
                "kind": "identity",
                "role": "character_identity",
                "label": "ChenMo_young_adult",
                "rel_path": "assets/characters/ChenMo/identities/young_adult.png",
                "url": "/static/admin/demo/assets/characters/ChenMo/identities/young_adult.png",
                "exists": True,
                "aspect_ratio": "1:1",
                "meta": {"character": "ChenMo", "identity_id": "ChenMo_young_adult"},
            },
            {
                "kind": "identity",
                "role": "character_portrait",
                "label": "ChenMo portrait",
                "rel_path": "assets/characters/ChenMo/portrait.png",
                "url": "/static/admin/demo/assets/characters/ChenMo/portrait.png",
                "exists": True,
                "aspect_ratio": "1:1",
                "meta": {"character": "ChenMo"},
            },
            {
                "kind": "prop",
                "role": "prop_reference",
                "label": "resident_rules",
                "rel_path": "assets/props/resident_rules/reference_3view.png",
                "url": "/static/admin/demo/assets/props/resident_rules/reference_3view.png",
                "exists": True,
                "aspect_ratio": "1:1",
                "meta": {"prop_id": "resident_rules"},
            },
            {
                "kind": "scene",
                "role": "scene_director_pano_360",
                "label": "compound director pano 360",
                "rel_path": "director_worlds/compound/v1/pano_360.png",
                "url": "/static/admin/demo/director_worlds/compound/v1/pano_360.png",
                "exists": True,
                "aspect_ratio": "2:1",
                "meta": {
                    "scene_id": "compound",
                    "environment_prompt": "Compound courtyard, white buildings, lush greenery",
                },
            },
            {
                "kind": "director",
                "role": "scene_3gs_pano_ply",
                "label": "compound 3D world (360)",
                "rel_path": "director_worlds/compound/v1/pano_sharp_merged.ply",
                "url": "/static/admin/demo/director_worlds/compound/v1/pano_sharp_merged.ply",
                "exists": True,
                "media_type": "file",
                "aspect_ratio": "1:1",
                "meta": {"scene_id": "compound", "ply_kind": "pano"},
            },
            {
                "kind": "director",
                "role": "selected_background",
                "label": "selected background",
                "rel_path": "freezone/director_control_frames/ep001/beat_03/selected_background.png",
                "url": "/static/admin/demo/freezone/director_control_frames/ep001/beat_03/selected_background.png",
                "exists": True,
                "aspect_ratio": "2:3",
                "meta": {"episode": 1, "beat": 3},
            },
        ],
    }

    payload = build_canvas_payload_from_context(
        context=context,
        preset_key="beat:ep001:beat003:sketch",
        default_push_target={"kind": "sketch", "episode": 1, "beat": 3},
    )
    nodes = {node["id"]: node for node in payload["nodes"]}
    edges = {(edge["source"], edge["target"]) for edge in payload["edges"]}
    sketch_prompt = nodes["prompt_beat_visual"]["data"]["content"]

    assert ("sketch_marker_context", "prompt_beat_visual") in edges
    assert ("skill_sketch_from_background", "ref_current_sketch_1") in edges
    assert ("skill_sketch_from_director_combined", "ref_current_sketch_1") in edges
    assert ("prompt_beat_visual", "ref_current_sketch_1") not in edges
    assert "ref_current_frame_1" not in nodes
    assert "workflow_selected_background_to_sketch" not in nodes
    assert "workflow_background_sketch_to_frame" not in nodes
    sketch_data = nodes["ref_current_sketch_1"]["data"]
    assert sketch_data["preset_managed"] is True
    assert sketch_data["slot_target"] == {"kind": "sketch", "episode": 1, "beat": 3}
    assert "workflow_kind" not in sketch_data
    assert "typed_backend_action" not in sketch_data
    assert nodes["ref_character_identity_1"]["type"] == "imageGenNode"
    assert nodes["ref_character_portrait_1"]["type"] == "imageGenNode"
    assert nodes["ref_prop_reference_1"]["type"] == "imageGenNode"
    assert "ref_scene_director_pano_360_1" not in nodes
    assert "ref_scene_3gs_pano_ply_1" not in nodes
    assert not any(node_id.startswith("prompt_scene_") for node_id in nodes)
    assert ("ref_character_identity_1", "ref_current_sketch_1") not in edges
    assert ("ref_character_portrait_1", "ref_current_sketch_1") not in edges
    assert ("ref_prop_reference_1", "ref_current_sketch_1") not in edges
    assert "REFERENCE IMAGES: none" in sketch_prompt
    assert "reference_images: []" in nodes["sketch_marker_context"]["data"]["content"]
    assert "FLUORESCENT CYAN (#00FFFF)" in sketch_prompt
    assert "resident_rules" in sketch_prompt
    assert "{{ChenMo_young_adult}}" not in sketch_prompt
    assert "[[" not in sketch_prompt


def test_beat_preset_detected_refs_edge_into_frame_workflow() -> None:
    """Phase 5: the beat's detected_identities / detected_props must have explicit propagating
    edges into ref_current_frame_1 (replacing the old workflow_background_sketch_to_frame),
    consistent with the image set the backend `_collect_mainline_typed_reference_urls` actually takes --
    the lines seen on the canvas = the image refs the render slot will actually use.
    """
    context = {
        "scope": "beat",
        "episode": 1,
        "beat": 5,
        "primary_slot": "render",
        "beat_data": {
            "beat_number": 5,
            "visual_description": "ChenMo picks up [[resident_rules]] and walks to the desk.",
            "detected_identities": ["ChenMo_young_adult"],
            "detected_props": ["resident_rules"],
        },
        "refs": [
            {
                "kind": "sketch",
                "role": "current_sketch",
                "rel_path": "sketches/ep001/beat_05.png",
                "url": "/static/admin/demo/sketches/ep001/beat_05.png",
                "exists": True,
                "aspect_ratio": "2:3",
                "meta": {"episode": 1, "beat": 5},
            },
            {
                "kind": "director",
                "role": "selected_background",
                "rel_path": "freezone/director_control_frames/ep001/beat_05/selected_background.png",
                "url": "/static/admin/demo/freezone/director_control_frames/ep001/beat_05/selected_background.png",
                "exists": True,
                "aspect_ratio": "16:9",
                "meta": {"episode": 1, "beat": 5},
            },
            {
                "kind": "identity",
                "role": "character_identity",
                "label": "ChenMo_young_adult",
                "rel_path": "assets/characters/ChenMo/identities/young_adult.png",
                "url": "/static/admin/demo/assets/characters/ChenMo/identities/young_adult.png",
                "exists": True,
                "aspect_ratio": "1:1",
                "meta": {"character": "ChenMo", "identity_id": "ChenMo_young_adult"},
            },
            {
                "kind": "prop",
                "role": "prop_reference",
                "label": "resident_rules",
                "rel_path": "assets/props/resident_rules/reference_3view.png",
                "url": "/static/admin/demo/assets/props/resident_rules/reference_3view.png",
                "exists": True,
                "aspect_ratio": "1:1",
                "meta": {"prop_id": "resident_rules"},
            },
        ],
    }
    payload = build_canvas_payload_from_context(
        context=context,
        preset_key="beat:ep001:beat005:render",
        default_push_target={"kind": "frame", "episode": 1, "beat": 5},
    )
    edges = {(edge["source"], edge["target"]) for edge in payload["edges"]}
    assert ("ref_character_identity_1", "skill_frame_from_context") in edges
    assert ("ref_prop_reference_1", "skill_frame_from_context") in edges
    assert ("skill_frame_from_context", "ref_current_frame_1") in edges
    assert ("ref_character_identity_1", "ref_current_frame_1") not in edges
    assert ("ref_prop_reference_1", "ref_current_frame_1") not in edges


def test_beat_preset_selected_background_placeholder_when_file_missing() -> None:
    """When the selected_background file does not exist, the beat workbench must still emit a
    placeholder ref (url=None), so there is a placeholder node on the canvas -- otherwise the user cannot see
    the background slot at all and does not know where to commit the selected background image.
    """
    context = {
        "scope": "beat",
        "episode": 1,
        "beat": 7,
        "primary_slot": "render",
        "beat_data": {"beat_number": 7, "visual_description": "Black screen"},
        "refs": [
            # No selected_background ref! Simulates the file not having been generated yet.
            {
                "kind": "director",
                "role": "selected_background",
                "rel_path": "freezone/director_control_frames/ep001/beat_07/selected_background.png",
                "url": None,
                "exists": False,
                "aspect_ratio": "16:9",
                "meta": {"episode": 1, "beat": 7},
            },
        ],
    }
    payload = build_canvas_payload_from_context(
        context=context,
        preset_key="beat:ep001:beat007:render",
        default_push_target={"kind": "frame", "episode": 1, "beat": 7},
    )
    nodes = {node["id"]: node for node in payload["nodes"]}
    assert (
        "ref_selected_background_1" in nodes
    ), "Even when the file is missing, a selected_background placeholder node must be given, so the user knows where to commit"
    # The placeholder node is an imageGenNode (an empty generation box when there is no url); only when a file exists is it an imageNode/asset.
    assert nodes["ref_selected_background_1"]["type"] == "imageGenNode"
    assert nodes["ref_selected_background_1"]["data"]["slot_target"] == {
        "kind": "selected_background",
        "episode": 1,
        "beat": 7,
    }


def test_beat_render_preset_emits_missing_sketch_and_frame_placeholders() -> None:
    context = {
        "scope": "beat",
        "episode": 1,
        "beat": 9,
        "primary_slot": "render",
        "beat_data": {"beat_number": 9, "visual_description": "ChenMo pushes open the door."},
        "refs": [],
    }

    payload = build_canvas_payload_from_context(
        context=context,
        preset_key="beat:ep001:beat009:render",
        default_push_target={"kind": "frame", "episode": 1, "beat": 9},
    )
    nodes = {node["id"]: node for node in payload["nodes"]}
    edges = {(edge["source"], edge["target"]) for edge in payload["edges"]}

    assert nodes["ref_current_sketch_1"]["type"] == "imageGenNode"
    assert nodes["ref_current_sketch_1"]["data"]["imageUrl"] is None
    assert nodes["ref_current_sketch_1"]["data"]["slot_target"] == {
        "kind": "sketch",
        "episode": 1,
        "beat": 9,
    }
    assert nodes["ref_current_frame_1"]["type"] == "imageGenNode"
    assert nodes["ref_current_frame_1"]["data"]["imageUrl"] is None
    assert nodes["ref_current_frame_1"]["data"]["slot_target"] == {
        "kind": "frame",
        "episode": 1,
        "beat": 9,
    }
    assert ("skill_sketch_from_background", "ref_current_sketch_1") in edges
    assert ("skill_sketch_from_director_combined", "ref_current_sketch_1") in edges
    assert ("ref_current_sketch_1", "skill_frame_from_context") in edges
    assert ("skill_frame_from_context", "ref_current_frame_1") in edges


def test_beat_sketch_preset_current_sketch_is_canonical_source_node() -> None:
    """D0 Skill Hub cleanup: current_sketch remains a canonical source node.

    It keeps slot commit metadata for future SkillNode outputs / Push, but no
    longer embeds mainline_slot UI or typed action dispatch payload.
    """
    context = {
        "scope": "beat",
        "episode": 1,
        "beat": 8,
        "primary_slot": "sketch",
        "beat_data": {"beat_number": 8, "visual_description": "test"},
        "refs": [
            {
                "kind": "sketch",
                "role": "current_sketch",
                "rel_path": "sketches/ep001/beat_08.png",
                "url": "/static/admin/demo/sketches/ep001/beat_08.png",
                "exists": True,
                "aspect_ratio": "2:3",
                "meta": {"episode": 1, "beat": 8},
            },
            {
                "kind": "director",
                "role": "selected_background",
                "rel_path": "freezone/director_control_frames/ep001/beat_08/selected_background.png",
                "url": "/static/admin/demo/freezone/director_control_frames/ep001/beat_08/selected_background.png",
                "exists": True,
                "aspect_ratio": "16:9",
                "meta": {"episode": 1, "beat": 8},
            },
            {
                "kind": "director",
                "role": "director_combined",
                "rel_path": "freezone/director_control_frames/ep001/beat_08/combined.png",
                "url": "/static/admin/demo/freezone/director_control_frames/ep001/beat_08/combined.png",
                "exists": True,
                "aspect_ratio": "16:9",
                "meta": {"episode": 1, "beat": 8},
            },
        ],
    }
    payload = build_canvas_payload_from_context(
        context=context,
        preset_key="beat:ep001:beat008:sketch",
        default_push_target={"kind": "sketch", "episode": 1, "beat": 8},
    )
    nodes = {node["id"]: node for node in payload["nodes"]}
    sketch_node = nodes["ref_current_sketch_1"]
    data = sketch_node["data"]
    assert data["preset_managed"] is True
    assert data["committed_slot_url"] == "/static/admin/demo/sketches/ep001/beat_08.png"
    assert data["slot_target"] == {"kind": "sketch", "episode": 1, "beat": 8}
    assert "workflow_kind" not in data
    assert "typed_backend_action" not in data
    assert "typed_action_options" not in data
    assert "typed_action_input_refs" not in data


def test_beat_render_preset_current_frame_is_canonical_source_node() -> None:
    """D0 Skill Hub cleanup: current_frame is display/source, not skill UI.

    The node still carries canonical slot metadata so a generated candidate can
    Push to this target, but dispatch will move to SkillNode in the next phase.
    """
    context = {
        "scope": "beat",
        "episode": 1,
        "beat": 6,
        "primary_slot": "render",
        "beat_data": {"beat_number": 6, "visual_description": "test"},
        "refs": [
            {
                "kind": "frame",
                "role": "current_frame",
                "rel_path": "frames/ep001/beat_06.png",
                "url": "/static/admin/demo/frames/ep001/beat_06.png",
                "exists": True,
                "aspect_ratio": "2:3",
                "meta": {"episode": 1, "beat": 6},
            },
            {
                "kind": "sketch",
                "role": "current_sketch",
                "rel_path": "sketches/ep001/beat_06.png",
                "url": "/static/admin/demo/sketches/ep001/beat_06.png",
                "exists": True,
                "aspect_ratio": "2:3",
                "meta": {"episode": 1, "beat": 6},
            },
            {
                "kind": "director",
                "role": "selected_background",
                "rel_path": "freezone/director_control_frames/ep001/beat_06/selected_background.png",
                "url": "/static/admin/demo/freezone/director_control_frames/ep001/beat_06/selected_background.png",
                "exists": True,
                "aspect_ratio": "16:9",
                "meta": {"episode": 1, "beat": 6},
            },
        ],
    }
    payload = build_canvas_payload_from_context(
        context=context,
        preset_key="beat:ep001:beat006:render",
        default_push_target={"kind": "frame", "episode": 1, "beat": 6},
    )
    nodes = {node["id"]: node for node in payload["nodes"]}
    frame_node = nodes["ref_current_frame_1"]
    data = frame_node["data"]
    assert data["preset_managed"] is True
    assert data["committed_slot_url"] == "/static/admin/demo/frames/ep001/beat_06.png"
    assert data["slot_target"] == {"kind": "frame", "episode": 1, "beat": 6}
    assert "workflow_kind" not in data
    assert "typed_backend_action" not in data
    assert "typed_action_options" not in data
    assert "typed_action_input_refs" not in data


def test_character_preset_keeps_portrait_as_identity_workflow_source() -> None:
    context = {
        "scope": "asset",
        "asset_kind": "character",
        "character": "LinZhao",
        "refs": [
            {
                "kind": "identity",
                "role": "character_portrait",
                "label": "LinZhao portrait",
                "rel_path": "assets/characters/LinZhao/portrait.png",
                "url": "/static/admin/demo/assets/characters/LinZhao/portrait.png",
                "exists": True,
                "aspect_ratio": "3:4",
                "meta": {"character": "LinZhao"},
            },
            {
                "kind": "identity",
                "role": "character_identity",
                "label": "LinZhao_young_adult",
                "rel_path": "assets/characters/LinZhao/identities/young_adult.png",
                "url": "/static/admin/demo/assets/characters/LinZhao/identities/young_adult.png",
                "exists": True,
                "aspect_ratio": "3:4",
                "meta": {"character": "LinZhao", "identity_id": "LinZhao_young_adult"},
            },
            {
                "kind": "sketch",
                "role": "related_sketch",
                "label": "EP1 Beat 2 sketch",
                "rel_path": "sketches/ep001/beat_02.png",
                "url": "/static/admin/demo/sketches/ep001/beat_02.png",
                "exists": True,
                "aspect_ratio": "16:9",
                "meta": {"episode": 1, "beat": 2},
            },
        ],
        "generation_context": {
            "character_profile": {
                "name": "LinZhao",
                "aliases": ["Captain Lin"],
                "role": "protagonist",
                "gender": "male",
                "age_group": "youth",
                "body_type": "tall and straight",
                "description": "A calm and restrained squad captain",
                "face_prompt": "Male, in his twenties, with a calm gaze",
            },
            "portrait": {"character": "LinZhao", "prompt": "Male, in his twenties, with a calm gaze"},
            "identities": [
                {
                    "identity_id": "LinZhao_young_adult",
                    "identity_name": "young_adult",
                    "prompt": (
                        "Character identity reference sheet. Neutral studio setup.\n"
                        "create a 4-panel character reference sheet arranged LEFT to RIGHT\n"
                        "CHARACTER DETAILS (CRITICAL - use this for clothing and appearance):\n"
                        "Black combat uniform, a tall and straight build"
                    ),
                    "identity_prompt": "Black combat uniform, a tall and straight build",
                }
            ],
        },
    }

    payload = build_canvas_payload_from_context(
        context=context,
        preset_key="asset:character:LinZhao::",
        default_push_target={"kind": "portrait", "character": "LinZhao"},
    )
    edges = {(edge["source"], edge["target"]) for edge in payload["edges"]}
    nodes = {node["id"]: node for node in payload["nodes"]}
    node_positions = {node["id"]: node["position"] for node in payload["nodes"]}

    assert "preset_context" not in nodes
    assert nodes["character_profile"]["type"] == "textAnnotationNode"
    assert "Role: protagonist" in nodes["character_profile"]["data"]["content"]
    assert "Aliases: Captain Lin" in nodes["character_profile"]["data"]["content"]
    assert "Description:\nA calm and restrained squad captain" in nodes["character_profile"]["data"]["content"]
    assert nodes["ref_character_portrait_1"]["type"] == "imageGenNode"
    assert nodes["ref_character_identity_1"]["type"] == "imageGenNode"
    assert "ref_character_reference_1" not in nodes
    assert nodes["ref_character_portrait_1"]["data"]["__freezone_source"]["kind"] == "portrait"
    assert nodes["ref_character_identity_1"]["data"]["__freezone_source"]["kind"] == "identity"
    assert (
        nodes["ref_character_identity_1"]["data"]["referenceImageUrl"]
        == "/static/admin/demo/assets/characters/LinZhao/portrait.png"
    )
    assert ("prompt_character_portrait", "ref_character_portrait_1") in edges
    assert ("ref_character_portrait_1", "ref_character_identity_1") in edges
    assert not any(node_id.startswith("flow_identity_") for node_id in nodes)
    identity_prompt = nodes["ref_character_identity_1"]["data"]["prompt"]
    assert "Character identity reference sheet" in identity_prompt
    assert "Black combat uniform, a tall and straight build" in identity_prompt
    assert "create a 4-panel character reference sheet arranged LEFT to RIGHT" in identity_prompt
    assert (
        node_positions["prompt_character_portrait"]["x"]
        < node_positions["ref_character_portrait_1"]["x"]
    )
    assert (
        node_positions["ref_character_portrait_1"]["x"]
        < node_positions["ref_character_identity_1"]["x"]
    )
    assert "ref_related_sketch_1" not in nodes
    assert not any(target == "ref_related_sketch_1" for _source, target in edges)


def test_prop_preset_builds_prompt_to_reference_workflow() -> None:
    visual_prompt = "A gray-brown old booklet with 'Business Rules' written on the cover"
    full_prompt = build_prop_reference_prompt(visual_prompt)
    context = {
        "scope": "asset",
        "asset_kind": "prop_ref",
        "asset_id": "resident_rules",
        "refs": [
            {
                "kind": "prop",
                "role": "prop_reference",
                "label": "resident_rules",
                "rel_path": "assets/props/resident_rules/reference_3view.png",
                "url": "/static/admin/demo/assets/props/resident_rules/reference_3view.png",
                "exists": True,
                "aspect_ratio": "1:1",
                "meta": {"prop_id": "resident_rules", "prop_type": "document"},
            },
        ],
        "generation_context": {
            "prop": {
                "prop_id": "resident_rules",
                "prompt": full_prompt,
                "visual_prompt": visual_prompt,
                "profile": {
                    "name": "resident_rules",
                    "aliases": ["rules"],
                    "prop_type": "document",
                    "visual_prompt": visual_prompt,
                    "description": "Compound rules document",
                    "owner": "",
                    "notes": "Three-view reference",
                },
            }
        },
    }

    payload = build_canvas_payload_from_context(
        context=context,
        preset_key="asset:prop_ref:::resident_rules",
        default_push_target={"kind": "prop_ref", "prop_id": "resident_rules"},
    )
    nodes = {node["id"]: node for node in payload["nodes"]}
    edges = {(edge["source"], edge["target"]) for edge in payload["edges"]}

    assert nodes["prop_profile"]["type"] == "textAnnotationNode"
    assert "Aliases: rules" in nodes["prop_profile"]["data"]["content"]
    assert "prompt_prop_reference" not in nodes
    assert nodes["ref_prop_reference_1"]["type"] == "imageGenNode"
    assert nodes["ref_prop_reference_1"]["data"]["prompt"] == full_prompt
    assert nodes["ref_prop_reference_1"]["data"]["displayName"] == "resident_rules"
    assert nodes["ref_prop_reference_1"]["data"]["autoCommitOnGenerate"] is True
    assert nodes["ref_prop_reference_1"]["data"]["slot_target"] == {
        "kind": "prop_ref",
        "prop_id": "resident_rules",
    }
    assert "flow_prop_reference" not in nodes
    assert "Generate a 3-PANEL product reference sheet" in full_prompt
    assert f"PROP DESCRIPTION:\n{visual_prompt}" in full_prompt
    assert "unlabeled panels" in full_prompt
    assert "No readable writing anywhere" in full_prompt
    assert "Do NOT add text, labels, panel titles" in full_prompt
    assert "Each panel clearly labeled" not in full_prompt
    assert nodes["ref_prop_reference_1"]["data"]["__freezone_source"]["kind"] == "prop"
    assert ("prop_profile", "ref_prop_reference_1") in edges
    assert payload["metadata"]["default_push_target"] == {
        "kind": "prop_ref",
        "prop_id": "resident_rules",
    }


@pytest.mark.asyncio
async def test_prop_asset_preset_emits_missing_reference_placeholder(tmp_path: Path) -> None:
    class Store:
        _episodes = {}

        async def get_prop(self, prop_id: str):
            return SimpleNamespace(
                name=prop_id,
                aliases=["bill"],
                prop_type="document",
                visual_prompt="An old paper bill with no readable text",
                description="",
                owner="",
                notes="",
            )

    context = await build_asset_preset_context(
        project_id="proj_demo",
        username="admin",
        project="demo",
        project_dir=tmp_path,
        store=Store(),
        asset_kind="prop_ref",
        asset_id="bill",
    )

    refs_by_role = {ref["role"]: ref for ref in context["refs"]}
    assert refs_by_role["prop_reference"]["exists"] is False
    assert refs_by_role["prop_reference"]["url"] is None
    assert refs_by_role["prop_reference"]["rel_path"] == "assets/props/bill/reference_3view.png"

    payload = build_canvas_payload_from_context(
        context=context,
        preset_key="asset:prop_ref:::bill",
        default_push_target={"kind": "prop_ref", "prop_id": "bill"},
    )
    nodes = {node["id"]: node for node in payload["nodes"]}
    edges = {(edge["source"], edge["target"]) for edge in payload["edges"]}

    assert nodes["ref_prop_reference_1"]["type"] == "imageGenNode"
    assert nodes["ref_prop_reference_1"]["data"]["imageUrl"] is None
    assert nodes["ref_prop_reference_1"]["data"]["slot_target"] == {
        "kind": "prop_ref",
        "prop_id": "bill",
    }
    assert nodes["ref_prop_reference_1"]["data"]["autoCommitOnGenerate"] is True
    assert "flow_prop_reference" not in nodes
    assert "prompt_prop_reference" not in nodes


@pytest.mark.asyncio
async def test_prop_asset_context_prefers_episode_visual_prompt_over_profile_description(
    tmp_path: Path,
) -> None:
    class Store:
        _episodes = {
            1: SimpleNamespace(
                prop_menu=[
                    {
                        "prop_id": "resident_rules",
                        "prop_type": "document",
                        "visual_prompt": "A sheet of white A4 printer paper, with a prominent black title 'Resident Rules' printed at the top.",
                        "description": "A printout stuffed in the door gap, printed with twelve eerie rules.",
                    }
                ]
            )
        }

        async def get_prop(self, prop_id: str):
            return SimpleNamespace(
                name=prop_id,
                aliases=[],
                prop_type="document",
                visual_prompt="A printout stuffed in the door gap, printed with twelve eerie rules.",
                description="A printout stuffed in the door gap, printed with twelve eerie rules.",
                owner="",
                notes="",
            )

    context = await build_asset_preset_context(
        project_id="proj_demo",
        username="admin",
        project="demo",
        project_dir=tmp_path,
        store=Store(),
        asset_kind="prop_ref",
        asset_id="resident_rules",
    )

    prop_context = context["generation_context"]["prop"]
    assert prop_context["visual_prompt"] == "A sheet of white A4 printer paper, with a prominent black title 'Resident Rules' printed at the top."
    assert "Generate a 3-PANEL product reference sheet" in prop_context["prompt"]
    assert (
        "PROP DESCRIPTION:\nA sheet of white A4 printer paper, with a prominent black title 'Resident Rules' printed at the top."
        in prop_context["prompt"]
    )
    assert (
        prop_context["profile"]["visual_prompt"]
        == "A sheet of white A4 printer paper, with a prominent black title 'Resident Rules' printed at the top."
    )


def test_prop_preset_default_push_target_uses_prop_ref() -> None:
    assert _default_push_target_for_preset(
        PresetCanvasRequest(scope="asset", asset_kind="prop_ref", asset_id="resident_rules")
    ) == {"kind": "prop_ref", "prop_id": "resident_rules"}


@pytest.mark.asyncio
async def test_character_asset_preset_emits_missing_identity_slot_placeholders(
    tmp_path: Path,
) -> None:
    _write_fake_image(tmp_path / "assets/characters/LinZhao/portrait.png")

    class Store:
        def get_character(self, name: str):
            return SimpleNamespace(
                name=name,
                aliases=[],
                role="protagonist",
                is_main=True,
                gender="male",
                age_group="youth",
                body_type="tall and straight",
                description="Calm and restrained",
                face_prompt="Male in his twenties, with a calm gaze",
                identities=[
                    SimpleNamespace(
                        identity_id="LinZhao_young_adult",
                        identity_name="young_adult",
                        appearance_details="Black combat uniform, a tall and straight build",
                        face_prompt="",
                        age_group="youth",
                        portrait_image="",
                        costume_image="",
                    )
                ],
            )

    context = await build_asset_preset_context(
        project_id="proj_demo",
        username="admin",
        project="demo",
        project_dir=tmp_path,
        store=Store(),
        asset_kind="character",
        character="LinZhao",
    )

    refs_by_role = {ref["role"]: ref for ref in context["refs"]}
    assert refs_by_role["character_portrait"]["exists"] is True
    assert refs_by_role["character_identity"]["exists"] is False
    assert refs_by_role["character_identity"]["url"] is None
    assert refs_by_role["character_identity"]["rel_path"].endswith(
        "assets/characters/LinZhao/identities/young_adult.png"
    )
    assert "identity_portrait" not in refs_by_role
    assert refs_by_role["identity_costume"]["exists"] is False
    assert refs_by_role["identity_costume"]["url"] is None
    assert refs_by_role["identity_costume"]["rel_path"].endswith(
        "assets/characters/LinZhao/identities/young_adult_costume.png"
    )

    payload = build_canvas_payload_from_context(
        context=context,
        preset_key="asset:character:LinZhao::",
        default_push_target={"kind": "portrait", "character": "LinZhao"},
    )
    nodes = {node["id"]: node for node in payload["nodes"]}
    edges = {(edge["source"], edge["target"]) for edge in payload["edges"]}

    assert nodes["ref_character_identity_1"]["type"] == "imageGenNode"
    assert nodes["ref_character_identity_1"]["data"]["imageUrl"] is None
    assert nodes["ref_character_identity_1"]["data"]["slot_target"] == {
        "kind": "identity",
        "character": "LinZhao",
        "identity_id": "LinZhao_young_adult",
    }
    assert nodes["ref_character_identity_1"]["data"]["autoCommitOnGenerate"] is True
    portrait_prompt = nodes["ref_character_portrait_1"]["data"]["prompt"]
    assert "Generate a face-only character identity reference portrait" in portrait_prompt
    assert "FACIAL FEATURES TO CAPTURE" in portrait_prompt
    assert "Male in his twenties, with a calm gaze" in portrait_prompt
    assert "VISUAL STYLE:" in portrait_prompt
    assert "MUST AVOID:" in portrait_prompt
    assert nodes["prompt_character_portrait"]["data"]["content"] == portrait_prompt
    assert "ref_identity_portrait_1" not in nodes
    assert nodes["ref_identity_costume_1"]["type"] == "imageGenNode"
    assert nodes["ref_identity_costume_1"]["data"]["imageUrl"] is None
    assert nodes["ref_identity_costume_1"]["data"]["slot_target"] == {
        "kind": "identity_costume",
        "character": "LinZhao",
        "identity_id": "LinZhao_young_adult",
    }
    assert nodes["ref_identity_costume_1"]["data"]["autoCommitOnGenerate"] is True
    identity_prompt = nodes["ref_character_identity_1"]["data"]["prompt"]
    costume_prompt = nodes["ref_identity_costume_1"]["data"]["prompt"]
    assert "Character identity reference sheet" in identity_prompt
    assert "Black combat uniform, a tall and straight build" in identity_prompt
    assert "PLAIN SOLID WHITE or LIGHT GRAY background ONLY" in identity_prompt
    assert costume_prompt == identity_prompt
    assert ("ref_character_portrait_1", "ref_character_identity_1") in edges
    assert ("ref_identity_costume_1", "ref_character_identity_1") in edges


@pytest.mark.asyncio
async def test_character_asset_preset_style_lookup_uses_project_context(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    def fake_load_project_config(username: str, project: str) -> dict[str, str]:
        captured["config_username"] = username
        captured["config_project"] = project
        return {"visual_style": "custom_style", "ethnicity": "Chinese"}

    def fake_get_style_preset(style: str, **kwargs: object) -> dict[str, str]:
        captured["style"] = style
        captured["kwargs"] = kwargs
        return {
            "style_instructions": "custom cinematic material language",
            "avoid_instructions": "avoid generic flat lighting",
        }

    monkeypatch.setattr(
        "novelvideo.project_config.load_project_config",
        fake_load_project_config,
    )
    monkeypatch.setattr(
        "novelvideo.config.get_style_preset",
        fake_get_style_preset,
    )

    class Store:
        def get_character(self, name: str):
            return SimpleNamespace(
                name=name,
                aliases=[],
                role="protagonist",
                is_main=True,
                gender="male",
                age_group="youth",
                body_type="tall and straight",
                description="Calm and restrained",
                face_prompt="Male in his twenties, with a calm gaze",
                identities=[],
            )

    context = await build_asset_preset_context(
        project_id="proj_demo",
        username="admin",
        project="demo",
        project_dir=tmp_path,
        store=Store(),
        asset_kind="character",
        character="LinZhao",
    )

    assert captured["config_username"] == "admin"
    assert captured["config_project"] == "demo"
    assert captured["style"] == "custom_style"
    assert captured["kwargs"] == {
        "username": "admin",
        "project": "demo",
        "project_dir": str(tmp_path),
    }
    portrait_prompt = context["generation_context"]["portrait"]["prompt"]
    assert "custom cinematic material language" in portrait_prompt
    assert "avoid generic flat lighting" in portrait_prompt


def test_scene_preset_default_push_targets_use_requested_scene_kind() -> None:
    for asset_kind in [
        "scene_master",
        "scene_reverse_master",
        "scene_spatial_layout",
        "scene_360",
        "scene_director_pano_360",
        "scene_3gs_active_ply",
        "scene_3gs_master_ply",
        "scene_3gs_reverse_ply",
        "scene_3gs_pano_ply",
        "scene_3gs_custom_scene",
        "scene_3gs_collision_glb",
    ]:
        assert _default_push_target_for_preset(
            PresetCanvasRequest(scope="asset", asset_kind=asset_kind, asset_id="compound")
        ) == {"kind": asset_kind, "scene_id": "compound"}


@pytest.mark.asyncio
async def test_scene_asset_preset_context_preserves_project_style_in_prompts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Store:
        async def get_scene(self, scene_id: str):
            return {
                "scene_id": scene_id,
                "scene_type": "interior",
                "environment_prompt": "Apartment building elevator lobby, elevator digital display, fixed ceiling light",
            }

    monkeypatch.setattr(
        freezone_presets,
        "_project_style_meta",
        lambda _username, _project, _project_dir: {
            "style_name": "Cinematic realism (cinematic)",
            "style_prompt": "cinematic realism, controlled highlights, subtle film grain",
            "avoid_instructions": "no cartoon rendering, no plastic surfaces",
        },
    )

    context = await build_asset_preset_context(
        project_id="proj_demo",
        username="admin",
        project="demo",
        project_dir=tmp_path,
        store=Store(),
        asset_kind="scene",
        asset_id="apartment_elevator",
    )
    payload = build_canvas_payload_from_context(
        context=context,
        preset_key="asset:scene:::apartment_elevator",
        default_push_target={"kind": "scene_master", "scene_id": "apartment_elevator"},
    )
    nodes = {node["id"]: node for node in payload["nodes"]}
    master_content = nodes["prompt_scene_apartment_elevator_master"]["data"]["content"]
    generic_content = nodes["prompt_scene_apartment_elevator"]["data"]["content"]

    for content in [master_content, generic_content]:
        assert "Cinematic realism (cinematic)" in content
        assert "cinematic realism, controlled highlights, subtle film grain" in content
        assert "no cartoon rendering, no plastic surfaces" in content


@pytest.mark.asyncio
async def test_scene_asset_preset_projects_derived_scene_effective_prompt(
    tmp_path: Path,
) -> None:
    base_master_path = tmp_path / "assets" / "scenes" / "City_Street" / "master.png"
    base_master_path.parent.mkdir(parents=True)
    base_master_path.write_bytes(b"fake image")

    class Store:
        async def get_scene(self, scene_id: str):
            scenes = {
                "City_Street": {
                    "scene_id": "City_Street",
                    "name": "City_Street",
                    "scene_type": "exterior",
                    "environment_prompt": "Front: neon shops and a bus stop\nLeft: glass display windows",
                    "description": "City main street",
                },
                "City_Street_rainy_night": {
                    "scene_id": "City_Street_rainy_night",
                    "name": "City_Street_rainy_night",
                    "scene_type": "exterior",
                    "base_scene_id": "City_Street",
                    "variant_id": "rainy_night",
                    "environment_prompt": "",
                    "variant_prompt": "Standing water on the road reflects neon, with heavy rain and humid air",
                    "description": "Rainy night city street",
                },
            }
            return scenes.get(scene_id)

    context = await build_asset_preset_context(
        project_id="proj_demo",
        username="admin",
        project="demo",
        project_dir=tmp_path,
        store=Store(),
        asset_kind="scene",
        asset_id="City_Street_rainy_night",
    )
    payload = build_canvas_payload_from_context(
        context=context,
        preset_key="asset:scene:::City_Street_rainy_night",
        default_push_target={"kind": "scene_master", "scene_id": "City_Street_rainy_night"},
    )
    prompt_nodes = [
        node
        for node in payload["nodes"]
        if node.get("data", {}).get("__freezone_source", {}).get("role")
        == "scene_master_generation_prompt"
    ]
    assert len(prompt_nodes) == 1
    content = prompt_nodes[0]["data"]["content"]
    assert "Front: neon shops and a bus stop" in content
    assert "Standing water on the road reflects neon" in content
    assert "VARIANT DELTA PROMPT" in content
    base_master_nodes = [
        node
        for node in payload["nodes"]
        if node.get("data", {}).get("displayName") == "City_Street base master"
    ]
    assert len(base_master_nodes) == 1
    assert base_master_nodes[0]["data"]["imageUrl"]
    edges = {(edge["source"], edge["target"]) for edge in payload["edges"]}
    assert (base_master_nodes[0]["id"], "ref_scene_master_1") in edges


def test_scene_preset_default_push_target_keeps_scene_alias_as_master() -> None:
    assert _default_push_target_for_preset(
        PresetCanvasRequest(scope="asset", asset_kind="scene", asset_id="compound")
    ) == {"kind": "scene_master", "scene_id": "compound"}


@pytest.mark.asyncio
async def test_character_asset_preset_emits_age_variant_portrait_placeholder(
    tmp_path: Path,
) -> None:
    class Store:
        def get_character(self, name: str):
            return SimpleNamespace(
                name=name,
                aliases=[],
                role="protagonist",
                is_main=True,
                gender="male",
                age_group="youth",
                body_type="tall and straight",
                description="Calm and restrained",
                face_prompt="Male in his twenties, with a calm gaze",
                identities=[
                    SimpleNamespace(
                        identity_id="LinZhao_middle_aged",
                        identity_name="middle_aged",
                        appearance_details="Middle-aged form, with fine lines at the corners of the eyes",
                        face_prompt="",
                        age_group="middle_age",
                        portrait_image="",
                        costume_image="",
                    )
                ],
            )

    context = await build_asset_preset_context(
        project_id="proj_demo",
        username="admin",
        project="demo",
        project_dir=tmp_path,
        store=Store(),
        asset_kind="character",
        character="LinZhao",
    )

    refs_by_role = {ref["role"]: ref for ref in context["refs"]}
    assert refs_by_role["identity_portrait"]["exists"] is False
    assert refs_by_role["identity_portrait"]["url"] is None
    assert refs_by_role["identity_portrait"]["rel_path"].endswith(
        "assets/characters/LinZhao/identities/LinZhao_middle_aged_portrait.png"
    )

    payload = build_canvas_payload_from_context(
        context=context,
        preset_key="asset:character:LinZhao::",
        default_push_target={"kind": "portrait", "character": "LinZhao"},
    )
    nodes = {node["id"]: node for node in payload["nodes"]}
    edges = {(edge["source"], edge["target"]) for edge in payload["edges"]}

    assert nodes["ref_identity_portrait_1"]["type"] == "imageGenNode"
    assert nodes["ref_identity_portrait_1"]["data"]["imageUrl"] is None
    assert nodes["ref_identity_portrait_1"]["data"]["slot_target"] == {
        "kind": "identity_portrait",
        "character": "LinZhao",
        "identity_id": "LinZhao_middle_aged",
    }
    assert nodes["ref_identity_portrait_1"]["data"]["autoCommitOnGenerate"] is True
    identity_portrait_prompt = nodes["ref_identity_portrait_1"]["data"]["prompt"]
    assert "Generate a face-only character identity reference portrait" in identity_portrait_prompt
    assert "FACIAL FEATURES TO CAPTURE" in identity_portrait_prompt
    assert "Middle-aged form, with fine lines at the corners of the eyes" in identity_portrait_prompt
    assert "VISUAL STYLE:" in identity_portrait_prompt
    assert "MUST AVOID:" in identity_portrait_prompt
    assert ("ref_identity_portrait_1", "ref_character_identity_1") in edges


def test_portrait_preset_does_not_duplicate_portrait_as_identity(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    portrait_path = project_dir / "assets" / "characters" / "ZhouMuye" / "portrait.png"
    portrait_path.parent.mkdir(parents=True)
    portrait_path.write_bytes(b"fake portrait")

    refs = []
    from novelvideo.freezone.presets import _add_character_refs

    _add_character_refs(
        refs,
        project_id="proj_demo",
        username="admin",
        project="demo",
        project_dir=project_dir,
        character="ZhouMuye",
        identity_id=None,
    )

    payload_refs = [ref.model_dump() for ref in refs]
    assert [ref["role"] for ref in payload_refs] == ["character_portrait"]

    payload = build_canvas_payload_from_context(
        context={
            "scope": "asset",
            "asset_kind": "portrait",
            "character": "ZhouMuye",
            "refs": payload_refs,
            "generation_context": {
                "portrait": {"character": "ZhouMuye", "prompt": "Neat short hair, cold sharp eyes"},
                "identities": [],
            },
        },
        preset_key="asset:portrait:ZhouMuye::",
        default_push_target={"kind": "portrait", "character": "ZhouMuye"},
    )

    ref_nodes = [node for node in payload["nodes"] if node["id"].startswith("ref_")]
    assert [node["id"] for node in ref_nodes] == ["ref_character_portrait_1"]
    assert ref_nodes[0]["type"] == "imageGenNode"
    assert ref_nodes[0]["data"]["__freezone_source"]["kind"] == "portrait"
