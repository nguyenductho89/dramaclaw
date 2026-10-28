"""H3 beat input modes: t2va / fl2va / flf2va / ref2va with or without a
pinned first frame, reference kinds (character / prop / scene) and the
single plan function review, prompt generation and generation share."""

from __future__ import annotations

from pathlib import Path

import pytest

from novelvideo import config
from novelvideo.agents.minimax_h3_prompt_builder import (
    MiniMaxH3BeatContext,
    MiniMaxH3CameraContent,
    MiniMaxH3Content,
    MiniMaxH3Reference,
    MiniMaxH3SubjectContent,
    MiniMaxH3TimelineBeat,
    assemble_minimax_h3_prompt,
)
from novelvideo.agents.minimax_h3_prompt_lint import lint_minimax_h3_prompt
from novelvideo.api.routes.generation import (
    _h3_identity_label,
    _h3_picture_count,
    _h3_plan_inputs,
    _h3_select_references,
)
from novelvideo.generators import runpod_minimax_h3_video as h3


def _content(n_subjects: int) -> MiniMaxH3Content:
    return MiniMaxH3Content(
        first_frame_description="a girl on a wooden bridge",
        style_line="Live-action film footage, soft daylight.",
        framing="a medium shot at eye level",
        subjects=[MiniMaxH3SubjectContent(anchor="black hair, navy uniform")] * n_subjects,
        camera=MiniMaxH3CameraContent(movement="static"),
        summary_action="She steps forward.",
        timeline=[MiniMaxH3TimelineBeat(t=1.0, action="She steps forward holding her phone.")],
        voices=[],
        end_state="she stands still holding the phone",
        soundscape="Crowd murmur.",
        music="N/A",
    )


def _ref(tag, name, kind="character"):
    return MiniMaxH3Reference(tag=tag, kind=kind, name=name)


def _errors(prompt, mode, pictures):
    lint = lint_minimax_h3_prompt(prompt, mode=mode, reference_count=pictures, duration_seconds=6.0)
    return [i.code for i in lint.issues if i.severity == "error"]


def test_identity_label_keeps_the_identity():
    assert _h3_identity_label("Yui_modern_schoolgirl", "Yui") == "Yui (modern schoolgirl)"
    assert _h3_identity_label("Yui", "Yui") == "Yui"


def test_ref2va_with_first_frame_names_characters_props_and_scene():
    refs = [
        _ref("<Picture 2>", "Yui (modern schoolgirl)"),
        _ref("<Picture 3>", "phone", "prop"),
        _ref("<Picture 4>", "Nihonbashi Bridge", "scene"),
    ]
    ctx = MiniMaxH3BeatContext(mode="ref2va", duration_seconds=6.0, references=refs)
    prompt = assemble_minimax_h3_prompt(ctx, _content(3))
    assert "<Subject 1> is Yui (modern schoolgirl), shown in <Picture 2>" in prompt
    assert "<Subject 2> is the prop phone, shown in <Picture 3>" in prompt
    assert "<Picture 4> shows the setting Nihonbashi Bridge" in prompt
    assert "<Subject 3>" not in prompt  # a scene is a setting, not a subject
    assert "character sheet" not in prompt
    assert _errors(prompt, "ref2va", 4) == []


def test_ref2va_without_first_frame_starts_pictures_at_one():
    refs = [_ref("<Picture 1>", "Yui (modern schoolgirl)"), _ref("<Picture 2>", "Nihonbashi Bridge", "scene")]
    ctx = MiniMaxH3BeatContext(mode="ref2va", has_first_frame=False, duration_seconds=6.0, references=refs)
    prompt = assemble_minimax_h3_prompt(ctx, _content(2))
    assert "is the first frame" not in prompt
    assert "begins from <Picture 1>" not in prompt
    assert "<Subject 1> is Yui (modern schoolgirl), shown in <Picture 1>" in prompt
    assert _errors(prompt, "ref2va", 2) == []


def test_t2va_has_no_pictures_and_no_alignment_line():
    ctx = MiniMaxH3BeatContext(mode="t2va", has_first_frame=False, duration_seconds=6.0)
    prompt = assemble_minimax_h3_prompt(ctx, _content(0))
    assert "<Picture" not in prompt
    assert prompt.startswith("integrated_multimodal_description:")
    assert _errors(prompt, "t2va", 0) == []


def test_flf2va_references_both_frames():
    ctx = MiniMaxH3BeatContext(mode="flf2va", duration_seconds=6.0)
    prompt = assemble_minimax_h3_prompt(ctx, _content(0))
    assert "<Picture 2> (from [Shot 1]) is fully referenced as the last frame" in prompt
    assert _errors(prompt, "flf2va", 2) == []


