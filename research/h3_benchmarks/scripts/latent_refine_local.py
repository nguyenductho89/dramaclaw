"""Latent upscale + short H3 refine on the LOCAL ComfyUI (rented box): the Open-H3-Regenerate-2K idea, built from ComfyUI nodes.

Idea (NVlabs Open-H3-Regenerate-2K, LBH workflow template 2): a learned 3D-conv latent upscaler (MinimaxH3LatentUpscaler3D)
instead of bislerp, then re-noise to sigma ~0.9 and refine 3 euler steps at the target size, decode once.

  # H2/H3: upscale an existing video (segments of 124 frames on multishot shot boundaries, original audio kept)
  python latent_refine_local.py upscale <src.mp4> <label> --target 2k [--prompt-file skit.json] [--seam guide] [--split]
  # H1: draft at low res -> upscale -> refine (and the single-pass baseline with the same model)
  python latent_refine_local.py gen <label> --target 768p --draft-mp 0.3 --prompt-file skit.json --shot 0 [--first-frame f0.png]
  python latent_refine_local.py direct <label> --target 768p --prompt-file skit.json --shot 0
Common: --upscaler lbh|lms|bislerp, --loras turbo,lms (names below or file names), --sigmas nvlabs3|lbh3|nvlabs2|"0.9,0.6,0",
--max-frames N (test mode, must be 17n+5: 22, 39, ...), --seed, --timeout. Run dir: research/h3_benchmarks/runs/<ts>_<host>_<label>/ with
meta/mem/sysmon/comfy.log/steps/quality/result.json (+ graph_*.json); one row per run in research/h3_benchmarks/runs/latent_refine_index.csv.
"""
import argparse, csv, json, os, socket, subprocess, sys, time, urllib.parse, urllib.request, uuid
from pathlib import Path

R = Path(__file__).resolve().parents[3]; T = R / "research/h3_benchmarks"; HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(R / "src"))
from novelvideo.generators.runpod_seedvr2_upscale import (  # noqa: E402
    Segment, cut_resized_segment, iter_stitched, probe_video, read_frames, write_video_stream)

URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
SERVER_LOG = Path(os.environ.get("BENCH_SERVER_LOG", "/opt/bench/comfy_server.log"))
MODELS = os.environ.get("BENCH_MODELS", "/opt/models")

UNET = os.environ.get("RUNPOD_H3_UNET_FL2VA", "minimax_h3_fl2va_pruned_int8_convrot.safetensors")
TEXT_ENCODER = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
VIDEO_VAE, AUDIO_VAE = "minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae_fp32.safetensors"
UPSCALERS = {"lbh": "minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors", "lms": "h3_upscaler_lms_v0.1.safetensors"}
LORAS = {"turbo": "minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors", "lms": "minimax_h3_lms_v1.0_r64.safetensors"}
# nvlabs3: Open-H3-Regenerate-2K release grid (shift 6 from 0.909375); nvlabs2: its 2-step grid; lbh3: LBH template pass 2.
SIGMAS = {"nvlabs3": "0.909375, 0.857143, 0.666667, 0.0", "nvlabs2": "0.7, 0.494118, 0.0", "lbh3": "0.9035, 0.6316, 0.3158, 0.0"}
SHORT_SIDE = {"768p": 768, "1080p": 1080, "2k": 1440, "4k": 2160}
DEFAULT_PROMPT = "Live-action film footage, realistic detail, natural skin tones, sharp focus, fine texture."
FPS = 24


def http(method, path, data=None, headers=None, raw=False):
    req = urllib.request.Request(URL + path, data=data, headers=headers or {}, method=method)
    with urllib.request.urlopen(req, timeout=300) as r:
        body = r.read()
    return body if raw else json.loads(body)


def upload(path: Path, name: str, mime: str) -> str:
    b = uuid.uuid4().hex
    body = (f"--{b}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\nContent-Type: {mime}\r\n\r\n").encode() \
        + path.read_bytes() + (f"\r\n--{b}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{b}--\r\n").encode()
    return http("POST", "/upload/image", body, {"Content-Type": f"multipart/form-data; boundary={b}"})["name"]


