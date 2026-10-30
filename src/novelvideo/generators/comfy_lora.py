"""Realism LoRA for the MiniMax H3 ComfyUI graphs.

`fal/MiniMax-H3-Realism-People-LoRA` (`h3-realism-people-t2v-i2v-r2v.safetensors`,
rank 32, one file for t2v/i2v/r2v) improves skin texture, close-up faces, eyes
and hands. Its model card requires the trigger word `r34l1sm` at the start of
the prompt and gives 1.0 as the intended strength (0.6-0.8 for a lighter touch).

Everything here is a no-op while `RUNPOD_H3_REALISM_LORA` is empty, so graphs
stay byte-for-byte identical when the feature is off. The 1-shot builders use
`apply_model_lora` (same shape as `comfy_sage.apply_sage_patch`: insert one node
right after the UNET loader and rewire every consumer of its MODEL output, so
the LoRA also reaches the PDD / sigma-shift / turbo branches). Multishot goes
through the pack's own `H3LoraStack` instead (see `runpod_minimax_h3_multishot_video`),
and only needs `with_trigger_in_script` and `realism_settings` from here.
"""

from __future__ import annotations

import json
from typing import Any

REALISM_NODE_ID = "901"  # "900" is the Sage patch node, "70" the turbo LoRA


def realism_settings() -> tuple[str, float, str]:
    """(lora file name, strength, trigger word) from config; ("", ...) = off."""
    from novelvideo.config import (
        RUNPOD_H3_REALISM_LORA,
        RUNPOD_H3_REALISM_LORA_STRENGTH,
        RUNPOD_H3_REALISM_TRIGGER,
    )

    return (
        (RUNPOD_H3_REALISM_LORA or "").strip(),
        float(RUNPOD_H3_REALISM_LORA_STRENGTH),
        (RUNPOD_H3_REALISM_TRIGGER or "").strip(),
    )


def with_trigger(prompt: str, trigger: str) -> str:
    """Put the trigger word first, on its own line, exactly once."""
    if not trigger or not prompt:
        return prompt
    if prompt.lstrip().lower().startswith(trigger.lower()):
        return prompt
    return f"{trigger}\n{prompt}"


def with_trigger_in_script(script: str, trigger: str) -> str:
    """`H3MultishotSampler.script` is `{"prompts": [...]}`: every shot gets the
    trigger. A plain `---`-separated script (never produced by DramaClaw, see
    `join_shots_script`) is returned untouched."""
    if not trigger:
        return script
    try:
        data = json.loads(script)
    except (TypeError, ValueError):
        return script
    if not isinstance(data, dict) or not isinstance(data.get("prompts"), list):
        return script
    data["prompts"] = [with_trigger(str(p), trigger) for p in data["prompts"]]
    return json.dumps(data, ensure_ascii=False)


def apply_model_lora(
    graph: dict[str, Any],
    unet_node_id: str,
    lora_name: str,
    strength: float = 1.0,
    node_id: str = REALISM_NODE_ID,
) -> dict[str, Any]:
    """Insert a `LoraLoaderModelOnly` right after the UNET loader and rewire every
    consumer of the loader's MODEL output to it. Empty `lora_name` = untouched."""
    if not lora_name:
        return graph
    if node_id in graph:
        raise ValueError(f"graph already has a node {node_id}")
    source = [unet_node_id, 0]
    consumers = [
        inputs
        for node in graph.values()
        for inputs in [node.get("inputs", {})]
        if any(value == source for value in inputs.values())
    ]
    graph[node_id] = {
        "class_type": "LoraLoaderModelOnly",
        "inputs": {"model": list(source), "lora_name": lora_name, "strength_model": float(strength)},
    }
    for inputs in consumers:
        for key, value in inputs.items():
            if value == source:
                inputs[key] = [node_id, 0]
    return graph