def test_fl2va_unchanged_single_picture():
    ctx = MiniMaxH3BeatContext(mode="fl2va", duration_seconds=6.0)
    prompt = assemble_minimax_h3_prompt(ctx, _content(0))
    assert _errors(prompt, "fl2va", 1) == []


# ── plan ────────────────────────────────────────────────────────────────

CANDS = [
    {"key": "identity:Yui_a", "kind": "character", "identity_id": "Yui_a", "name": "Yui (a)", "path": "/x/a.png", "appearance_details": ""},
    {"key": "prop:phone", "kind": "prop", "identity_id": "", "name": "phone", "path": "/x/p.png", "appearance_details": ""},
    {"key": "scene:Bridge", "kind": "scene", "identity_id": "", "name": "Bridge", "path": "/x/s.png", "appearance_details": ""},
]


def _plan(tmp_path: Path, *, render=True, next_render=True, **kw):
    frame = tmp_path / "f.png"
    nxt = tmp_path / "n.png"
    if render:
        frame.write_bytes(b"x")
    if next_render:
        nxt.write_bytes(b"x")
    args = dict(
        requested_mode=None, first_frame_choice=None, last_frame_choice=None,
        frame_path=frame, next_frame_path=nxt, candidates=CANDS, keys=None,
    )
    args.update(kw)
    return _h3_plan_inputs(**args)


def test_auto_with_render_keeps_legacy_behavior_and_leaves_scene_out(tmp_path):
    plan = _plan(tmp_path)
    assert plan["mode"] == "ref2va" and plan["use_first_frame"]
    assert [r["key"] for r in plan["references"]] == ["identity:Yui_a", "prop:phone"]
    assert _h3_picture_count(plan) == 3


def test_auto_without_render_falls_back_to_reference_only_with_scene(tmp_path):
    plan = _plan(tmp_path, render=False)
    assert plan["mode"] == "ref2va" and not plan["use_first_frame"] and plan["error"] == ""
    assert [r["key"] for r in plan["references"]] == ["identity:Yui_a", "prop:phone", "scene:Bridge"]
    assert _h3_picture_count(plan) == 3


def test_ref2va_user_selection_and_legacy_identity_key(tmp_path):
    plan = _plan(tmp_path, requested_mode="ref2va", keys=["Yui_a", "scene:Bridge"])
    assert [r["key"] for r in plan["references"]] == ["identity:Yui_a", "scene:Bridge"]


def test_ref2va_first_frame_none_even_when_render_exists(tmp_path):
    plan = _plan(tmp_path, requested_mode="ref2va", first_frame_choice="none")
    assert not plan["use_first_frame"] and plan["error"] == ""


def test_modes_report_why_they_are_blocked(tmp_path):
    plan = _plan(tmp_path, render=False, next_render=False, requested_mode="fl2va")
    assert plan["error"] == "no_render"
    assert plan["available_modes"]["flf2va"] == "no_render"
    plan = _plan(tmp_path, next_render=False, requested_mode="flf2va")
    assert plan["error"] == "no_next_render"
    plan = _plan(tmp_path, requested_mode="ref2va", keys=[])
    assert plan["error"] == "no_references"


def test_t2va_ignores_frames_and_references(tmp_path):
    plan = _plan(tmp_path, requested_mode="t2va")
    assert plan["mode"] == "t2va" and plan["references"] == [] and _h3_picture_count(plan) == 0


def test_reference_cap_leaves_room_for_first_frame():
    many = [dict(CANDS[0], key=f"identity:{i}", identity_id=str(i)) for i in range(12)]
    assert len(_h3_select_references(many, None, has_first_frame=True)) == 8
    assert len(_h3_select_references(many, None, has_first_frame=False)) == 9


# ── graphs ──────────────────────────────────────────────────────────────


def test_t2va_graph_has_no_frame_inputs():
    g = h3.build_h3_fl2va_graph(
        prompt="p", first_frame_name=None, seed=1, width=768, height=1344, frames=124,
        pdd_file=config.RUNPOD_H3_PDD_FL2VA,
    )
    node = g["24"]["inputs"]
    assert "first_frame" not in node and "last_frame" not in node
    assert "100" not in g


def test_ref2va_without_pin_starts_references_at_ref_image_0_and_pins_nothing():
    g = h3.build_h3_ref2va_graph(
        prompt="p", image_names=["a.png", "b.png"], audio_names=[], seed=1,
        width=768, height=1344, frames=124, pin_first_frame=False,
    )
    assert g["7"]["inputs"]["ref_images.ref_image_0"] == ["100", 0]
    guides = [n for n in g.values() if n["class_type"] == "MiniMaxH3AddGuide"]
    assert guides == []


