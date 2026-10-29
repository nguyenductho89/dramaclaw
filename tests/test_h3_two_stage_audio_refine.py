"""Unit tests for the H3 ref2va two-stage (upscale + partial-redraw) and
audio-refine passes added 2026-10-19 — see `runpod-h3-qwen-endpoints.md`
section 4a/4b. Pure graph-shape assertions, no network/GPU."""

from __future__ import annotations

import pytest

from novelvideo.generators import runpod_minimax_h3_video as h3


@pytest.fixture(autouse=True)
def _default_ref2va_pdd(monkeypatch):
    # Pin the shipped default so a local .env with `RUNPOD_H3_PDD_REF2VA=`
    # (base-model mode) doesn't change the graph these tests assert on.
    import novelvideo.config as cfg

    monkeypatch.setattr(cfg, "RUNPOD_H3_PDD_REF2VA", "MiniMax-H3-Ref2VA-Acc-8Step.safetensors")


def _base_kwargs(**overrides):
    kwargs = dict(
        prompt="p",
        image_names=["a.png", "b.png"],
        audio_names=[],
        seed=123,
        width=1344,
        height=768,
        frames=124,
    )
    kwargs.update(overrides)
    return kwargs


def test_stage1_dims_divide_evenly_for_the_formal_profile():
    assert h3.stage1_dims_for_two_stage(1344, 768, 1.5) == (896, 512)
    assert h3.stage1_dims_for_two_stage(768, 1344, 1.5) == (512, 896)


def test_round32_rounds_and_floors_at_32():
    assert h3._round32(900) == 896
    assert h3._round32(10) == 32


def test_default_graph_unchanged_no_stage2_or_refine_nodes():
    g = h3.build_h3_ref2va_graph(**_base_kwargs())
    for node_id in ("60", "61", "62", "63", "64", "65", "66"):
        assert node_id not in g
    assert g["13"]["inputs"]["samples"] == ["12", 0]
    assert g["14"]["inputs"]["samples"] == ["12", 0]
    # pass-1 node "7" uses the final target resolution when two_stage is off
    assert g["7"]["inputs"]["width"] == 1344
    assert g["7"]["inputs"]["height"] == 768


def test_invalid_stage2_nfe_rejected():
    with pytest.raises(ValueError, match="stage2_nfe"):
        h3.build_h3_ref2va_graph(**_base_kwargs(two_stage=True, stage2_nfe="5"))


def test_two_stage_adds_separate_apply_branch_and_leaves_pass1_untouched():
    g = h3.build_h3_ref2va_graph(
        **_base_kwargs(two_stage=True, stage2_nfe="6", stage2_denoise=0.35, stage2_scale_by=1.5)
    )
    # pass 1 runs at the downscaled resolution...
    assert g["7"]["inputs"]["width"] == 896
    assert g["7"]["inputs"]["height"] == 512
    # ...and pass-1's own sampler/Apply branch is completely unchanged.
    assert g["6"]["inputs"]["nfe"] == "8"
    assert g["6"]["inputs"]["model"] == ["5", 0]
    assert g["12"]["inputs"]["latent_image"] == ["7", 1]
    assert g["12"]["inputs"]["sigmas"] == ["6", 1]

    # stage 2 is a SEPARATE Apply branch off the same SigmaShift node "5".
    assert g["61"]["class_type"] == "MiniMaxH3PDDAccApply"
    assert g["61"]["inputs"]["model"] == ["5", 0]
    assert g["61"]["inputs"]["nfe"] == "6"

    assert g["60"] == {
        "class_type": "MiniMaxH3AVLatentUpscaleBy",
        "inputs": {"samples": ["12", 0], "upscale_method": "bislerp", "scale_by": 1.5},
    }
    assert g["62"]["class_type"] == "MiniMaxH3PDDAccScheduler"
    assert g["62"]["inputs"] == {"nfe": "6", "denoise": 0.35}

    final_cond = g["8"]["inputs"]["conditioning"]
    assert g["63"] == {
        "class_type": "BasicGuider",
        "inputs": {"model": ["61", 0], "conditioning": final_cond},
    }
    assert g["65"]["class_type"] == "SamplerCustomAdvanced"
    assert g["65"]["inputs"]["sampler"] == ["9", 0]  # reuses pass-1's euler KSamplerSelect
    assert g["65"]["inputs"]["sigmas"] == ["62", 0]
    assert g["65"]["inputs"]["latent_image"] == ["60", 0]
    assert g["65"]["inputs"]["guider"] == ["63", 0]

    assert g["13"]["inputs"]["samples"] == ["65", 0]
    assert g["14"]["inputs"]["samples"] == ["65", 0]
    assert "66" not in g


def test_audio_refine_alone_wires_pass1_latent_as_context():
    g = h3.build_h3_ref2va_graph(
        **_base_kwargs(audio_refine=True, audio_refine_steps=4, audio_refine_denoise=0.5)
    )
    final_cond = g["8"]["inputs"]["conditioning"]
    assert g["66"] == {
        "class_type": "MiniMaxH3ChainAudioRefineSampler",
        "inputs": {
            "model": ["6", 0],
            "positive": final_cond,
            "negative": final_cond,
            "latent": ["12", 0],
            "context_latent": ["7", 1],
            "seed": 123,
            "steps": 4,
            "cfg": 1.0,
            "sampler_name": "euler",
            "scheduler": "simple",
            "audio_denoise": 0.5,
        },
    }
    assert g["13"]["inputs"]["samples"] == ["66", 0]
    assert g["14"]["inputs"]["samples"] == ["66", 0]
    assert "60" not in g  # no stage 2 requested


