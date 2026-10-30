import copy
import json

import pytest

from novelvideo import config
from novelvideo.generators import comfy_lora, comfy_sage
from novelvideo.generators import runpod_minimax_h3_multishot_video as ms
from novelvideo.generators import runpod_minimax_h3_video as h3

LORA = "h3-realism-people-t2v-i2v-r2v.safetensors"


def _ref2va(**kw):
    kw.setdefault("pdd_file", "")
    kw.setdefault("turbo_lora", "" if kw.get("pdd_file") or "turbo_lora" not in kw else kw["turbo_lora"])
    kw.setdefault("realism_lora", "")
    return h3.build_h3_ref2va_graph(
        prompt="p", image_names=["a.png", "b.png"], audio_names=[], seed=1, width=768, height=1344, frames=124, **kw
    )


def _fl2va(**kw):
    kw.setdefault("realism_lora", "")
    return h3.build_h3_fl2va_graph(prompt="p", first_frame_name="a.png", seed=1, width=768, height=1344, frames=124, **kw)


def _consumers(graph, source):
    return [(k, key) for k, n in graph.items() for key, v in n.get("inputs", {}).items() if v == source]


def test_off_leaves_graphs_identical():
    base = _ref2va()
    assert comfy_lora.REALISM_NODE_ID not in base
    assert comfy_lora.apply_model_lora(copy.deepcopy(base), "1", "", 1.0) == base
    assert h3.build_h3_fl2va_graph(prompt="p", first_frame_name="a.png", seed=1, width=768, height=1344, frames=124,
                                   realism_lora="") == _fl2va()


@pytest.mark.parametrize("kw", [{"pdd_file": "x.safetensors"}, {}, {"turbo_lora": "turbo.safetensors", "turbo_steps": 6}])
def test_ref2va_every_unet_consumer_goes_through_the_lora(kw):
    g = _ref2va(realism_lora=LORA, realism_strength=0.7, **kw)
    node = g[comfy_lora.REALISM_NODE_ID]
    assert node["class_type"] == "LoraLoaderModelOnly"
    assert node["inputs"] == {"model": ["1", 0], "lora_name": LORA, "strength_model": 0.7}
    assert _consumers(g, ["1", 0]) == [(comfy_lora.REALISM_NODE_ID, "model")]


def test_fl2va_is_wired_the_same_way():
    g = _fl2va(realism_lora=LORA)
    assert g[comfy_lora.REALISM_NODE_ID]["inputs"]["model"] == ["20", 0]
    assert _consumers(g, ["20", 0]) == [(comfy_lora.REALISM_NODE_ID, "model")]


def test_chain_with_sage_is_unet_sage_lora(monkeypatch):
    monkeypatch.setattr(config, "RUNPOD_H3_SAGE_ATTENTION", "auto")
    g = _ref2va(realism_lora=LORA)
    assert g[comfy_lora.REALISM_NODE_ID]["inputs"]["model"] == [comfy_sage.SAGE_NODE_ID, 0]
    assert g[comfy_sage.SAGE_NODE_ID]["inputs"]["model"] == ["1", 0]
    assert _consumers(g, ["1", 0]) == [(comfy_sage.SAGE_NODE_ID, "model")]


def test_defaults_come_from_config(monkeypatch):
    monkeypatch.setattr(config, "RUNPOD_H3_REALISM_LORA", LORA)
    monkeypatch.setattr(config, "RUNPOD_H3_REALISM_LORA_STRENGTH", 0.6)
    g = h3.build_h3_fl2va_graph(prompt="hello", first_frame_name="a.png", seed=1, width=768, height=1344, frames=124)
    assert g[comfy_lora.REALISM_NODE_ID]["inputs"]["lora_name"] == LORA
    assert g[comfy_lora.REALISM_NODE_ID]["inputs"]["strength_model"] == 0.6


