"""Standalone test for H3MultishotMemorySampler (PLAN_h3_memory_sampler_antidrift.md, Phase 1) against a LOCAL
ComfyUI (rented 4090/5090 box), separate from run_batch.sh — production keeps using the classic
H3MultishotSampler (build_h3_multishot_graph) until this is verified with real render results.

Reuses chain_01's 4 orchard shots verbatim from chain_01_refs_only.json (the scene is conveyed by each shot's own
prompt text only, same as that baseline — H3MultishotMemorySampler's reference_images are SUBJECT refs, not a
background plate), but swaps the two 2-up character sheets for 4 single-angle crops (2 per person: the existing
*_front.png "facing the lens" half, plus the sheet's other "turned" half, cut here from the sheet PNGs already on
disk — no new permanent character asset, just a scratch crop) with reference_subjects="2,2", and
continuity=latent_handoff (the only memory-sampler mode that needs no extra ComfyUI pack beyond what
setup_h3_box.sh --with-ref2va already installs — see PLAN_h3_memory_sampler_antidrift.md for why first_frame and
context_pin are not options here).

  python3 research/h3_benchmarks/scripts/bench_memory_sampler.py [chain_json_name_in_this_dir]

The chain is the JSON in this directory (default bench_memory_sampler_chain.json, a frozen copy of the gravity test's
four-shot refs-only chain).

Env: COMFY_URL (default http://127.0.0.1:8188), BENCH_TIMEOUT_S (default 10800), BENCH_CONTINUITY (default
latent_handoff — pass "cut" to render the same inputs through the memory sampler's own baseline mode for a 3-way
comparison), BENCH_SEED (default 1234, same as bench_multishot30_local.py for an apples-to-apples seed).

Writes research/h3_benchmarks/runs/<UTC ts>_<host>_memory_sampler_<continuity>/{graph.json,result.json,video.mp4}.
"""
import json, os, socket, sys, time, urllib.parse, urllib.request, uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
R = HERE.parents[2]
CHAR = R / "video_production_with_skills/series/science_humor/assets/characters"
URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
TIMEOUT = float(os.environ.get("BENCH_TIMEOUT_S", "10800"))
CONTINUITY = os.environ.get("BENCH_CONTINUITY", "latent_handoff")
SEED = int(os.environ.get("BENCH_SEED", "1234"))
CHAIN = sys.argv[1] if len(sys.argv) > 1 else "bench_memory_sampler_chain"

sys.path.insert(0, str(R / "src"))
from novelvideo.generators.runpod_minimax_h3_multishot_video import (  # noqa: E402
    build_h3_multishot_memory_graph, dims_for_multishot, join_shots_script)


def http(method, path, data=None, headers=None, raw=False):
    req = urllib.request.Request(URL + path, data=data, headers=headers or {}, method=method)
    with urllib.request.urlopen(req, timeout=120) as r:
        body = r.read()
    return body if raw else json.loads(body)


def upload_image(path: Path, name: str) -> str:
    b = uuid.uuid4().hex
    body = (f"--{b}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\nContent-Type: image/png\r\n\r\n").encode() \
        + path.read_bytes() + (f"\r\n--{b}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{b}--\r\n").encode()
    return http("POST", "/upload/image", body, {"Content-Type": f"multipart/form-data; boundary={b}"})["name"]


def crop_turned_half(sheet_path: Path, facing_is_left: bool, out_path: Path) -> Path:
    """The sheet is two views side by side at the same size (see the `sheets` prompts in image_prompts.json): the half NOT
    used by *_front.png (the "facing the lens" half) is the "turned toward left/right" half — cut it here rather
    than permanently adding a new character asset, since this is a Phase 1 experiment only."""
    import struct
    data = sheet_path.read_bytes()
    w, h = struct.unpack(">II", data[16:24])
    from PIL import Image
    im = Image.open(sheet_path)
    half = w // 2
    box = (half, 0, w, h) if facing_is_left else (0, 0, half, h)
    im.crop(box).save(out_path)
    return out_path


