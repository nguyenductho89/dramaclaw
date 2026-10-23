"""Unit tests for the 2026-10-22 wiring in `generators/nanobanana_grid.py`
that feeds prop descriptions / subject-scale hints / a scene's staging
bible into the sketch-free "compose" render prompts — the real fix for
`Parkun`'s renders (unimaged props getting an invented shape, toddlers
rendered near-adult scale, a scene's set-dressing drifting/vanishing
beat to beat). See `.claude/CLAUDE.md`'s "Parkun" entry.

Real tiny PNGs on disk via PIL/`tmp_path`, no DB, no network, no GPU
calls."""

from __future__ import annotations

from PIL import Image

from novelvideo.generators import nanobanana_grid as grid
from novelvideo.generators.staging_store import SceneStaging, SetDressingItem, save_episode_staging
from novelvideo.utils.asset_resolver import ResolvedAssetRef


def _make_png(path, size=(64, 64), color=(10, 20, 30)):
    img = Image.new("RGB", size, color)
    img.save(path, format="PNG")
    return str(path)


def _scene_ref(path: str, base_id: str = "park") -> ResolvedAssetRef:
    return ResolvedAssetRef(
        asset_type="scene",
        base_id=base_id,
        variant_id=None,
        image_paths=[path],
        text_description="",
        source_level="scene_master",
    )


def _prop_ref(base_id: str, description: str, path: str | None = None) -> ResolvedAssetRef:
    return ResolvedAssetRef(
        asset_type="prop",
        base_id=base_id,
        variant_id=None,
        image_paths=[path] if path else [],
        text_description=description,
        source_level="prop_reference" if path else "base_text",
    )


# ── _qwen21_compose_prop_descriptions ───────────────────────────────────


def test_prop_descriptions_keyed_by_marker_matches_normalized_base_id():
    beat = {"visual_description": "{{Nam}} stands beside the [[toy wall]]."}
    prop_refs = [_prop_ref("Toy Wall", "low multicolor plastic-brick wall")]
    out = grid._qwen21_compose_prop_descriptions(beat, prop_refs)
    assert out == {"toy wall": "low multicolor plastic-brick wall"}


def test_prop_descriptions_skips_props_with_no_description():
    beat = {"detected_props": ["mystery prop"]}
    prop_refs = [_prop_ref("mystery prop", "")]
    out = grid._qwen21_compose_prop_descriptions(beat, prop_refs)
    assert out == {}


def test_prop_descriptions_empty_when_no_refs():
    beat = {"visual_description": "{{Nam}} stands beside the [[toy wall]]."}
    out = grid._qwen21_compose_prop_descriptions(beat, [])
    assert out == {}


# ── _compose_absent_character_names / scrub ─────────────────────────────
#
# Third real bug caught on a real GPU render (`Parkun` beat 3,
# Kim-only): a prop's own `description` row in the project database is
# often a narrative blurb about who owns/uses it, not a pure visual
# description — e.g. the "toy wall" prop's `description` is "Little
# Trump's prized construction; he adds bricks and refuses to take it
# down..." (see `.claude/CLAUDE.md`). `_qwen21_compose_prop_descriptions`
# surfaces whatever `ResolvedAssetRef.text_description` resolved to
# (which, per `AssetResolver.resolve_props_for_beat()`'s own priority
# order, prefers that narrative `description` over the purely visual
# `visual_prompt` field when both exist) — this is injected into the
# prompt verbatim, including for an ALREADY-IMAGED prop (not just the
# "no reference image" case these helpers were originally built for).
# Beat 3 only tags Little Kim; the surviving mention of "Little Trump"
# in the toy wall's description implied a second person should be in
# frame holding/building it, and the model drew one.