def test_trigger_is_added_once_and_only_when_enabled():
    assert comfy_lora.with_trigger("subject_definitions:\nx", "r34l1sm") == "r34l1sm\nsubject_definitions:\nx"
    already = "r34l1sm\nfoo"
    assert comfy_lora.with_trigger(already, "r34l1sm") == already
    assert comfy_lora.with_trigger("R34L1SM foo", "r34l1sm") == "R34L1SM foo"
    assert comfy_lora.with_trigger("x", "") == "x"
    g = _fl2va(realism_lora=LORA)
    texts = [n["inputs"]["prompt"] for n in g.values() if "prompt" in n.get("inputs", {})]
    assert texts and all(t.startswith("r34l1sm\n") for t in texts)
    off = _fl2va()
    assert all(not n["inputs"]["prompt"].startswith("r34l1sm") for n in off.values() if "prompt" in n.get("inputs", {}))


def test_script_trigger_hits_every_shot_and_stays_valid_json():
    script = ms.join_shots_script(["[Shot 1] a", "[Shot 2] b [x]", "c"])
    out = json.loads(comfy_lora.with_trigger_in_script(script, "r34l1sm"))
    assert [p.split("\n")[0] for p in out["prompts"]] == ["r34l1sm"] * 3
    assert comfy_lora.with_trigger_in_script("plain --- text", "r34l1sm") == "plain --- text"
    assert comfy_lora.with_trigger_in_script(script, "") == script


def _chain(**kw):
    return ms.build_h3_multishot_graph(
        script=ms.join_shots_script(["a", "b"]), shot_count=2, width=768, height=1344, frames_per_shot=124,
        seed=1, steps=8, checkpoint="ref2va", reference_image_names=["r.png"], **kw,
    )


def test_multishot_off_has_no_stack_without_turbo():
    assert "7" not in _chain()


def test_multishot_realism_only_uses_slot_one_and_feeds_the_sampler():
    g = _chain(realism_lora=LORA, realism_strength=0.8, realism_trigger="r34l1sm")
    assert g["7"]["class_type"] == "H3LoraStack"
    assert (g["7"]["inputs"]["lora_1"], g["7"]["inputs"]["strength_1"], g["7"]["inputs"]["lora_2"]) == (LORA, 0.8, "None")
    assert g["10"]["inputs"]["model"] == ["7", 0]
    assert json.loads(g["10"]["inputs"]["script"])["prompts"][1].startswith("r34l1sm\n")


def test_multishot_turbo_plus_realism_fill_two_slots_in_order():
    g = _chain(turbo_lora="turbo.safetensors", realism_lora=LORA, realism_trigger="r34l1sm")
    i = g["7"]["inputs"]
    assert (i["lora_1"], i["lora_2"], i["lora_3"], i["lora_4"]) == ("turbo.safetensors", LORA, "None", "None")
    assert g["10"]["inputs"]["model"] == ["7", 0]
    assert (g["10"]["inputs"]["sampler_name"], g["10"]["inputs"]["scheduler"]) == ("euler", "beta")


def test_multishot_realism_with_pdd_sits_in_front_of_the_pdd_chain():
    g = _chain(realism_lora=LORA, pdd_nfe="8", pdd_file="pdd.safetensors")
    assert g["5"]["inputs"]["model"] == ["7", 0]
    assert g["7"]["inputs"]["model"] == ["1", 0]


def test_sampling_plan_reports_the_realism_lora(monkeypatch):
    monkeypatch.setattr(config, "RUNPOD_H3_REALISM_LORA", LORA)
    monkeypatch.setattr(config, "RUNPOD_H3_REALISM_LORA_STRENGTH", 0.7)
    plan = ms.multishot_sampling_plan("ref2va")
    assert (plan["realism_lora"], plan["realism_strength"], plan["realism_trigger"]) == (LORA, 0.7, "r34l1sm")
    monkeypatch.setattr(config, "RUNPOD_H3_REALISM_LORA", "")
    off = ms.multishot_sampling_plan("fl2va")
    assert not any(k.startswith("realism") for k in off)  # off-state plan is unchanged