def run_graph(graph, timeout):
    resp = http("POST", "/prompt", json.dumps({"prompt": graph, "client_id": uuid.uuid4().hex}).encode(), {"Content-Type": "application/json"})
    if resp.get("node_errors"):
        return None, "node_errors: " + json.dumps(resp["node_errors"])[:1500]
    pid, t0 = resp["prompt_id"], time.time()
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
                        # LoadVideo also reports its input mp4 as a preview; only the SaveVideo file has type "output".
                        if isinstance(it, dict) and it.get("type") == "output" and str(it.get("filename", "")).endswith(".mp4"):
                            q = urllib.parse.urlencode({k: it.get(k, "") for k in ("filename", "subfolder", "type")})
                            return http("GET", f"/view?{q}", raw=True), ""
            return None, "no mp4 output"
    http("POST", "/interrupt", b"{}", {"Content-Type": "application/json"})
    return None, f"timeout {timeout}s"


def align32(x: float) -> int:
    return max(32, int(round(x / 32)) * 32)


def ceil32(x: float) -> int:
    return -(-int(x) // 32) * 32


def target_dims(target: str, aspect: float) -> tuple[int, int, int, int]:
    """(compute_w, compute_h, out_w, out_h) for a target name or WxH. Compute sizes are on the 32px grid the upscaler needs;
    like NVlabs, 4K is computed at 2176 rows (whole latent patches) and the centre 2160 rows are kept."""
    if "x" in target:
        ow, oh = map(int, target.lower().split("x"))
        return ceil32(ow), ceil32(oh), ow, oh
    if target == "768p":  # H3's native 1344x768 / 768x1344
        return (1344, 768, 1344, 768) if aspect >= 1 else (768, 1344, 768, 1344)
    short = SHORT_SIDE[target]
    long_ = int(round(short * max(aspect, 1 / aspect) / 2)) * 2
    ow, oh = (long_, short) if aspect >= 1 else (short, long_)
    return ceil32(ow), ceil32(oh), ow, oh  # computed a bit larger, centre-cropped to the output size


def draft_dims(mp: float, aspect: float) -> tuple[int, int]:
    h = (mp * 1e6 / aspect) ** 0.5
    return align32(h * aspect), align32(h)


def lora_names(spec: str) -> list[str]:
    return [LORAS.get(x.strip(), x.strip()) for x in spec.split(",") if x.strip()]


def base_nodes(loras: list[str]) -> tuple[dict, list]:
    """Loaders + model chain UNET -> LoRAs -> MiniMaxH3SigmaShift(12/3), as in the LBH template. Returns (graph, model ref)."""
    g = {"1": {"class_type": "UNETLoader", "inputs": {"unet_name": UNET, "weight_dtype": "default"}},
         "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": TEXT_ENCODER, "type": "minimax", "device": "default"}},
         "3": {"class_type": "VAELoader", "inputs": {"vae_name": VIDEO_VAE}},
         "4": {"class_type": "VAELoader", "inputs": {"vae_name": AUDIO_VAE}},
         "8": {"class_type": "RandomNoise", "inputs": {"noise_seed": 42}},
         "9": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}}}
    model = ["1", 0]
    for i, name in enumerate(loras):
        g[str(60 + i)] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": model, "lora_name": name, "strength_model": 1.0}}
        model = [str(60 + i), 0]
    g["7"] = {"class_type": "MiniMaxH3SigmaShift", "inputs": {"model": model, "shift_video": 12.0, "shift_audio": 3.0}}
    return g, ["7", 0]


def i2v_cond(g: dict, nid: str, prompt: str, w: int, h: int, frames: int, first_frame: str | None) -> None:
    g[nid] = {"class_type": "MiniMaxH3ImageToVideo", "inputs": {"clip": ["2", 0], "vae": ["3", 0], "prompt": prompt,
                                                                 "width": w, "height": h, "length": frames}}
    if first_frame:
        g[nid + "1"] = {"class_type": "LoadImage", "inputs": {"image": first_frame}}
        g[nid]["inputs"]["first_frame"] = [nid + "1", 0]