def test_compose_prompt_extras_prop_description_naming_absent_character_is_dropped(tmp_path):
    character_map = _two_character_map(tmp_path)
    beat = {
        "beat_number": 3,
        "detected_identities": ["Kim"],  # Trump is NOT in this beat
        "detected_props": ["toy wall"],
        "visual_description": "{{Kim}} raises a [[toy rocket]] beside the [[toy wall]].",
    }
    prop_refs = [
        _prop_ref(
            "toy wall",
            "Little Trump's prized construction; he adds bricks and refuses to take it down, "
            "so it must look identical across shots.",
            path=_make_png(tmp_path / "toy_wall.png"),
        )
    ]
    prop_descriptions, _scale, _staging = grid._compose_prompt_extras(
        character_map=character_map,
        beat=beat,
        beat_prop_refs=prop_refs,
        project_dir=None,
        episode_number=None,
    )
    assert "toy wall" not in prop_descriptions  # scrubbed to empty, then dropped entirely


def test_compose_prompt_extras_prop_description_naming_present_character_is_kept(tmp_path):
    character_map = _two_character_map(tmp_path)
    beat = {
        "beat_number": 1,
        "detected_identities": ["Trump"],
        "detected_props": ["toy wall"],
        "visual_description": "{{Trump}} builds the [[toy wall]].",
    }
    prop_refs = [
        _prop_ref(
            "toy wall",
            "Little Trump's prized construction; he adds bricks and refuses to take it down.",
            path=_make_png(tmp_path / "toy_wall.png"),
        )
    ]
    prop_descriptions, _scale, _staging = grid._compose_prompt_extras(
        character_map=character_map,
        beat=beat,
        beat_prop_refs=prop_refs,
        project_dir=None,
        episode_number=None,
    )
    assert "Little Trump" in prop_descriptions["toy wall"]


def test_build_qwen21_compose_plan_prop_description_never_names_absent_character(tmp_path):
    # End-to-end version of the real bug (`Parkun` beat 3).
    scene_path = _make_png(tmp_path / "scene.png", size=(200, 100))
    character_map = _two_character_map(tmp_path)
    wall_path = _make_png(tmp_path / "toy_wall.png")

    beat = {
        "beat_number": 3,
        "visual_description": "{{Kim}} raises a [[toy rocket]] beside the [[toy wall]].",
        "detected_identities": ["Kim"],
        "detected_props": ["toy wall"],
        "scene_ref": {"scene_id": "PARK"},
    }
    plan, err = grid._build_qwen21_compose_plan(
        beat=beat,
        character_map=character_map,
        scene_refs={1: [_scene_ref(scene_path, base_id="PARK")]},
        prop_refs={
            1: [
                _prop_ref(
                    "toy wall",
                    "Little Trump's prized construction; he adds bricks and refuses to take it down.",
                    path=wall_path,
                )
            ]
        },
        mode_key=None,
        project_dir=None,
        episode_number=None,
    )
    assert plan is not None, err
    assert "Trump" not in plan.prompt
    assert "exactly 1 person" in plan.prompt


# ── _qwen21_compose_subject_scale_hints ─────────────────────────────────


def test_subject_scale_hints_from_identity_level_body_type():
    character_map = {
        "Nam": {
            "name": "Nam",
            "body_type": "",
            "identities": [{"identity_name": "toddler", "body_type": "small toddler build"}],
        }
    }
    beat = {"detected_identities": ["Nam_toddler"]}
    out = grid._qwen21_compose_subject_scale_hints(character_map, beat)
    assert out == {"Nam_toddler": "small toddler build"}


def test_subject_scale_hints_falls_back_to_character_level_body_type():
    character_map = {"Nam": {"name": "Nam", "body_type": "small toddler build", "identities": []}}
    beat = {"detected_identities": ["Nam"]}
    out = grid._qwen21_compose_subject_scale_hints(character_map, beat)
    assert out == {"Nam": "small toddler build"}


def test_subject_scale_hints_skips_identity_with_no_body_type():
    character_map = {"Nam": {"name": "Nam", "body_type": "", "identities": []}}
    beat = {"detected_identities": ["Nam"]}
    out = grid._qwen21_compose_subject_scale_hints(character_map, beat)
    assert out == {}


