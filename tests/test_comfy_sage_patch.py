import copy

import pytest

from novelvideo import config
from novelvideo.generators import comfy_sage, nanobanana_grid, runpod_minimax_h3_video as h3


def _h3_ref2va():
    return h3.build_h3_ref2va_graph(
        prompt="p", image_names=["a.png", "b.png"], audio_names=[], seed=1, width=768, height=1344, frames=124
    )


def _h3_fl2va():
    return h3.build_h3_fl2va_graph(prompt="p", first_frame_name="a.png", seed=1, width=768, height=1344, frames=124)


def _qwen_graphs():
    refs = [("r.png", b"x", "image/png")]
    g = nanobanana_grid
    return {
        "qwen_edit_mode": g._runpod_qwen_image_graph("p", 512, 512, 1, refs)[0],
        "qwen_t2i": g._runpod_qwen_image_graph("p", 512, 512, 1, [])[0],
        "qwen21_render": g._runpod_qwen21_render_image_graph("p", "c.png", ["r.png"], 1, steps=4, cfg=1.0),
        "qwen21_render_masked": g._runpod_qwen21_render_image_graph(
            "p", "c.png", ["r.png"], 1, mask_name="m.png", steps=4, cfg=3.0, negative_prompt="n"
        ),
        "edit2511": g._runpod_qwen_edit_image_graph("p", "c.png", ["r.png"], 1),
        "edit2511_masked": g._runpod_qwen_edit_image_graph("p", "c.png", ["r.png"], 1, mask_name="m.png"),
    }


def _consumers(graph, src):
    return sorted(
        k for k, n in graph.items() if k != comfy_sage.SAGE_NODE_ID and src in n["inputs"].values()
    )


@pytest.fixture
def sage_off(monkeypatch):
    monkeypatch.setattr(config, "RUNPOD_H3_SAGE_ATTENTION", "")


@pytest.fixture
def sage_on(monkeypatch):
    monkeypatch.setattr(config, "RUNPOD_H3_SAGE_ATTENTION", "auto")
    monkeypatch.setattr(config, "RUNPOD_SAGE_DISABLED_MODE", "disabled")


def test_off_adds_no_node(sage_off):
    for g in (_h3_ref2va(), _h3_fl2va(), *_qwen_graphs().values()):
        assert comfy_sage.SAGE_NODE_ID not in g


def test_apply_empty_mode_is_noop():
    g = {"1": {"class_type": "UNETLoader", "inputs": {}}, "2": {"class_type": "X", "inputs": {"model": ["1", 0]}}}
    before = copy.deepcopy(g)
    assert comfy_sage.apply_sage_patch(g, "1", "") == before


def test_h3_ref2va_rewires_all_model_consumers(sage_on):
    g = _h3_ref2va()
    node = g[comfy_sage.SAGE_NODE_ID]
    assert node["class_type"] == "PathchSageAttentionKJ"
    assert node["inputs"] == {"model": ["1", 0], "sage_attention": "auto"}
    # nothing but the patch node reads the raw UNET output any more
    assert _consumers(g, ["1", 0]) == []
    assert g["5"]["inputs"]["model"] == [comfy_sage.SAGE_NODE_ID, 0]


def test_h3_fl2va_guider_and_scheduler_use_patched_model(sage_on):
    g = _h3_fl2va()
    assert g[comfy_sage.SAGE_NODE_ID]["inputs"]["model"] == ["20", 0]
    assert g["26"]["inputs"]["model"] == [comfy_sage.SAGE_NODE_ID, 0]
    assert g["28"]["inputs"]["model"] == [comfy_sage.SAGE_NODE_ID, 0]
    assert _consumers(g, ["20", 0]) == []


def test_qwen_graphs_switch_sage_back_off(sage_on):
    for graph in _qwen_graphs().values():
        node = graph[comfy_sage.SAGE_NODE_ID]
        assert node["inputs"]["sage_attention"] == "disabled"
        assert _consumers(graph, ["1", 0]) == []
