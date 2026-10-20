"""Unit tests for the H3 Multishot graph builder (added 2026-10-19) — see
`runpod-h3-qwen-endpoints.md` section 5. Pure graph-shape assertions, no
network/GPU."""

from __future__ import annotations

import pytest

from novelvideo.generators import runpod_minimax_h3_multishot_video as ms


def test_dims_land_on_32px_grid():
    w, h = ms.dims_for_multishot("16:9", "formal")
    assert w % 32 == 0 and h % 32 == 0
    assert (w, h) == (1344, 768)
    w, h = ms.dims_for_multishot("9:16", "formal")
    assert (w, h) == (768, 1344)


def test_frames_for_shot_narration_can_use_the_short_end():
    assert ms.frames_for_shot(5.0, is_dialogue=False) == 124


def test_frames_for_shot_dialogue_has_a_higher_floor():
    # A short dialogue beat must not land below 192 frames, even though the
    # same duration would be fine at 124 for plain narration.
    assert ms.frames_for_shot(5.0, is_dialogue=True) >= 192
    assert ms.frames_for_shot(5.0, is_dialogue=True) % 17 == 5 % 17 or True  # stays on the 17k+5 grid
    assert (ms.frames_for_shot(5.0, is_dialogue=True) - 5) % 17 == 0


def test_frames_for_shot_clamped_to_v1_ceiling():
    assert ms.frames_for_shot(60.0, is_dialogue=False) == ms._SHOT_FRAME_GRID_MAX


def test_join_shots_script_is_json_prompts_list():
    import json

    script = ms.join_shots_script([" a ", "b", "c"])
    assert json.loads(script) == {"prompts": ["a", "b", "c"]}


def test_join_shots_script_survives_bracket_led_prompts():
    """Regression for real job ad485558: the pack treats a script whose
    first char is `[`/`{` as JSON, and every H3 prompt starts `[Shot 1]`.
    The JSON form must round-trip such prompts (and stray `---` lines)
    exactly."""
    import json

    prompts = ["[Shot 1] Tiếng Việt <d>[Vietnamese] chào</d>", "[Shot 1] b\n---\nnot a split"]
    script = ms.join_shots_script(prompts)
    assert script.startswith("{")
    assert json.loads(script)["prompts"] == prompts


def _base_kwargs(**overrides):
    kwargs = dict(
        script="a\n---\nb",
        shot_count=2,
        width=768,
        height=1344,
        frames_per_shot=124,
        seed=7,
        steps=20,
    )
    kwargs.update(overrides)
    return kwargs


def test_shot_count_out_of_range_rejected():
    with pytest.raises(ValueError, match="shot_count"):
        ms.build_h3_multishot_graph(**_base_kwargs(shot_count=0))
    with pytest.raises(ValueError, match="shot_count"):
        ms.build_h3_multishot_graph(**_base_kwargs(shot_count=9))


def test_dims_not_multiple_of_32_rejected():
    with pytest.raises(ValueError, match="multiple"):
        ms.build_h3_multishot_graph(**_base_kwargs(width=760))


def test_fl2va_rejects_reference_images_and_voice_ref():
    with pytest.raises(ValueError, match="ref2va"):
        ms.build_h3_multishot_graph(
            **_base_kwargs(checkpoint="fl2va", reference_image_names=["r.png"])
        )
    with pytest.raises(ValueError, match="ref2va"):
        ms.build_h3_multishot_graph(**_base_kwargs(checkpoint="fl2va", voice_ref_names=["v.wav"]))
    with pytest.raises(ValueError, match="ref2va"):
        ms.build_h3_multishot_graph(**_base_kwargs(checkpoint="fl2va", self_anchor_voice=True))


def test_too_many_voice_refs_rejected():
    with pytest.raises(ValueError, match="3 voice_ref"):
        ms.build_h3_multishot_graph(
            **_base_kwargs(checkpoint="ref2va", voice_ref_names=["a.wav", "b.wav", "c.wav", "d.wav"])
        )


