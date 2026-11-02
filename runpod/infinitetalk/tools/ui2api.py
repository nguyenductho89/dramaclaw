"""Convert a ComfyUI UI-format workflow (nodes/links) to API-format prompt JSON.

Usage: python ui2api.py workflow.json object_info.json out_api.json
Handles SetNode/GetNode (KJNodes), Reroute, Note nodes; supports dropping nodes
and bypassing nodes (see DROP / BYPASS below). Prints warnings for any widget
value that does not match the node's declared options.
"""
import json
import sys

SKIP_TYPES = {"Note", "MarkdownNote", "PreviewAny", "SetNode", "GetNode", "Reroute"}
WIDGET_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"}
# node types removed entirely (links from them are dropped)
DROP = {"WanVideoTorchCompileSettings", "MelBandRoFormerModelLoader", "Wav2VecModelLoader"}
# node type -> name of the input whose upstream replaces this node's output 0
BYPASS = {"MelBandRoFormerSampler": "audio"}


def load(path):
    return json.load(open(path))


def is_widget(spec_val):
    t = spec_val[0]
    return isinstance(t, list) or t in WIDGET_TYPES


def convert(ui, oi):
    nodes = {n["id"]: n for n in ui["nodes"]}
    links = {l[0]: l for l in ui["links"]}
    setters = {}
    for n in ui["nodes"]:
        if n["type"] == "SetNode":
            setters[n["widgets_values"][0]] = n

    def origin_of_link(lid, depth=0):
        """Return (node_id, slot) of the real producing node, or None if dropped."""
        if depth > 50 or lid is None:
            return None
        _, oid, oslot, _, _, _ = links[lid]
        o = nodes[oid]
        t = o["type"]
        if t == "GetNode":
            s = setters[o["widgets_values"][0]]
            return origin_of_link(s["inputs"][0]["link"], depth + 1)
        if t == "SetNode":
            return origin_of_link(o["inputs"][0]["link"], depth + 1)
        if t == "Reroute":
            return origin_of_link(o["inputs"][0]["link"], depth + 1)
        if t in DROP:
            return None
        if t in BYPASS:
            for i in o["inputs"]:
                if i["name"] == BYPASS[t]:
                    return origin_of_link(i["link"], depth + 1)
            return None
        return (oid, oslot)

    prompt = {}
    warnings = []
    for n in ui["nodes"]:
        t = n["type"]
        if t in SKIP_TYPES or t in DROP or t in BYPASS:
            continue
        if t not in oi:
            warnings.append(f"node {n['id']} type {t} not in object_info")
            continue
        spec = oi[t]["input"]
        order = list(oi[t].get("input_order", {}).get("required", [])) + list(
            oi[t].get("input_order", {}).get("optional", [])
        )
        allspec = {**spec.get("required", {}), **spec.get("optional", {})}
        raw_wv = n.get("widgets_values")
        wv_named = raw_wv if isinstance(raw_wv, dict) else {}
        wv = list(raw_wv or []) if not isinstance(raw_wv, dict) else []
        inputs = {}
        linked = {i["name"]: i["link"] for i in n.get("inputs", []) if i.get("link") is not None}
        k = 0
        for name in order:
            sv = allspec[name]
            if not is_widget(sv):
                continue
            val = wv_named.get(name) if wv_named else (wv[k] if k < len(wv) else None)
            k += 1
            opts = sv[1] if len(sv) > 1 and isinstance(sv[1], dict) else {}
            if not wv_named and (name in ("seed", "noise_seed") or opts.get("control_after_generate")):
                k += 1
            if name in linked:
                continue
            if val is None:
                if "default" in opts:
                    val = opts["default"]
                elif isinstance(sv[0], list) and sv[0]:
                    val = sv[0][0]
            if isinstance(val, str):
                val = val.replace("\\", "/")
            if isinstance(sv[0], list) and val not in sv[0]:
                warnings.append(f"node {n['id']} {t}.{name}={val!r} not in options")
            inputs[name] = val
        for name, lid in linked.items():
            o = origin_of_link(lid)
            if o is not None:
                inputs[name] = [str(o[0]), o[1]]
            else:
                inputs.pop(name, None)
        # link inputs not listed in n['inputs'] with link (optional unlinked) are simply absent
        prompt[str(n["id"])] = {"class_type": t, "inputs": inputs}

    # drop nodes unreachable from output nodes
    outputs = [i for i, p in prompt.items() if oi.get(p["class_type"], {}).get("output_node")]
    keep, stack = set(), list(outputs)
    while stack:
        i = stack.pop()
        if i in keep:
            continue
        keep.add(i)
        for v in prompt[i]["inputs"].values():
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str) and v[0] in prompt:
                stack.append(v[0])
    prompt = {i: p for i, p in prompt.items() if i in keep}
    return prompt, warnings


if __name__ == "__main__":
    ui, oi = load(sys.argv[1]), load(sys.argv[2])
    p, w = convert(ui, oi)
    json.dump(p, open(sys.argv[3], "w"), indent=1, ensure_ascii=False)
    print(len(p), "nodes in API prompt")
    for x in w:
        print("WARN", x)