def add_upscale(g: dict, video_lat: list, audio_lat: list, a, cw: int, ch: int, scale_by: float) -> list:
    """Video latent + audio latent -> AV latent at the compute size. lbh/lms: learned 3D upscaler on the video latent;
    bislerp: MiniMaxH3AVLatentUpscaleBy (what two_stage uses today) on the AV latent."""
    if a.upscaler == "bislerp":
        g["31"] = {"class_type": "LTXVConcatAVLatent", "inputs": {"video_latent": video_lat, "audio_latent": audio_lat}}
        g["32"] = {"class_type": "MiniMaxH3AVLatentUpscaleBy", "inputs": {"samples": ["31", 0], "upscale_method": "bislerp", "scale_by": scale_by}}
        return ["32", 0]
    def up(nid, src, w, h):
        g[nid] = {"class_type": "MinimaxH3LatentUpscaler3D", "inputs": {
            "latent": src, "model_name": UPSCALERS.get(a.upscaler, a.upscaler), "mode": "target dimensions",
            "mode.width": w, "mode.height": h, "align": 32, "enable_temporal_chunking": False, "force_unload": True,
            "device": "cuda", "precision": "fp16"}}
    if max(cw, ch) > 2560:  # NVlabs: above 2K run the upscaler twice (to 2K, then to the target) so each pass stays in range
        up("29", video_lat, align32(cw / 1.5), align32(ch / 1.5))
        video_lat = ["29", 0]
    up("30", video_lat, cw, ch)
    g["31"] = {"class_type": "LTXVConcatAVLatent", "inputs": {"video_latent": ["30", 0], "audio_latent": audio_lat}}
    return ["31", 0]


def add_refine(g: dict, model: list, cond: list, latent: list, a) -> list:
    """Pass 2: re-noise to sigmas[0] and refine at the compute size (SamplerCustomAdvanced adds sigma0 noise to latent_image)."""
    g["40"] = {"class_type": "ManualSigmas", "inputs": {"sigmas": SIGMAS.get(a.sigmas, a.sigmas)}}
    g["41"] = {"class_type": "BasicGuider", "inputs": {"model": model, "conditioning": cond}}
    if a.split:  # spatial tiles + temporal chunks with seam denoise / anchors (LBH MMH3 Split Upscale), for 4K on 24 GB
        g["42"] = {"class_type": "MMH3SpatialSplitParamsV10", "inputs": {"tile_width": a.tile, "tile_height": a.tile, "overlap_ratio": 0.25,
                                                                         "fade_ratio": 0.5, "min_tile_size": 256, "seam_denoise": 0.7}}
        g["43"] = {"class_type": "MMH3SplitUpscale", "inputs": {"model": model, "conditioning": cond, "latent": latent, "noise": ["8", 0],
                                                                "sampler": ["9", 0], "sigmas": ["40", 0], "cfg": 1.0,
                                                                "spatial_split_param": ["42", 0], "seam_polish": "auto", "color_match": True}}
        return ["43", 0]
    g["43"] = {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["8", 0], "guider": ["41", 0], "sampler": ["9", 0],
                                                                 "sigmas": ["40", 0], "latent_image": latent}}
    return ["43", 0]


def add_output(g: dict, latent: list, a) -> None:
    dec = {"class_type": "VAEDecode", "inputs": {"samples": latent, "vae": ["3", 0]}}
    if a.tiled_decode:
        dec = {"class_type": "VAEDecodeTiled", "inputs": {"samples": latent, "vae": ["3", 0], "tile_size": 512, "overlap": 64,
                                                          "temporal_size": 64, "temporal_overlap": 8}}
    g["50"] = dec
    g["51"] = {"class_type": "VAEDecodeAudio", "inputs": {"samples": latent, "vae": ["4", 0]}}
    g["52"] = {"class_type": "CreateVideo", "inputs": {"images": ["50", 0], "audio": ["51", 0], "fps": FPS, "bit_depth": "auto",
                                                       "color_space": "sRGB", "codec": "none"}}
    g["53"] = {"class_type": "SaveVideo", "inputs": {"video": ["52", 0], "filename_prefix": "latent_refine", "format": "mp4",
                                                     "format.codec": "h264", "format.codec.encoding": "re-encode",
                                                     "format.codec.encoding.crf": 10.0, "codec": "auto"}}


def build_upscale_graph(video_name: str, prompt: str, frames: int, cw: int, ch: int, sw: int, first_frame: str | None, a) -> dict:
    g, model = base_nodes(lora_names(a.loras))
    g["8"]["inputs"]["noise_seed"] = a.seed
    i2v_cond(g, "10", prompt, cw, ch, frames, first_frame)  # conditioning at the target size; its empty AV latent gives the audio part
    g["11"] = {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": ["10", 1]}}
    g["20"] = {"class_type": "LoadVideo", "inputs": {"file": video_name}}
    g["21"] = {"class_type": "GetVideoComponents", "inputs": {"video": ["20", 0]}}
    g["22"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["21", 0], "vae": ["3", 0]}}
    av = add_upscale(g, ["22", 0], ["11", 1], a, cw, ch, cw / sw)
    add_output(g, add_refine(g, model, ["10", 0], av, a), a)
    return g