# ── _compose_prompt_extras / staging wiring ─────────────────────────────


def _character_map_for(tmp_path, char_name: str, body_type: str = "") -> dict:
    portrait = _make_png(tmp_path / f"{char_name}_portrait.png")
    return {
        char_name: {
            "name": char_name,
            "portrait_path": portrait,
            "appearance_details": "",
            "body_type": body_type,
            "identities": [],
        }
    }


def _two_character_map(tmp_path) -> dict:
    # `character_map` in production (`_build_character_map()` in
    # `api/routes/generation.py`) always holds the WHOLE project cast,
    # not just one beat's — `_compose_absent_character_names()` depends
    # on that to know who else exists to scrub.
    merged = _character_map_for(tmp_path, "Trump")
    merged.update(_character_map_for(tmp_path, "Kim"))
    return merged


def test_compose_prompt_extras_no_staging_when_sidecar_missing(tmp_path):
    character_map = _character_map_for(tmp_path, "Trump")
    beat = {"beat_number": 5, "detected_identities": ["Trump"], "scene_ref": {"scene_id": "X"}}
    _desc, _scale, staging_dict = grid._compose_prompt_extras(
        character_map=character_map,
        beat=beat,
        beat_prop_refs=[],
        project_dir=tmp_path,
        episode_number=1,
    )
    assert staging_dict is None


def test_compose_prompt_extras_resolves_staging_for_beats_scene(tmp_path):
    staging = SceneStaging(
        scene_id="PRESCHOOL PLAYGROUND",
        camera="eye-level shot",
        blocking={"Trump": "Trump stands left."},
        set_dressing=[
            SetDressingItem(
                prop_id="toy wall",
                placement_note="The toy wall sits center-left.",
                persistent=True,
                from_beat=1,
            )
        ],
        scale_note="toddler height",
    )
    save_episode_staging(tmp_path, 1, {"PRESCHOOL PLAYGROUND": staging})

    character_map = _character_map_for(tmp_path, "Trump")
    beat = {
        "beat_number": 5,  # does NOT itself tag the toy wall
        "detected_identities": ["Trump"],
        "scene_ref": {"scene_id": "PRESCHOOL PLAYGROUND"},
        "visual_description": "{{Trump}} stares at the rocket.",
    }
    _desc, _scale, staging_dict = grid._compose_prompt_extras(
        character_map=character_map,
        beat=beat,
        beat_prop_refs=[],
        project_dir=tmp_path,
        episode_number=1,
    )
    assert staging_dict is not None
    assert staging_dict["camera"] == "eye-level shot"
    assert staging_dict["blocking"] == {"Trump": "Trump stands left."}
    assert staging_dict["set_dressing"] == [{"placement_note": "The toy wall sits center-left."}]


def test_compose_prompt_extras_blocking_excludes_identities_not_in_this_beat(tmp_path):
    # Real bug caught on a real GPU render (`Parkun` beats 1 and 7, both
    # single-character per `detected_identities`) — a scene-wide staging
    # bible's `blocking` dict holds a placement sentence for EVERY
    # character who ever appears in the scene; passing the other,
    # un-imaged character's own placement sentence through to a
    # single-character beat's prompt hallucinated a second,
    # unreferenced person into the render. See `.claude/CLAUDE.md`.
    staging = SceneStaging(
        scene_id="PRESCHOOL PLAYGROUND",
        camera="eye-level shot",
        blocking={
            "Trump": "Trump stands on the left side of frame.",
            "Kim": "Kim stands on the right side of frame.",
        },
    )
    save_episode_staging(tmp_path, 1, {"PRESCHOOL PLAYGROUND": staging})

    character_map = _character_map_for(tmp_path, "Trump")
    beat = {
        "beat_number": 7,
        "detected_identities": ["Trump"],  # Kim is NOT in this beat
        "scene_ref": {"scene_id": "PRESCHOOL PLAYGROUND"},
        "visual_description": "{{Trump}} places another brick.",
    }
    _desc, _scale, staging_dict = grid._compose_prompt_extras(
        character_map=character_map,
        beat=beat,
        beat_prop_refs=[],
        project_dir=tmp_path,
        episode_number=1,
    )
    assert staging_dict is not None
    assert staging_dict["blocking"] == {"Trump": "Trump stands on the left side of frame."}
    assert "Kim" not in staging_dict["blocking"]


