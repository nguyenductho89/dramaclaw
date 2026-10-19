"""SageAttention patch node for the shared RunPod ComfyUI worker.

KJNodes' `PathchSageAttentionKJ` patches ComfyUI's attention **globally**
(its own tooltip: to revert, run the node again with the disabled option), so
a Sage-enabled MiniMax H3 job would leave Sage active for the next Qwen job
on the same worker — and Qwen-Image is reported to produce black/noisy output
under Sage. Hence every graph sent to this endpoint carries the patch node
explicitly: the requested mode for H3, `disabled` for Qwen. Everything is a
no-op while `RUNPOD_H3_SAGE_ATTENTION` is empty, so graphs stay byte-for-byte
identical and a worker image without KJNodes keeps working.
"""

from __future__ import annotations

from typing import Any

SAGE_NODE_ID = "900"  # not used by any graph builder ("90" is the mask LoadImage)
SAGE_NODE_CLASS = "PathchSageAttentionKJ"


def sage_mode_requested() -> str:
    """The `sage_attention` value H3 jobs should use ("" = feature off)."""
    from novelvideo.config import RUNPOD_H3_SAGE_ATTENTION

    return (RUNPOD_H3_SAGE_ATTENTION or "").strip()


def apply_sage_patch(graph: dict[str, Any], unet_node_id: str, mode: str) -> dict[str, Any]:
    """Insert a Sage patch node right after the UNET loader and rewire every
    consumer of the loader's MODEL output to the patched model.

    `mode` is the raw `sage_attention` value ("auto", "disabled", ...). An
    empty `mode` leaves the graph untouched.
    """
    if not mode:
        return graph
    if SAGE_NODE_ID in graph:
        raise ValueError(f"graph already has a node {SAGE_NODE_ID}")
    source = [unet_node_id, 0]
    consumers = [
        inputs
        for node in graph.values()
        for inputs in [node.get("inputs", {})]
        if any(value == source for value in inputs.values())
    ]
    graph[SAGE_NODE_ID] = {
        "class_type": SAGE_NODE_CLASS,
        "inputs": {"model": list(source), "sage_attention": mode},
    }
    for inputs in consumers:
        for key, value in inputs.items():
            if value == source:
                inputs[key] = [SAGE_NODE_ID, 0]
    return graph


def sage_disabled_mode() -> str:
    """Value that switches the global patch back off, or "" when the feature
    is off (then no node is added at all)."""
    from novelvideo.config import RUNPOD_SAGE_DISABLED_MODE

    return RUNPOD_SAGE_DISABLED_MODE if sage_mode_requested() else ""