def build_gen_graph(prompt: str, frames: int, cw: int, ch: int, dw: int, dh: int, first_frame: str | None, a, direct: bool) -> dict:
    g, model = base_nodes(lora_names(a.loras))
    g["8"]["inputs"]["noise_seed"] = a.seed
    i2v_cond(g, "10", prompt, cw, ch, frames, first_frame)
    g["14"] = {"class_type": "BasicScheduler", "inputs": {"model": model, "scheduler": "simple", "steps": a.draft_steps, "denoise": 1.0}}
    g["16"] = {"class_type": "BasicGuider", "inputs": {"model": model, "conditioning": ["10" if direct else "12", 0]}}
    if direct:  # baseline: the same model, one full pass at the target size
        g["17"] = {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["8", 0], "guider": ["16", 0], "sampler": ["9", 0],
                                                                     "sigmas": ["14", 0], "latent_image": ["10", 1]}}
        add_output(g, ["17", 0], a)
        return g
    i2v_cond(g, "12", prompt, dw, dh, frames, first_frame)
    sig = ["14", 0]
    if a.draft_split:  # LBH: pass 1 runs only the high-noise part of the schedule, its denoised prediction feeds the upscaler
        g["15"] = {"class_type": "SplitSigmas", "inputs": {"sigmas": ["14", 0], "step": a.draft_split}}
        sig = ["15", 0]
    g["17"] = {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["8", 0], "guider": ["16", 0], "sampler": ["9", 0],
                                                                 "sigmas": sig, "latent_image": ["12", 1]}}
    g["18"] = {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": ["17", 1]}}
    av = add_upscale(g, ["18", 0], ["18", 1], a, cw, ch, cw / dw)
    add_output(g, add_refine(g, model, ["10", 0], av, a), a)
    return g


def shot_prompts(a) -> list[str]:
    if a.prompt_file:
        d = json.loads(Path(a.prompt_file).read_text())
        return list(d["shots"]) if isinstance(d, dict) else list(d)
    return [a.prompt or DEFAULT_PROMPT]


def last_frame_png(mp4: Path, png: Path) -> None:
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-sseof", "-0.5", "-i", str(mp4), "-update", "1", "-q:v", "1", str(png)], check=True)


def crop_center(chunk, ow: int, oh: int):
    h, w = chunk.shape[1:3]
    t, l = (h - oh) // 2, (w - ow) // 2
    return chunk[:, t:t + oh, l:l + ow]


def plan_h3_segments(total: int, seg_len: int, overlap: int) -> list[Segment]:
    """Like plan_segments but for H3 segment lengths (17n+5, e.g. 124); plan_segments insists on SeedVR2's 4n+1."""
    if total <= seg_len:
        return [Segment(0, total)]
    segs, start = [], 0
    while start + seg_len < total:
        segs.append(Segment(start, start + seg_len)); start += seg_len - overlap
    segs.append(Segment(total - seg_len, total))  # last one shifted back to keep full length
    return segs


def do_upscale(a, D: Path, res: dict) -> None:
    sw, sh, fps, total = probe_video(a.src)
    cw, ch, ow, oh = target_dims(a.target, sw / sh)
    n = min(total, a.max_frames) if a.max_frames else total
    seg_len = min(a.segment, n)
    segs = plan_h3_segments(n, seg_len, a.overlap)
    prompts = shot_prompts(a)
    res.update(src=a.src, src_res=f"{sw}x{sh}", compute_res=f"{cw}x{ch}", out_res=f"{ow}x{oh}", frames=n, total_frames=total,
               segment=seg_len, overlap=a.overlap, n_segments=len(segs))
    outs, prev_last = [], None
    for i, seg in enumerate(segs):
        ts = time.time()
        inp, done = D / "segs" / f"in_{i:04d}.mp4", D / "segs" / f"seg_{i:04d}.mp4"
        cut_resized_segment(a.src, inp, seg, sw, sh, fps)  # same size as the source: the latent upscaler does the resize
        vname = upload(inp, f"lr_{uuid.uuid4().hex[:10]}.mp4", "video/mp4")
        ff = upload(prev_last, f"lr_ff_{uuid.uuid4().hex[:10]}.png", "image/png") if a.seam == "guide" and prev_last else None
        g = build_upscale_graph(vname, prompts[min(i, len(prompts) - 1)], seg.length, cw, ch, sw, ff, a)
        (D / f"graph_{i:04d}.json").write_text(json.dumps(g, indent=1, ensure_ascii=False))
        data, err = run_graph(g, a.timeout)
        if err or not data:
            res["error"] = f"segment {i}: {err}"; return
        done.write_bytes(data); outs.append(done)
        if a.seam == "guide":
            prev_last = D / "segs" / f"last_{i:04d}.png"; last_frame_png(done, prev_last)
        res["segments"].append({"i": i, "frames": f"{seg.start}-{seg.end - 1}", "seconds": round(time.time() - ts, 1), "guided": bool(ff)})
        print(res["segments"][-1], flush=True)
    chunks = (crop_center(read_frames(p), ow, oh) for p in outs)
    write_video_stream(iter_stitched(segs, chunks), fps, D / "video.mp4", None if a.max_frames else a.src, width=ow, height=oh, total_frames=n)


def do_gen(a, D: Path, res: dict, direct: bool) -> None:
    frames = a.max_frames or a.frames
    ar = a.aspect or (json.loads(Path(a.prompt_file).read_text()).get("aspect_ratio") if a.prompt_file and isinstance(json.loads(Path(a.prompt_file).read_text()), dict) else None) or "16:9"
    aspect = 16 / 9 if ar == "16:9" else 9 / 16
    cw, ch, ow, oh = target_dims(a.target, aspect)
    dw, dh = draft_dims(a.draft_mp, aspect)
    prompt = shot_prompts(a)[a.shot]
    ff = upload(Path(a.first_frame), f"lr_ff_{uuid.uuid4().hex[:10]}.png", "image/png") if a.first_frame else None
    res.update(compute_res=f"{cw}x{ch}", out_res=f"{ow}x{oh}", draft_res=None if direct else f"{dw}x{dh}", frames=frames, shot=a.shot)
    g = build_gen_graph(prompt, frames, cw, ch, dw, dh, ff, a, direct)
    (D / "graph.json").write_text(json.dumps(g, indent=1, ensure_ascii=False))
    ts = time.time()
    data, err = run_graph(g, a.timeout)
    if err or not data:
        res["error"] = err; return
    raw = D / ("video_compute.mp4" if (cw, ch) != (ow, oh) else "video.mp4"); raw.write_bytes(data)
    if raw.name != "video.mp4":  # keep the centre rows/cols, as NVlabs does for 1080p (1088 rows) and 4K (2176 rows)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(raw), "-vf", f"crop={ow}:{oh}", "-c:v", "libx264", "-crf", "10",
                        "-c:a", "copy", str(D / "video.mp4")], check=True)
    res["segments"].append({"i": 0, "seconds": round(time.time() - ts, 1)})