def test_fl2va_graph_uses_fl2va_unet_and_no_pin_frames_anywhere():
    from novelvideo import config

    g = ms.build_h3_multishot_graph(**_base_kwargs(checkpoint="fl2va"))
    assert g["1"]["class_type"] == "H3ModelLoaderAny"
    assert g["1"]["inputs"]["model_name"] == config.RUNPOD_H3_UNET_FL2VA
    assert g["2"]["class_type"] == "H3ClipLoaderAny"
    assert g["2"]["inputs"]["type"] == "minimax"
    sampler = g["10"]
    assert sampler["class_type"] == "H3MultishotSampler"
    assert "pin_frames" not in sampler["inputs"]
    assert sampler["inputs"]["save_every_shot"] is True
    assert sampler["inputs"]["script"] == "a\n---\nb"
    assert sampler["inputs"]["shot_count"] == 2
    # H3ChainNormalize sits between the sampler's images output and
    # CreateVideo.
    assert g["20"]["class_type"] == "H3ChainNormalize"
    assert g["20"]["inputs"]["images"] == ["10", 0]
    assert g["30"]["inputs"]["images"] == ["20", 0]
    assert g["30"]["inputs"]["audio"] == ["10", 1]
    assert g["31"]["class_type"] == "SaveVideo"


def test_ref2va_graph_uses_ref2va_unet():
    from novelvideo import config

    g = ms.build_h3_multishot_graph(**_base_kwargs(checkpoint="ref2va"))
    assert g["1"]["inputs"]["model_name"] == config.RUNPOD_H3_UNET_REF2VA


def test_start_image_wired_when_given():
    g = ms.build_h3_multishot_graph(**_base_kwargs(start_image_name="first.png"))
    assert g["100"] == {"class_type": "LoadImage", "inputs": {"image": "first.png"}}
    assert g["10"]["inputs"]["start_image"] == ["100", 0]


def test_no_start_image_means_no_start_image_input_at_all():
    g = ms.build_h3_multishot_graph(**_base_kwargs())
    assert "100" not in g
    assert "start_image" not in g["10"]["inputs"]


def test_single_reference_image_wired_directly_without_batching():
    g = ms.build_h3_multishot_graph(
        **_base_kwargs(checkpoint="ref2va", reference_image_names=["r0.png"])
    )
    assert g["110"] == {"class_type": "LoadImage", "inputs": {"image": "r0.png"}}
    assert g["10"]["inputs"]["reference_images"] == ["110", 0]
    assert not any(n["class_type"] == "ImageBatch" for n in g.values() if isinstance(n, dict))


def test_multiple_reference_images_folded_through_image_batch():
    g = ms.build_h3_multishot_graph(
        **_base_kwargs(checkpoint="ref2va", reference_image_names=["r0.png", "r1.png", "r2.png"])
    )
    assert g["110"]["inputs"]["image"] == "r0.png"
    assert g["111"]["inputs"]["image"] == "r1.png"
    assert g["112"]["inputs"]["image"] == "r2.png"
    # 2 images folded pairwise -> exactly 2 ImageBatch nodes for 3 images.
    batch_nodes = [k for k, n in g.items() if n["class_type"] == "ImageBatch"]
    assert len(batch_nodes) == 2
    assert g["121"]["inputs"] == {"image1": ["110", 0], "image2": ["111", 0]}
    assert g["122"]["inputs"] == {"image1": ["121", 0], "image2": ["112", 0]}
    assert g["10"]["inputs"]["reference_images"] == ["122", 0]


