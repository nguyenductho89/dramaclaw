"""30 s H3 multishot benchmark against a LOCAL ComfyUI (rented 4090 box), no RunPod/R2.

Reuses BEATS/SHOTS from bench_multishot30.py and the graph builders in
runpod_minimax_h3_multishot_video.py. Uploads photo_f0.png via POST /upload/image, submits
POST /prompt, polls /history/{id}, downloads the video through /view.

  BENCH_SHOTS=2 python previs_h3_test/scripts/bench_multishot30_local.py ms2_local
  python previs_h3_test/scripts/bench_multishot30_local.py run1   # all 6 shots
Env: BENCH_SHOTS, BENCH_FRAMES (124), BENCH_PDD (file name, "" = off), COMFY_URL (default http://127.0.0.1:8188), BENCH_TIMEOUT_S (default 10800).
BENCH_SCRIPT_FILE (skit JSON; aspect_ratio defaults to 9:16), BENCH_NOTE (free text, e.g. "nvme, 120G RAM"), BENCH_SERVER_LOG (default /opt/bench/comfy_server.log), BENCH_MODELS (/opt/models).
Each run gets previs_h3_test/runs/<UTC ts>_<host>_<label>/ with meta.json + box/ (snapshot_box.sh), graph.json,
mem.csv (memmon.sh), comfy.log (slice of the server log), phases.json (parse_h3_log.py), result.json, live.log,
video.mp4; one row is appended to previs_h3_test/runs/index.csv. Helper failures are recorded, never fatal.
"""
import csv, json, os, socket, subprocess, sys, time, urllib.parse, urllib.request, uuid
from pathlib import Path

R = Path(__file__).resolve().parents[2]
T = R / "previs_h3_test"
LABEL = sys.argv[1] if len(sys.argv) > 1 else "ms30"
URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
TIMEOUT = float(os.environ.get("BENCH_TIMEOUT_S", "10800"))
SERVER_LOG = Path(os.environ.get("BENCH_SERVER_LOG", "/opt/bench/comfy_server.log"))
MODELS = os.environ.get("BENCH_MODELS", "/opt/models")
HERE = Path(__file__).resolve().parent

sys.path.insert(0, str(R / "src"))
# Match the RunPod bench (PDD 8, no realism LoRA) when this box has no .env. BENCH_PDD="" disables PDD (diagnostic run).
os.environ["RUNPOD_H3_PDD_FL2VA"] = os.environ.get("BENCH_PDD", "MiniMax-H3-FL2VA-Acc-8Step.safetensors")
os.environ["RUNPOD_H3_REALISM_LORA"] = ""
FRAMES = int(os.environ.get("BENCH_FRAMES", "124"))
# Import BEATS/SHOTS from the RunPod bench without running its main().
_src = (Path(__file__).parent / "bench_multishot30.py").read_text().split("async def main")[0]
_ns: dict = {"__file__": str(Path(__file__).parent / "bench_multishot30.py"), "__name__": "bench_defs"}
sys.argv_backup, sys.argv = sys.argv, [sys.argv[0], LABEL]
exec(compile(_src, "bench_multishot30.py", "exec"), _ns)
sys.argv = sys.argv_backup
SHOTS = _ns["SHOTS"]
# BENCH_SCRIPT_FILE: JSON {"shots": [...], "frames": N, "start_image": path|null, "aspect_ratio": "9:16"} -> a real script instead of the fixed benchmark beats.
SKIT = json.loads(Path(os.environ["BENCH_SCRIPT_FILE"]).read_text()) if os.environ.get("BENCH_SCRIPT_FILE") else None
if SKIT:
    SHOTS = SKIT["shots"]; FRAMES = int(SKIT.get("frames") or FRAMES)
# Skits default to vertical 9:16; the fixed benchmark stays 16:9 so it remains comparable with earlier runs.
ASPECT = (SKIT.get("aspect_ratio") or "9:16") if SKIT else "16:9"
# Skit fields for ref2va chains: "checkpoint", "voice_ref" (audio path, needs ref2va), "turbo_lora", "turbo_steps".
CHECKPOINT = (SKIT.get("checkpoint") or "fl2va") if SKIT else "fl2va"
VOICE_REF = (SKIT.get("voice_ref") or "") if SKIT else ""
if SKIT and SKIT.get("turbo_lora"):
    os.environ["RUNPOD_H3_MULTISHOT_TURBO_LORA"] = SKIT["turbo_lora"]
    os.environ["RUNPOD_H3_MULTISHOT_TURBO_STEPS"] = str(SKIT.get("turbo_steps") or 8)
SEED = int(os.environ.get("BENCH_SEED", "1234"))

from novelvideo.generators.runpod_minimax_h3_multishot_video import (  # noqa: E402
    build_h3_multishot_graph, dims_for_multishot, join_shots_script, multishot_sampling_plan)


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


INDEX_COLS = ["run", "label", "note", "host", "gpu", "ram_gib", "cgroup_memory_max", "models_disk", "disk_read_mbps",
              "shots", "frames_per_shot", "pdd_file", "steps", "wall_s", "init_avg_s", "encode_text_avg_s", "sampling_avg_s",
              "s_per_step", "decode_video_avg_s", "shot_total_avg_s", "vram_peak_mib", "ram_min_available_mib",
              "comfy_rss_peak_mib", "error"]


def mem_peaks(path: Path) -> dict:
    out = {"vram_peak_mib": None, "ram_min_available_mib": None, "comfy_rss_peak_mib": None}
    try:
        rows = list(csv.DictReader(path.open()))
    except OSError:
        return out
    def col(k, f):
        v = [int(r[k]) for r in rows if (r.get(k) or "").strip().lstrip("-").isdigit()]
        return f(v) if v else None
    out.update(vram_peak_mib=col("vram_used_mib", max), ram_min_available_mib=col("host_memavailable_mib", min),
               comfy_rss_peak_mib=col("comfy_vmhwm_mib", max))
    return out


