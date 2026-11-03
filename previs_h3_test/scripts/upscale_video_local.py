"""SeedVR2 video upscale on the LOCAL ComfyUI (rented box), chunked like generators/runpod_seedvr2_upscale.py but no RunPod/R2.

  python upscale_video_local.py <src.mp4> <label> --target 2k|4k|WxH [--model 7b|3b] [--max-frames N] [--segment 41] [--overlap 8]
Targets: 2k = 2x (2688x1536 for a 1344x768 source), 4k = 3840x2160. --max-frames N upscales only the first N frames (test mode,
no audio). Segment outputs are cached under <run_dir>/segs so a rerun with --work-dir resumes. Writes a run dir under
previs_h3_test/runs/ with meta/mem/sysmon/comfy.log/steps/result.json (per-segment seconds) and video.mp4.
"""
import argparse, json, os, socket, subprocess, sys, time, urllib.parse, urllib.request, uuid
from pathlib import Path

R = Path(__file__).resolve().parents[2]; T = R / "previs_h3_test"; HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(R / "src"))
from novelvideo.generators.runpod_seedvr2_upscale import (  # noqa: E402
    SEEDVR2_3B_UNET, SEEDVR2_7B_UNET, build_seedvr2_segment_graph, cut_resized_segment, iter_stitched, plan_segments,
    probe_video, read_frames, write_video_stream, _even)

URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
SERVER_LOG = Path(os.environ.get("BENCH_SERVER_LOG", "/opt/bench/comfy_server.log"))
MODELS = os.environ.get("BENCH_MODELS", "/opt/models")


def http(method, path, data=None, headers=None, raw=False):
    req = urllib.request.Request(URL + path, data=data, headers=headers or {}, method=method)
    with urllib.request.urlopen(req, timeout=300) as r:
        body = r.read()
    return body if raw else json.loads(body)


def upload(path: Path, name: str) -> str:
    b = uuid.uuid4().hex
    body = (f"--{b}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\nContent-Type: video/mp4\r\n\r\n").encode() \
        + path.read_bytes() + (f"\r\n--{b}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{b}--\r\n").encode()
    return http("POST", "/upload/image", body, {"Content-Type": f"multipart/form-data; boundary={b}"})["name"]