INDEX_COLS = ["run", "mode", "label", "note", "src", "out_res", "draft_res", "frames", "n_segments", "upscaler", "loras", "sigmas",
              "seam", "split", "wall_s", "avg_segment_s", "vram_peak_mib", "ram_min_available_mib", "error"]


def mem_peaks(path: Path) -> dict:
    try:
        rows = list(csv.DictReader(path.open()))
    except OSError:
        return {}
    def col(k, f):
        v = [int(r[k]) for r in rows if (r.get(k) or "").strip().lstrip("-").isdigit()]
        return f(v) if v else None
    return {"vram_peak_mib": col("vram_used_mib", max), "ram_min_available_mib": col("host_memavailable_mib", min)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["upscale", "gen", "direct"])
    ap.add_argument("args", nargs="+", help="upscale: <src.mp4> <label>; gen/direct: <label>")
    ap.add_argument("--target", default="2k", help="768p|1080p|2k|4k|WxH")
    ap.add_argument("--upscaler", default="lbh", help="lbh|lms|bislerp|<file in latent_upscale_models>")
    ap.add_argument("--loras", default="turbo", help="comma list: turbo, lms or file names; '' = none")
    ap.add_argument("--sigmas", default="nvlabs3", help="nvlabs3|nvlabs2|lbh3 or a comma list ending in 0")
    ap.add_argument("--seam", choices=["guide", "none"], default="guide", help="upscale: pin each segment's first frame to the previous refined last frame")
    ap.add_argument("--segment", type=int, default=124); ap.add_argument("--overlap", type=int, default=1)
    ap.add_argument("--split", action="store_true", help="refine with MMH3 Split Upscale (tiles), for 4K on 24 GB")
    ap.add_argument("--tile", type=int, default=1024)
    ap.add_argument("--tiled-decode", action="store_true")
    ap.add_argument("--prompt"); ap.add_argument("--prompt-file"); ap.add_argument("--shot", type=int, default=0)
    ap.add_argument("--first-frame"); ap.add_argument("--aspect", default=None, choices=["16:9", "9:16"], help="default: aspect_ratio in --prompt-file, else 16:9")
    ap.add_argument("--frames", type=int, default=124); ap.add_argument("--max-frames", type=int, default=0)
    ap.add_argument("--draft-mp", type=float, default=0.3); ap.add_argument("--draft-steps", type=int, default=8)
    ap.add_argument("--draft-split", type=int, default=4, help="gen: stop pass 1 after this many steps (0 = full schedule)")
    ap.add_argument("--seed", type=int, default=42); ap.add_argument("--timeout", type=int, default=5400)
    ap.add_argument("--note", default="")
    a = ap.parse_args()
    if a.mode == "upscale":
        if len(a.args) != 2:
            ap.error("upscale needs <src.mp4> <label>")
        a.src, label = a.args
    else:
        label = a.args[0]
    if a.max_frames and (a.max_frames - 5) % 17:
        ap.error("--max-frames must be 17n+5 (22, 39, 56, ...)")

    run = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + f"_{socket.gethostname()}_{label}"
    D = T / "runs" / run; (D / "segs").mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(["bash", str(HERE / "snapshot_box.sh"), str(D), MODELS], check=True, timeout=600)
    except Exception as e:  # noqa: BLE001
        print("snapshot failed:", e)
    mon = subprocess.Popen(["bash", str(HERE / "memmon.sh"), str(D / "mem.csv"), "2"])
    smon = subprocess.Popen([sys.executable, str(HERE / "sysmon.py"), str(D / "sysmon.csv"), "2"])
    off = SERVER_LOG.stat().st_size if SERVER_LOG.exists() else None
    res = {"label": label, "kind": f"latent_refine_{a.mode}", "upscaler": a.upscaler, "loras": lora_names(a.loras),
           "sigmas": SIGMAS.get(a.sigmas, a.sigmas), "seam": a.seam, "split": a.split, "seed": a.seed, "segments": [], "error": None,
           "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    t0 = time.time()
    try:
        do_upscale(a, D, res) if a.mode == "upscale" else do_gen(a, D, res, a.mode == "direct")
    except Exception as e:  # noqa: BLE001
        res["error"] = f"{type(e).__name__}: {e}"
    finally:
        mon.terminate(); smon.terminate()
        if off is not None:
            with SERVER_LOG.open("rb") as f:
                f.seek(off); (D / "comfy.log").write_bytes(f.read())
        res["wall_seconds"] = round(time.time() - t0, 1)
        s = [x["seconds"] for x in res["segments"]]
        res["avg_segment_seconds"] = round(sum(s) / len(s), 1) if s else None
        (D / "result.json").write_text(json.dumps(res, indent=2, ensure_ascii=False))
        subprocess.run(["bash", str(HERE / "postrun.sh"), str(D)], timeout=600)
        idx = T / "runs" / "latent_refine_index.csv"; new = not idx.exists()
        with idx.open("a", newline="") as f:
            w = csv.DictWriter(f, fieldnames=INDEX_COLS, extrasaction="ignore")
            if new:
                w.writeheader()
            w.writerow({"run": run, "mode": a.mode, "note": a.note, **res, "loras": "+".join(res["loras"]), "wall_s": res["wall_seconds"],
                        "avg_segment_s": res["avg_segment_seconds"], **mem_peaks(D / "mem.csv")})
        print(json.dumps({k: v for k, v in res.items() if k != "segments"}, indent=2, ensure_ascii=False)); print("run dir:", D)


if __name__ == "__main__":
    main()
