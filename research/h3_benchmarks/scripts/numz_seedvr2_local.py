"""SeedVR2 upscale through numz/ComfyUI-SeedVR2_VideoUpscaler on the local ComfyUI, to compare with the core-node path
(upscale_video_local.py). The node batches/stitches internally, so one graph handles the whole clip.

  python numz_seedvr2_local.py <src.mp4> <label> --res 1536 [--max-frames 41] [--batch 17] [--overlap 4]
        [--model seedvr2_ema_7b_fp16.safetensors] [--compile none|dit|vae|both] [--compile-mode default] [--attn sdpa]
        [--tile 1024 --tile-overlap 128 | --no-tile] [--repeat 2]
--res is the target SHORT side (1536 -> 2688x1536, 2160 -> 3840x2160 for 16:9). --repeat runs the same graph N times with
cache_model on, so the first run carries model load + torch.compile cost and later runs show steady-state speed.
Writes research/h3_benchmarks/runs/<ts>_<host>_<label>/ (meta, mem.csv, sysmon.csv, comfy.log, result.json with per-run seconds, video.mp4).
"""
import argparse, json, os, socket, subprocess, sys, time, urllib.parse, urllib.request, uuid
from pathlib import Path

T = Path(__file__).resolve().parents[1]; HERE = Path(__file__).resolve().parent
URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
SERVER_LOG = Path(os.environ.get("BENCH_SERVER_LOG", "/opt/bench/comfy_server.log"))


def http(method, path, data=None, headers=None, raw=False):
    req = urllib.request.Request(URL + path, data=data, headers=headers or {}, method=method)
    with urllib.request.urlopen(req, timeout=300) as r:
        body = r.read()
    return body if raw else json.loads(body)


def upload(path, name):
    b = uuid.uuid4().hex
    body = (f"--{b}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\nContent-Type: video/mp4\r\n\r\n").encode() \
        + Path(path).read_bytes() + (f"\r\n--{b}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{b}--\r\n").encode()
    return http("POST", "/upload/image", body, {"Content-Type": f"multipart/form-data; boundary={b}"})["name"]


def graph(a, name):
    comp = {"backend": "inductor", "mode": a.compile_mode, "fullgraph": False, "dynamic": False, "dynamo_cache_size_limit": 64, "dynamo_recompile_limit": 128}
    g = {
        "1": {"class_type": "LoadVideo", "inputs": {"file": name}},
        "2": {"class_type": "GetVideoComponents", "inputs": {"video": ["1", 0]}},
        "3": {"class_type": "SeedVR2LoadDiTModel", "inputs": {"model": a.model, "device": "cuda:0", "blocks_to_swap": a.blocks_to_swap, "swap_io_components": False,
                                                            "offload_device": "cpu", "cache_model": True, "attention_mode": a.attn}},
        "4": {"class_type": "SeedVR2LoadVAEModel", "inputs": {"model": "ema_vae_fp16.safetensors", "device": "cuda:0", "encode_tiled": not a.no_tile,
                                                            "encode_tile_size": a.tile, "encode_tile_overlap": a.tile_overlap, "decode_tiled": not a.no_tile,
                                                            "decode_tile_size": a.tile, "decode_tile_overlap": a.tile_overlap, "tile_debug": "false",
                                                            "offload_device": "cpu", "cache_model": True}},
        "5": {"class_type": "SeedVR2VideoUpscaler", "inputs": {"image": ["2", 0], "dit": ["3", 0], "vae": ["4", 0], "seed": 42, "resolution": a.res, "max_resolution": 0,
                                                             "batch_size": a.batch, "uniform_batch_size": False, "color_correction": "lab",
                                                             "temporal_overlap": a.overlap, "prepend_frames": 0, "input_noise_scale": 0.0, "latent_noise_scale": 0.0,
                                                             "offload_device": "cpu", "enable_debug": True}},
        "6": {"class_type": "CreateVideo", "inputs": {"images": ["5", 0], "fps": ["2", 2], "bit_depth": "auto", "color_space": "sRGB", "codec": "none"}},
        "7": {"class_type": "SaveVideo", "inputs": {"video": ["6", 0], "filename_prefix": "numz_seedvr2", "format": "mp4", "format.codec": "h264",
                                                   "format.codec.encoding": "re-encode", "format.codec.encoding.crf": 10.0, "codec": "auto"}},
    }
    if a.compile in ("dit", "both"):
        g["8"] = {"class_type": "SeedVR2TorchCompileSettings", "inputs": dict(comp)}; g["3"]["inputs"]["torch_compile_args"] = ["8", 0]
    if a.compile in ("vae", "both"):
        g["9"] = {"class_type": "SeedVR2TorchCompileSettings", "inputs": dict(comp)}; g["4"]["inputs"]["torch_compile_args"] = ["9", 0]
    return g