def test_voice_refs_wired_to_correct_slots_in_order():
    g = ms.build_h3_multishot_graph(
        **_base_kwargs(checkpoint="ref2va", voice_ref_names=["v0.wav", "v1.wav"])
    )
    assert g["200"] == {"class_type": "LoadAudio", "inputs": {"audio": "v0.wav"}}
    assert g["201"] == {"class_type": "LoadAudio", "inputs": {"audio": "v1.wav"}}
    assert g["10"]["inputs"]["voice_ref"] == ["200", 0]
    assert g["10"]["inputs"]["voice_ref_2"] == ["201", 0]
    assert "voice_ref_3" not in g["10"]["inputs"]


def test_new_seed_is_uint32_range():
    seed = ms.new_seed()
    assert 0 <= seed <= 0xFFFFFFFF


# ── PDD acceleration (2026-10-20) ─────────────────────────────────────────


def _pdd_graph(**overrides):
    kwargs = dict(
        script="a\n---\nb",
        shot_count=2,
        width=768,
        height=1344,
        frames_per_shot=124,
        seed=1,
        steps=8,
        checkpoint="ref2va",
        pdd_nfe="8",
        pdd_file="MiniMax-H3-Ref2VA-Acc-8Step.safetensors",
    )
    kwargs.update(overrides)
    return ms.build_h3_multishot_graph(**kwargs)


def test_pdd_wires_patched_model_and_trained_sigmas_into_sampler():
    graph = _pdd_graph()
    assert graph["5"]["class_type"] == "MiniMaxH3SigmaShift"
    assert graph["5"]["inputs"]["model"] == ["1", 0]
    assert graph["6"]["class_type"] == "MiniMaxH3PDDAccApply"
    assert graph["6"]["inputs"]["nfe"] == "8"
    assert graph["6"]["inputs"]["on_off_grid"] == "error"
    sampler = graph["10"]["inputs"]
    assert sampler["model"] == ["6", 0]
    assert sampler["sigmas"] == ["6", 1]
    assert sampler["sampler_name"] == "euler"
    assert sampler["steps"] == 8


def test_no_pdd_keeps_base_model_and_no_sigmas():
    graph = _pdd_graph(pdd_nfe="", pdd_file="", steps=20)
    assert "5" not in graph and "6" not in graph
    assert graph["10"]["inputs"]["model"] == ["1", 0]
    assert "sigmas" not in graph["10"]["inputs"]


def test_pdd_rejects_off_grid_nfe_and_missing_file():


    with pytest.raises(ValueError):
        _pdd_graph(pdd_nfe="10")
    with pytest.raises(ValueError):
        _pdd_graph(pdd_file="")


def test_output_scale_only_set_when_above_one():
    assert "output_scale" not in _pdd_graph()["10"]["inputs"]
    assert _pdd_graph(output_scale=1.5)["10"]["inputs"]["output_scale"] == 1.5


def test_sampling_plan_ref2va_uses_pdd_fl2va_falls_back_without_file(monkeypatch):
    import novelvideo.config as cfg
    from novelvideo.generators.runpod_minimax_h3_multishot_video import multishot_sampling_plan

    monkeypatch.setattr(cfg, "RUNPOD_H3_MULTISHOT_PDD_NFE", "8")
    monkeypatch.setattr(cfg, "RUNPOD_H3_PDD_FL2VA", "")
    ref = multishot_sampling_plan("ref2va")
    assert ref["pdd_nfe"] == "8" and ref["steps"] == 8 and ref["pdd_file"]
    fl = multishot_sampling_plan("fl2va")
    assert fl == {"pdd_nfe": "", "pdd_file": "", "steps": 20, "output_scale": 1.0}

    monkeypatch.setattr(cfg, "RUNPOD_H3_PDD_FL2VA", "MiniMax-H3-FL2VA-Acc-8Step.safetensors")
    assert multishot_sampling_plan("fl2va")["pdd_file"].startswith("MiniMax-H3-FL2VA")

    monkeypatch.setattr(cfg, "RUNPOD_H3_MULTISHOT_PDD_NFE", "")
    assert multishot_sampling_plan("ref2va")["steps"] == 20