def main():
    run = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + f"_{socket.gethostname()}_{LABEL}"
    D = T / "runs" / run
    D.mkdir(parents=True, exist_ok=True)
    helper_errors = []
    try:
        subprocess.run(["bash", str(HERE / "snapshot_box.sh"), str(D), MODELS], check=True, timeout=600)
    except Exception as e:  # noqa: BLE001
        helper_errors.append(f"snapshot: {e}")
    mon = subprocess.Popen(["bash", str(HERE / "memmon.sh"), str(D / "mem.csv"), "2"])
    smon = subprocess.Popen([sys.executable, str(HERE / "sysmon.py"), str(D / "sysmon.csv"), "2"])
    log_off = SERVER_LOG.stat().st_size if SERVER_LOG.exists() else None
    if log_off is None:
        helper_errors.append(f"server log {SERVER_LOG} not found: comfy.log/phases.json will be empty")
    try:
        _run(D, helper_errors)
    except Exception as e:  # noqa: BLE001  (record it; the finally block still saves logs/snapshot)
        prev = json.loads((D / "result.json").read_text()) if (D / "result.json").exists() else {"label": LABEL}
        prev["error"] = f"{type(e).__name__}: {e}"
        (D / "result.json").write_text(json.dumps(prev, indent=2, default=str))
        raise
    finally:
        mon.terminate()
        smon.terminate()
        if log_off is not None:
            with SERVER_LOG.open("rb") as f:
                f.seek(log_off); (D / "comfy.log").write_bytes(f.read())
        phases = {}
        try:
            sys.path.insert(0, str(HERE))
            import parse_h3_log
            with (D / "comfy.log").open(errors="replace") as f:
                phases = parse_h3_log.parse(f)
            phases["avg"] = parse_h3_log.summary(phases)
            (D / "phases.json").write_text(json.dumps(phases, indent=2))
        except Exception as e:  # noqa: BLE001
            helper_errors.append(f"parse: {e}")
        res = json.loads((D / "result.json").read_text()) if (D / "result.json").exists() else {}
        res["helper_errors"] = helper_errors
        (D / "result.json").write_text(json.dumps(res, indent=2, ensure_ascii=False, default=str))
        meta = json.loads((D / "meta.json").read_text()) if (D / "meta.json").exists() else {}
        avg = phases.get("avg", {})
        row = {"run": run, "label": LABEL, "note": os.environ.get("BENCH_NOTE", ""), **{k: meta.get(k) for k in
               ("host", "gpu", "ram_gib", "cgroup_memory_max", "models_disk", "disk_read_mbps")},
               "shots": res.get("shots"), "frames_per_shot": res.get("frames_per_shot"),
               "pdd_file": (res.get("sampling") or {}).get("pdd_file"), "steps": (res.get("sampling") or {}).get("steps"),
               "wall_s": res.get("wall_seconds"), "init_avg_s": avg.get("init_s"), "encode_text_avg_s": avg.get("encode_text_s"),
               "sampling_avg_s": avg.get("sampling_s"), "s_per_step": avg.get("s_per_step"),
               "decode_video_avg_s": avg.get("decode_video_s"), "shot_total_avg_s": avg.get("shot_total_s"),
               **mem_peaks(D / "mem.csv"), "error": res.get("error")}
        idx = T / "runs" / "index.csv"
        new = not idx.exists()
        with idx.open("a", newline="") as f:
            w = csv.DictWriter(f, fieldnames=INDEX_COLS)
            if new:
                w.writeheader()
            w.writerow(row)
        subprocess.run(["bash", str(HERE / "postrun.sh"), str(D)], timeout=600)
        print(f"run dir: {D}")


def _run(D: Path, helper_errors: list):
    w, h = dims_for_multishot(ASPECT)
    sampling = multishot_sampling_plan(CHECKPOINT)
    if SKIT:
        sp = SKIT.get("start_image")
        name = upload_image(Path(sp), "ms_start.png") if sp else None
    else:
        name = upload_image(T / "photo_f0.png", "ms_start.png")
    voice_names = [upload_image(Path(VOICE_REF), "ms_voice" + Path(VOICE_REF).suffix)] if VOICE_REF else []
    graph = build_h3_multishot_graph(
        script=join_shots_script(SHOTS), shot_count=len(SHOTS), width=w, height=h, frames_per_shot=FRAMES, seed=SEED,
        steps=int(sampling.get("steps") or 20), checkpoint=CHECKPOINT, start_image_name=name, voice_ref_names=voice_names,
        pdd_nfe=str(sampling.get("pdd_nfe") or ""), pdd_file=str(sampling.get("pdd_file") or ""),
        output_scale=float(sampling.get("output_scale") or 1.0), turbo_lora=str(sampling.get("turbo_lora") or ""),
        chain_normalize=str(sampling.get("chain_normalize") or "off"), realism_lora=str(sampling.get("realism_lora") or ""),
        realism_strength=float(sampling.get("realism_strength") or 1.0), realism_trigger=str(sampling.get("realism_trigger") or ""))
    rec = {"label": LABEL, "box": "rented-4090-local", "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "run_dir": D.name, "comfy_url": URL, "resolution": f"{w}x{h}", "aspect_ratio": ASPECT, "shots": len(SHOTS), "frames_per_shot": FRAMES, "sampling": sampling, "logs": []}
    (D / "graph.json").write_text(json.dumps(graph, indent=2, ensure_ascii=False))
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


main()