def test_ref2va_default_still_pins_frame_zero():
    g = h3.build_h3_ref2va_graph(
        prompt="p", image_names=["a.png", "b.png"], audio_names=[], seed=1,
        width=768, height=1344, frames=124,
    )
    guides = [n for n in g.values() if n["class_type"] == "MiniMaxH3AddGuide"]
    assert len(guides) == 1 and guides[0]["inputs"]["frame_idx"] == 0


# ── generator end-to-end up to the upload step ──────────────────────────

import asyncio

from novelvideo.generators import nanobanana_grid
from novelvideo.generators.video_generator import ShotReference


def _gen(tmp_path, monkeypatch, *, image_path, references, h3_mode, last_frame=None):
    monkeypatch.setattr(config, "RUNPOD_API_KEY", "k")
    monkeypatch.setattr(config, "RUNPOD_H3_VIDEO_ENDPOINT_ID", "e")
    monkeypatch.setattr(h3, "_fit_canvas_bytes", lambda data, w, h: data)
    seen: dict = {}

    def fake_upload(payloads):
        seen["names"] = [n for n, _d, _m in payloads]
        raise RuntimeError("stop before network")

    monkeypatch.setattr(nanobanana_grid, "_runpod_upload_inputs_sync", fake_upload)
    result = asyncio.run(
        h3.RunPodMiniMaxH3VideoGenerator().generate(
            image_path=image_path,
            prompt="p",
            output_path=str(tmp_path / "o.mp4"),
            last_frame_path=last_frame,
            references=references,
            h3_mode=h3_mode,
            two_stage=False,
            audio_refine=False,
        )
    )
    return result, seen


def _img(tmp_path, name):
    p = tmp_path / name
    p.write_bytes(b"i")
    return str(p)


def test_generator_ref2va_without_first_frame_uploads_only_references(tmp_path, monkeypatch):
    a, b = _img(tmp_path, "a.png"), _img(tmp_path, "b.png")
    result, seen = _gen(
        tmp_path, monkeypatch, image_path=None, h3_mode="ref2va",
        references=[ShotReference("image", a, ""), ShotReference("image", b, "")],
    )
    assert "stop before network" in (result.error or "")
    assert seen["names"] == ["h3_ref_image_0.png", "h3_ref_image_1.png"]


def test_generator_t2va_uploads_nothing_even_if_images_are_passed(tmp_path, monkeypatch):
    a = _img(tmp_path, "a.png")
    result, seen = _gen(
        tmp_path, monkeypatch, image_path=a, h3_mode="t2va",
        references=[ShotReference("image", a, "")],
    )
    assert seen["names"] == []


def test_generator_flf2va_needs_both_frames(tmp_path, monkeypatch):
    a = _img(tmp_path, "a.png")
    result, _ = _gen(tmp_path, monkeypatch, image_path=a, h3_mode="flf2va", references=[])
    assert "last-frame" in (result.error or "")


def test_generator_auto_without_frame_keeps_old_error(tmp_path, monkeypatch):
    result, _ = _gen(tmp_path, monkeypatch, image_path=None, h3_mode="auto", references=[])
    assert "first-frame" in (result.error or "")


def test_marker_replacement_keeps_spaces_and_unwraps_props():
    from novelvideo.api.routes.generation import _h3_replace_identity_markers

    out = _h3_replace_identity_markers(
        "{{Yui_modern_schoolgirl}} walks in, holding [[phone]] up.",
        {"Yui": {"identities": []}},
    )
    assert out == "Yui walks in, holding phone up."


def test_no_first_frame_embeds_the_beat_description_verbatim():
    refs = [_ref("<Picture 1>", "Yui (modern schoolgirl)")]
    ctx = MiniMaxH3BeatContext(
        mode="ref2va", has_first_frame=False, duration_seconds=6.0, references=refs,
        visual_description="Yui walks into frame, holding phone up, moving through a crowd of Edo-period townspeople and samurai",
    )
    prompt = assemble_minimax_h3_prompt(ctx, _content(1))
    assert "Scene premise: Yui walks into frame, holding phone up, moving through a crowd of Edo-period townspeople and samurai." in prompt
    assert _errors(prompt, "ref2va", 1) == []


def test_with_first_frame_no_premise_is_added():
    ctx = MiniMaxH3BeatContext(mode="fl2va", duration_seconds=6.0, visual_description="anything")
    assert "Scene premise" not in assemble_minimax_h3_prompt(ctx, _content(0))