def test_compose_prompt_extras_set_dressing_scrubs_mention_of_absent_identity(tmp_path):
    # Second real bug caught on a real GPU render (`Parkun` beat 7,
    # Trump-only): the toy rocket's persistent set-dressing note named
    # "Little Kim" (correct for a beat where Kim is present, e.g. beat
    # 3), but beat 7 doesn't include Kim at all — the note still implied
    # a second person was in frame holding it. See `.claude/CLAUDE.md`.
    staging = SceneStaging(
        scene_id="PRESCHOOL PLAYGROUND",
        blocking={"Trump": "Trump stands left.", "Kim": "Kim stands right."},
        set_dressing=[
            SetDressingItem(
                prop_id="toy rocket",
                placement_note="The tin toy rocket is held up in Kim's hand.",
                persistent=True,
                from_beat=3,
            )
        ],
    )
    save_episode_staging(tmp_path, 1, {"PRESCHOOL PLAYGROUND": staging})

    character_map = _two_character_map(tmp_path)
    beat = {
        "beat_number": 7,
        "detected_identities": ["Trump"],  # Kim is NOT in this beat
        "scene_ref": {"scene_id": "PRESCHOOL PLAYGROUND"},
    }
    _desc, _scale, staging_dict = grid._compose_prompt_extras(
        character_map=character_map,
        beat=beat,
        beat_prop_refs=[],
        project_dir=tmp_path,
        episode_number=1,
    )
    assert staging_dict is not None
    note = staging_dict["set_dressing"][0]["placement_note"]
    assert "Kim" not in note
    assert note == "The toy rocket is present in the scene."


def test_compose_prompt_extras_set_dressing_keeps_mention_of_present_identity(tmp_path):
    # Control case: the same note is kept verbatim when the named
    # character IS actually in this beat.
    staging = SceneStaging(
        scene_id="PRESCHOOL PLAYGROUND",
        blocking={"Trump": "Trump stands left.", "Kim": "Kim stands right."},
        set_dressing=[
            SetDressingItem(
                prop_id="toy rocket",
                placement_note="The tin toy rocket is held up in Kim's hand.",
                persistent=True,
                from_beat=3,
            )
        ],
    )
    save_episode_staging(tmp_path, 1, {"PRESCHOOL PLAYGROUND": staging})

    character_map = _two_character_map(tmp_path)
    beat = {
        "beat_number": 5,
        "detected_identities": ["Trump", "Kim"],
        "scene_ref": {"scene_id": "PRESCHOOL PLAYGROUND"},
    }
    _desc, _scale, staging_dict = grid._compose_prompt_extras(
        character_map=character_map,
        beat=beat,
        beat_prop_refs=[],
        project_dir=tmp_path,
        episode_number=1,
    )
    assert staging_dict is not None
    note = staging_dict["set_dressing"][0]["placement_note"]
    assert note == "The tin toy rocket is held up in Kim's hand."