def main():
    chain = json.loads((HERE / f"{CHAIN}.json").read_text())
    shots = chain["shots"]
    frames = int(chain["frames"])
    aspect = chain["aspect_ratio"]
    voice_refs = chain["voice_refs"]

    scratch = HERE / "memory_sampler_scratch"
    scratch.mkdir(exist_ok=True)
    # barnaby_front.png is the LEFT half (facing the lens) per SHEETS["barnaby"]; ambrose_front.png is the RIGHT
    # half per SHEETS["ambrose"] (order is reversed between the two characters) — see image_prompts.json.
    barnaby_turned = crop_turned_half(CHAR / "barnaby_sheet.png", facing_is_left=True, out_path=scratch / "barnaby_turned.png")
    ambrose_turned = crop_turned_half(CHAR / "ambrose_sheet.png", facing_is_left=False, out_path=scratch / "ambrose_turned.png")

    w, h = dims_for_multishot(aspect)
    name_map = {
        "barnaby_front": CHAR / "barnaby_front.png",
        "barnaby_turned": barnaby_turned,
        "ambrose_front": CHAR / "ambrose_front.png",
        "ambrose_turned": ambrose_turned,
    }
    uploaded = {k: upload_image(p, f"ms_{k}.png") for k, p in name_map.items()}
    reference_names = [uploaded["barnaby_front"], uploaded["barnaby_turned"], uploaded["ambrose_front"], uploaded["ambrose_turned"]]
    voice_names = [upload_image(R / v, f"ms_voice_{k}{Path(v).suffix}") for k, v in enumerate(voice_refs)]

    # Turbo LoRA from the chain JSON (same 12-step distill the classic path used); BENCH_TURBO=0 renders the base 20 steps.
    turbo_lora = "" if os.environ.get("BENCH_TURBO") == "0" else str(chain.get("turbo_lora") or "")
    steps = int(chain.get("turbo_steps") or 12) if turbo_lora else 20

    graph = build_h3_multishot_memory_graph(
        script=join_shots_script(shots), shot_count=len(shots), width=w, height=h, frames_per_shot=frames,
        seed=SEED, steps=steps, checkpoint="ref2va", continuity=CONTINUITY, turbo_lora=turbo_lora,
        reference_image_names=reference_names, reference_subjects="2,2", voice_ref_names=voice_names,
        master_normalize="luma+contrast", memory_frames=0, anchor_frames=1, bank_pinned=1)

    # default mode keeps the `_ms` suffix; other continuity modes get their own label.
    tag = "ms" if CONTINUITY == "latent_handoff" else f"ms_{CONTINUITY}"
    run = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + f"_{socket.gethostname()}_memory_sampler_{CHAIN}_{tag}"
    D = R / "research/h3_benchmarks/runs" / run
    D.mkdir(parents=True, exist_ok=True)
    (D / "graph.json").write_text(json.dumps(graph, indent=2, ensure_ascii=False))

    rec = {"label": f"memory_sampler_{CONTINUITY}", "chain": CHAIN, "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "run_dir": D.name, "comfy_url": URL, "resolution": f"{w}x{h}", "aspect_ratio": aspect, "shots": len(shots),
           "frames_per_shot": frames, "continuity": CONTINUITY, "seed": SEED, "turbo_lora": turbo_lora, "steps": steps, "logs": []}
    live = open(D / "live.log", "a")
    t0 = time.time()

    def log(m):
        line = f"{time.time() - t0:7.1f}s {m}"; rec["logs"].append(line); live.write(line + "\n"); live.flush()

    resp = http("POST", "/prompt", json.dumps({"prompt": graph, "client_id": uuid.uuid4().hex}).encode(), {"Content-Type": "application/json"})
    pid = resp["prompt_id"]
    if resp.get("node_errors"):
        log(f"node_errors: {json.dumps(resp['node_errors'])[:1500]}")
    log(f"submitted prompt {pid}")
    last = ""
    err, out = "", None
    while time.time() - t0 < TIMEOUT:
        time.sleep(5)
        try:
            hist = http("GET", f"/history/{pid}")
        except Exception as e:  # noqa: BLE001
            log(f"poll error: {e}"); continue
        if pid in hist:
            st = hist[pid].get("status", {})
            for ev in st.get("messages", []):
                log(f"event {ev[0]} {json.dumps(ev[1], default=str)[:300] if len(ev) > 1 else ''}")
            if st.get("status_str") == "error" or not st.get("completed", True):
                err = json.dumps(st)[:1500]
            out = hist[pid].get("outputs", {})
            break
        q = http("GET", "/queue")
        state = f"running={len(q['queue_running'])} pending={len(q['queue_pending'])}"
        if state != last:
            log(state); last = state
    else:
        err = f"timeout after {TIMEOUT:.0f}s"
        http("POST", "/interrupt", b"{}", {"Content-Type": "application/json"})

    data = b""
    for node in (out or {}).values():
        for v in node.values():
            for item in v if isinstance(v, list) else []:
                if isinstance(item, dict) and str(item.get("filename", "")).endswith(".mp4"):
                    q = urllib.parse.urlencode({k: item.get(k, "") for k in ("filename", "subfolder", "type")})
                    data = http("GET", f"/view?{q}", raw=True)
    if not data and not err:
        err = "completed but no mp4 output"
    rec.update(wall_seconds=round(time.time() - t0, 1), error=err or None, video_bytes=len(data))
    if data:
        (D / "video.mp4").write_bytes(data)
    (D / "result.json").write_text(json.dumps(rec, indent=2, ensure_ascii=False, default=str))
    print(json.dumps({k: v for k, v in rec.items() if k != "logs"}, indent=2, default=str))
    print(f"run dir: {D}")


if __name__ == "__main__":
    main()
