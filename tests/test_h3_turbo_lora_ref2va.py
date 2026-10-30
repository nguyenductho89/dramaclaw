"""Turbo LoRA mode for H3 ref2va (`RUNPOD_H3_TURBO_LORA_REF2VA`, 2026-10-30).
Pure graph-shape assertions, no network/GPU."""

from __future__ import annotations

import pytest

from novelvideo.generators import runpod_minimax_h3_video as h3

LORA = "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors"
PDD = "MiniMax-H3-Ref2VA-Acc-8Step.safetensors"


@pytest.fixture(autouse=True)
def _pin_config(monkeypatch):
    import novelvideo.config as cfg

    monkeypatch.setattr(cfg, "RUNPOD_H3_PDD_REF2VA", PDD)
    monkeypatch.setattr(cfg, "RUNPOD_H3_TURBO_LORA_REF2VA", "")
    monkeypatch.setattr(cfg, "RUNPOD_H3_TURBO_STEPS_REF2VA", 6)
    monkeypatch.setattr(cfg, "RUNPOD_H3_SAGE_ATTENTION", "")


def _kwargs(**overrides):
    kwargs = dict(
        prompt="p",
        image_names=["a.png", "b.png"],
        audio_names=[],
        seed=1,
        width=768,
        height=1344,
        frames=124,
    )
    kwargs.update(overrides)
    return kwargs


def test_off_by_default_keeps_pdd_graph():
    g = h3.build_h3_ref2va_graph(**_kwargs())
    assert "70" not in g
    assert g["6"]["inputs"]["pdd_file"] == PDD


def test_turbo_replaces_pdd_with_lora_euler_beta():
    g = h3.build_h3_ref2va_graph(**_kwargs(turbo_lora=LORA, pdd_file=""))
    assert g["70"]["class_type"] == "LoraLoaderModelOnly"
    assert g["70"]["inputs"]["lora_name"] == LORA
    assert g["70"]["inputs"]["model"] == ["1", 0]
    assert "5" not in g and "6" not in g  # no sigma shift / PDD apply
    assert g["8"]["inputs"]["model"] == ["70", 0]
    assert g["9"]["inputs"]["sampler_name"] == "euler"
    sched = g["28"]["inputs"]
    assert (sched["scheduler"], sched["steps"], sched["model"]) == ("beta", 6, ["70", 0])
    assert g["12"]["inputs"]["sigmas"] == ["28", 0]


def test_turbo_reads_config_and_drops_pdd_default(monkeypatch):
    import novelvideo.config as cfg

    monkeypatch.setattr(cfg, "RUNPOD_H3_TURBO_LORA_REF2VA", LORA)
    monkeypatch.setattr(cfg, "RUNPOD_H3_TURBO_STEPS_REF2VA", 4)
    g = h3.build_h3_ref2va_graph(**_kwargs())
    assert g["70"]["inputs"]["lora_name"] == LORA
    assert g["28"]["inputs"]["steps"] == 4
    assert "6" not in g


def test_turbo_with_explicit_pdd_is_rejected():
    with pytest.raises(ValueError, match="mutually exclusive"):
        h3.build_h3_ref2va_graph(**_kwargs(turbo_lora=LORA, pdd_file=PDD))


def test_turbo_with_two_stage_is_rejected():
    with pytest.raises(ValueError, match="two_stage"):
        h3.build_h3_ref2va_graph(**_kwargs(turbo_lora=LORA, pdd_file="", two_stage=True))


def test_audio_refine_uses_lora_model():
    g = h3.build_h3_ref2va_graph(**_kwargs(turbo_lora=LORA, pdd_file="", audio_refine=True))
    assert g["66"]["inputs"]["model"] == ["70", 0]


def test_sage_patch_sits_between_unet_and_lora(monkeypatch):
    import novelvideo.config as cfg

    monkeypatch.setattr(cfg, "RUNPOD_H3_SAGE_ATTENTION", "auto")
    g = h3.build_h3_ref2va_graph(**_kwargs(turbo_lora=LORA, pdd_file=""))
    assert g["70"]["inputs"]["model"] == ["900", 0]
    assert g["900"]["inputs"]["model"] == ["1", 0]