def test_audio_refine_after_two_stage_uses_stage2_branch_and_upscaled_context():
    g = h3.build_h3_ref2va_graph(**_base_kwargs(two_stage=True, audio_refine=True))
    assert g["66"]["inputs"]["model"] == ["61", 0]
    assert g["66"]["inputs"]["latent"] == ["65", 0]
    assert g["66"]["inputs"]["context_latent"] == ["60", 0]
    assert g["13"]["inputs"]["samples"] == ["66", 0]
    assert g["14"]["inputs"]["samples"] == ["66", 0]


def test_audio_refine_context_latent_has_no_noise_mask_key_shape_matches():
    # The "no noise_mask -> all-ones mask" trick only works if the shape
    # really matches what's being refined. We can't run the real node here
    # (no torch/comfy deps in this test env), but we can at least assert
    # the context latent always points at a node whose *resolution* is the
    # one actually being refined: "7" (pass-1 width/height) when there is
    # no stage 2, "60" (the upscaled latent, stage-2's own resolution) when
    # there is.
    g_plain = h3.build_h3_ref2va_graph(**_base_kwargs(audio_refine=True))
    assert g_plain["66"]["inputs"]["context_latent"][0] == "7"

    g_two_stage = h3.build_h3_ref2va_graph(**_base_kwargs(two_stage=True, audio_refine=True))
    assert g_two_stage["66"]["inputs"]["context_latent"][0] == "60"


def test_fl2va_graph_has_no_two_stage_or_refine_knobs():
    # fl2va deliberately has no two_stage/audio_refine parameters at all —
    # confirms the function signature doesn't silently accept and ignore
    # them.
    import inspect

    sig = inspect.signature(h3.build_h3_fl2va_graph)
    assert "two_stage" not in sig.parameters
    assert "audio_refine" not in sig.parameters


# ── fl2va PDD (2026-10-21, FL2VA PDD file now on the volume) ──────────────


def _fl2va(**kw):
    from novelvideo.generators.runpod_minimax_h3_video import build_h3_fl2va_graph

    return build_h3_fl2va_graph(
        prompt="p", first_frame_name="f.png", seed=1, width=768, height=1344, frames=124, **kw
    )


def test_fl2va_without_pdd_file_keeps_base_schedule():
    graph = _fl2va()
    assert graph["28"]["class_type"] == "BasicScheduler"
    assert graph["29"]["inputs"]["sigmas"] == ["28", 0]
    assert graph["26"]["inputs"]["model"] == ["20", 0]
    assert "41" not in graph


def test_fl2va_with_pdd_file_uses_pdd_model_and_sigmas():
    graph = _fl2va(pdd_file="MiniMax-H3-FL2VA-Acc-8Step.safetensors", pdd_steps=8)
    assert graph["40"]["class_type"] == "MiniMaxH3SigmaShift"
    assert graph["41"]["inputs"]["pdd_file"] == "MiniMax-H3-FL2VA-Acc-8Step.safetensors"
    assert graph["41"]["inputs"]["nfe"] == "8"
    assert graph["26"]["inputs"]["model"] == ["41", 0]
    assert graph["29"]["inputs"]["sigmas"] == ["41", 1]
    assert graph["27"]["inputs"]["sampler_name"] == "euler"
    assert "28" not in graph


def test_ref2va_without_pdd_file_samples_base_model():
    g = h3.build_h3_ref2va_graph(**_base_kwargs(pdd_file=""))
    assert not any(
        n["class_type"].startswith(("MiniMaxH3PDD", "MiniMaxH3SigmaShift")) for n in g.values()
    )
    assert g["8"]["inputs"]["model"] == ["1", 0]
    assert g["9"]["inputs"]["sampler_name"] == "res_multistep"
    assert g["28"]["class_type"] == "BasicScheduler"
    assert g["28"]["inputs"]["steps"] == 20
    assert g["12"]["inputs"]["sigmas"] == ["28", 0]


def test_ref2va_with_explicit_pdd_file_uses_it():
    g = h3.build_h3_ref2va_graph(**_base_kwargs(pdd_file="custom.safetensors"))
    assert g["6"]["inputs"]["pdd_file"] == "custom.safetensors"
    assert g["8"]["inputs"]["model"] == ["6", 0]
    assert "28" not in g


def test_ref2va_without_pdd_rejects_two_stage():
    with pytest.raises(ValueError, match="two_stage needs PDD"):
        h3.build_h3_ref2va_graph(**_base_kwargs(pdd_file="", two_stage=True))


def test_ref2va_without_pdd_audio_refine_uses_base_model():
    g = h3.build_h3_ref2va_graph(**_base_kwargs(pdd_file="", audio_refine=True))
    assert g["66"]["inputs"]["model"] == ["1", 0]