def test_compose_prompt_extras_persistent_prop_dropped_before_its_from_beat(tmp_path):
    staging = SceneStaging(
        scene_id="PRESCHOOL PLAYGROUND",
        set_dressing=[
            SetDressingItem(
                prop_id="candy box", placement_note="The candy box appears.", persistent=True, from_beat=13
            )
        ],
    )
    save_episode_staging(tmp_path, 1, {"PRESCHOOL PLAYGROUND": staging})
    character_map = _character_map_for(tmp_path, "Trump")
    beat = {
        "beat_number": 5,  # before from_beat=13
        "detected_identities": ["Trump"],
        "scene_ref": {"scene_id": "PRESCHOOL PLAYGROUND"},
    }
    _desc, _scale, staging_dict = grid._compose_prompt_extras(
        character_map=character_map,
        beat=beat,
        beat_prop_refs=[],
        project_dir=tmp_path,
        episode_number=1,
    )
    # Only camera/blocking are empty too (all defaults) -> no staging dict
    # at all since nothing is usable yet at beat 5.
    assert staging_dict is None


def test_build_qwen21_compose_plan_includes_persistent_prop_note_on_untagged_beat(tmp_path):
    # End-to-end: beat 5 doesn't mention the toy wall at all, but the
    # scene's staging bible says it's persistent from beat 1 — the real
    # bug this fixes (`Parkun` beat 5: the toy wall vanished from the
    # render even though the beat's own narration still refers to it).
    scene_path = _make_png(tmp_path / "scene.png", size=(200, 100))
    character_map = _character_map_for(tmp_path, "Trump", body_type="small toddler build")

    staging = SceneStaging(
        scene_id="PRESCHOOL PLAYGROUND",
        camera="eye-level medium-wide shot",
        set_dressing=[
            SetDressingItem(
                prop_id="toy wall",
                placement_note="The toy wall still stands beside Trump.",
                persistent=True,
                from_beat=1,
            )
        ],
    )
    save_episode_staging(tmp_path, 1, {"PRESCHOOL PLAYGROUND": staging})

    beat = {
        "beat_number": 5,
        "visual_description": "{{Trump}} stares at the rocket.",
        "detected_identities": ["Trump"],
        "detected_props": [],
        "scene_ref": {"scene_id": "PRESCHOOL PLAYGROUND"},
    }
    plan, err = grid._build_qwen21_compose_plan(
        beat=beat,
        character_map=character_map,
        scene_refs={1: [_scene_ref(scene_path)]},
        prop_refs={},
        mode_key=None,
        project_dir=tmp_path,
        episode_number=1,
    )
    assert plan is not None, err
    assert "The toy wall still stands beside Trump." in plan.prompt
    assert "eye-level medium-wide shot" in plan.prompt
    assert "small toddler build" in plan.prompt


def test_build_qwen21_compose_plan_single_character_beat_never_mentions_other_cast_member(
    tmp_path,
):
    # End-to-end version of the real GPU-caught bug: a scene staged with
    # 2 characters, but THIS beat only has 1 — the final prompt must not
    # name or place the other one anywhere.
    scene_path = _make_png(tmp_path / "scene.png", size=(200, 100))
    character_map = _character_map_for(tmp_path, "Trump")

    staging = SceneStaging(
        scene_id="PRESCHOOL PLAYGROUND",
        camera="eye-level medium-wide shot",
        blocking={
            "Trump": "Trump stands on the left side of frame.",
            "Kim": "Kim stands on the right side of frame.",
        },
    )
    save_episode_staging(tmp_path, 1, {"PRESCHOOL PLAYGROUND": staging})

    beat = {
        "beat_number": 7,
        "visual_description": "{{Trump}} places another brick onto the toy wall.",
        "detected_identities": ["Trump"],
        "detected_props": [],
        "scene_ref": {"scene_id": "PRESCHOOL PLAYGROUND"},
    }
    plan, err = grid._build_qwen21_compose_plan(
        beat=beat,
        character_map=character_map,
        scene_refs={1: [_scene_ref(scene_path)]},
        prop_refs={},
        mode_key=None,
        project_dir=tmp_path,
        episode_number=1,
    )
    assert plan is not None, err
    assert "Trump stands on the left side of frame." in plan.prompt
    assert "Kim" not in plan.prompt
    assert "exactly 1 person" in plan.prompt