def run_graph(graph, timeout):
    pid = http("POST", "/prompt", json.dumps({"prompt": graph, "client_id": uuid.uuid4().hex}).encode(), {"Content-Type": "application/json"})["prompt_id"]
    t0 = time.time()
    while time.time() - t0 < timeout:
        time.sleep(3)
        h = http("GET", f"/history/{pid}")
        if pid in h:
            st = h[pid].get("status", {})
            if st.get("status_str") == "error":
                return None, json.dumps(st)[:1500]
            for node in h[pid].get("outputs", {}).values():
                for v in node.values():
                    for it in v if isinstance(v, list) else []:
                        if isinstance(it, dict) and str(it.get("filename", "")).endswith(".mp4"):
                            q = urllib.parse.urlencode({k: it.get(k, "") for k in ("filename", "subfolder", "type")})
                            return http("GET", f"/view?{q}", raw=True), ""
            return None, "no mp4 output"
    http("POST", "/interrupt", b"{}", {"Content-Type": "application/json"})
    return None, f"timeout {timeout}s"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src"); ap.add_argument("label"); ap.add_argument("--target", default="2k")
    ap.add_argument("--model", choices=["7b", "3b"], default="7b"); ap.add_argument("--max-frames", type=int, default=0)
    ap.add_argument("--segment", type=int, default=41); ap.add_argument("--overlap", type=int, default=8)
    ap.add_argument("--vae-tframes", type=int, default=64); ap.add_argument("--dit-chunk", type=int, default=0); ap.add_argument("--dit-chunk-overlap", type=int, default=1)
    ap.add_argument("--tile", type=int, default=512); ap.add_argument("--tile-overlap", type=int, default=128)
    ap.add_argument("--seed", type=int, default=42); ap.add_argument("--color", default="lab"); ap.add_argument("--timeout", type=int, default=3600)
    a = ap.parse_args()
    sw, sh, fps, total = probe_video(a.src)
    if a.target == "2k": ow, oh = _even(sw * 2), _even(sh * 2)
    elif a.target == "4k": ow, oh = 3840, 2160
    else: ow, oh = map(int, a.target.lower().split("x"))
    n = min(total, a.max_frames) if a.max_frames else total
    segs = plan_segments(n, a.segment, a.overlap)
    unet = SEEDVR2_7B_UNET if a.model == "7b" else SEEDVR2_3B_UNET

    run = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + f"_{socket.gethostname()}_{a.label}"
    D = T / "runs" / run; (D / "segs").mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(["bash", str(HERE / "snapshot_box.sh"), str(D), MODELS], check=True, timeout=600)
    except Exception as e:  # noqa: BLE001
        print("snapshot failed:", e)
    mon = subprocess.Popen(["bash", str(HERE / "memmon.sh"), str(D / "mem.csv"), "2"])
    smon = subprocess.Popen([sys.executable, str(HERE / "sysmon.py"), str(D / "sysmon.csv"), "2"])
    off = SERVER_LOG.stat().st_size if SERVER_LOG.exists() else None
    res = {"label": a.label, "kind": "seedvr2_upscale", "src": a.src, "src_res": f"{sw}x{sh}", "out_res": f"{ow}x{oh}", "model": a.model, "frames": n,
           "total_frames": total, "segment": a.segment, "overlap": a.overlap, "color": a.color, "tile": a.tile, "tile_overlap": a.tile_overlap, "vae_tframes": a.vae_tframes, "dit_chunk": a.dit_chunk, "dit_chunk_overlap": a.dit_chunk_overlap, "segments": [], "error": None,
           "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    t0 = time.time()
    try:
        outs = []
        for i, seg in enumerate(segs):
            done = D / "segs" / f"seg_{i:04d}.mp4"; outs.append(done)
            ts = time.time()
            inp = D / "segs" / f"in_{i:04d}.mp4"
            cut_resized_segment(a.src, inp, seg, ow, oh, fps)
            name = f"svr2_{uuid.uuid4().hex[:10]}.mp4"
            tu = time.time(); upload(inp, name)
            g = build_seedvr2_segment_graph(video_name=name, unet_name=unet, seed=a.seed, color_correction=a.color, tile_size=a.tile,
                                            tile_overlap=a.tile_overlap, temporal_size=a.vae_tframes)
            if a.dit_chunk:  # DiT in temporal chunks inside one graph (core nodes); VAE still sees the whole segment
                g["13"] = {"class_type": "SeedVR2TemporalChunk", "inputs": {"latent": ["6", 0], "temporal_overlap": a.dit_chunk_overlap,
                                                                          "chunking_mode": "manual", "chunking_mode.frames_per_chunk": a.dit_chunk}}
                g["7"]["inputs"]["vae_conditioning"] = ["13", 0]
                g["8"]["inputs"]["latent_image"] = ["13", 0]
                g["14"] = {"class_type": "SeedVR2TemporalMerge", "inputs": {"latents": ["8", 0], "temporal_overlap": ["13", 1]}}
                g["9"]["inputs"]["samples"] = ["14", 0]
            data, err = run_graph(g, a.timeout)
            if err or not data:
                res["error"] = f"segment {i}: {err}"; break
            done.write_bytes(data)
            res["segments"].append({"i": i, "frames": f"{seg.start}-{seg.end - 1}", "seconds": round(time.time() - ts, 1), "gpu_seconds": round(time.time() - tu, 1)})
            print(res["segments"][-1], flush=True)
        if not res["error"]:
            audio = a.src if not a.max_frames else None
            write_video_stream(iter_stitched(segs, (read_frames(p) for p in outs)), fps, D / "video.mp4", audio, width=ow, height=oh, total_frames=n)
    except Exception as e:  # noqa: BLE001
        res["error"] = f"{type(e).__name__}: {e}"
    finally:
        mon.terminate(); smon.terminate()
        if off is not None:
            with SERVER_LOG.open("rb") as f:
                f.seek(off); (D / "comfy.log").write_bytes(f.read())
        res["wall_seconds"] = round(time.time() - t0, 1)
        segs_s = [s["seconds"] for s in res["segments"]]
        res["avg_segment_seconds"] = round(sum(segs_s) / len(segs_s), 1) if segs_s else None
        (D / "result.json").write_text(json.dumps(res, indent=2))
        subprocess.run(["bash", str(HERE / "postrun.sh"), str(D)], timeout=600)
        print(json.dumps({k: v for k, v in res.items() if k != "segments"}, indent=2)); print("run dir:", D)


main()