def run(g, timeout):
    pid = http("POST", "/prompt", json.dumps({"prompt": g, "client_id": uuid.uuid4().hex}).encode(), {"Content-Type": "application/json"})["prompt_id"]
    t0 = time.time()
    while time.time() - t0 < timeout:
        time.sleep(2)
        h = http("GET", f"/history/{pid}")
        if pid in h:
            st = h[pid].get("status", {})
            if st.get("status_str") == "error":
                return None, json.dumps(st)[-1500:]
            for node in h[pid].get("outputs", {}).values():
                for v in node.values():
                    for it in v if isinstance(v, list) else []:
                        if isinstance(it, dict) and str(it.get("filename", "")).endswith(".mp4"):
                            return http("GET", "/view?" + urllib.parse.urlencode({k: it.get(k, "") for k in ("filename", "subfolder", "type")}), raw=True), ""
            return None, "no mp4"
    http("POST", "/interrupt", b"{}", {"Content-Type": "application/json"})
    return None, "timeout"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src"); ap.add_argument("label"); ap.add_argument("--res", type=int, default=1536); ap.add_argument("--max-frames", type=int, default=0)
    ap.add_argument("--batch", type=int, default=17); ap.add_argument("--overlap", type=int, default=4)
    ap.add_argument("--model", default="seedvr2_ema_7b_fp16.safetensors"); ap.add_argument("--compile", default="none", choices=["none", "dit", "vae", "both"])
    ap.add_argument("--compile-mode", default="default"); ap.add_argument("--attn", default="sdpa"); ap.add_argument("--blocks-to-swap", type=int, default=0)
    ap.add_argument("--tile", type=int, default=1024); ap.add_argument("--tile-overlap", type=int, default=128); ap.add_argument("--no-tile", action="store_true")
    ap.add_argument("--repeat", type=int, default=2); ap.add_argument("--timeout", type=int, default=7200)
    a = ap.parse_args()
    run_name = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + f"_{socket.gethostname()}_{a.label}"
    D = T / "runs" / run_name; D.mkdir(parents=True, exist_ok=True)
    subprocess.run(["bash", str(HERE / "snapshot_box.sh"), str(D), "/opt/comfyui/models/SEEDVR2"], timeout=600)
    clip = D / "input.mp4"
    cmd = ["ffmpeg", "-v", "error", "-y", "-i", a.src] + (["-frames:v", str(a.max_frames)] if a.max_frames else []) + ["-c:v", "libx264", "-crf", "0", "-preset", "veryfast", "-c:a", "copy", str(clip)]
    subprocess.run(cmd, check=True)
    mon = subprocess.Popen(["bash", str(HERE / "memmon.sh"), str(D / "mem.csv"), "2"])
    smon = subprocess.Popen([sys.executable, str(HERE / "sysmon.py"), str(D / "sysmon.csv"), "2"])
    off = SERVER_LOG.stat().st_size if SERVER_LOG.exists() else None
    res = {"label": a.label, "kind": "numz_seedvr2", **{k: v for k, v in vars(a).items() if k not in ("src",)}, "src": a.src, "runs": [], "error": None}
    try:
        name = upload(clip, f"numz_{uuid.uuid4().hex[:8]}.mp4")
        data = None
        for i in range(a.repeat):
            t = time.time(); data, err = run(graph(a, name), a.timeout)
            res["runs"].append({"i": i, "seconds": round(time.time() - t, 1), "error": err or None}); print(res["runs"][-1], flush=True)
            if err:
                res["error"] = err; break
        if data:
            (D / "video.mp4").write_bytes(data)
    except Exception as e:  # noqa: BLE001
        res["error"] = f"{type(e).__name__}: {e}"
    finally:
        mon.terminate(); smon.terminate()
        if off is not None:
            with SERVER_LOG.open("rb") as f:
                f.seek(off); (D / "comfy.log").write_bytes(f.read())
        (D / "result.json").write_text(json.dumps(res, indent=2))
        subprocess.run(["bash", str(HERE / "postrun.sh"), str(D)], timeout=600)
        print(json.dumps({k: v for k, v in res.items()}, indent=2)); print("run dir:", D)


main()
