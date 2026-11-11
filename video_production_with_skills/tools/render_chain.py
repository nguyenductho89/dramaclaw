"""Render one H3 chain JSON against a LOCAL ComfyUI (rented GPU box) with the classic H3MultishotSampler.

  python video_production_with_skills/tools/render_chain.py <chain.json> [label]

The chain JSON is written with the longform-minimax-h3-script-writer skill: `start_image` is the approved keyframe K0
(the true first frame), `reference_images` the two character sheets, `voice_refs` the two voices, `shots` the shot
prompts. Nothing here edits or rewrites a prompt.

Env: COMFY_URL (default http://127.0.0.1:8188), RENDER_TIMEOUT_S (10800), RENDER_SEED (1234), RENDER_NOTE (free text),
RENDER_SERVER_LOG (default /opt/bench/comfy_server.log), RENDER_MODELS (/opt/models).
Each run gets video_production_with_skills/runs/<UTC ts>_<host>_<label>/ with meta.json + box/ (pod/snapshot_box.sh),
graph.json, mem.csv (pod/memmon.sh), sysmon.csv, comfy.log (slice of the server log), phases.json (pod/parse_h3_log.py),
result.json, live.log and video.mp4. Helper failures are recorded, never fatal.
"""
import json, os, socket, subprocess, sys, time, urllib.parse, urllib.request, uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
R = HERE.parents[1]
POD = HERE / "pod"
RUNS = R / "video_production_with_skills" / "runs"
URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
TIMEOUT = float(os.environ.get("RENDER_TIMEOUT_S", "10800"))
SEED = int(os.environ.get("RENDER_SEED", "1234"))
SERVER_LOG = Path(os.environ.get("RENDER_SERVER_LOG", "/opt/bench/comfy_server.log"))
MODELS = os.environ.get("RENDER_MODELS", "/opt/models")

if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
    sys.exit(__doc__)
CHAIN_FILE = Path(sys.argv[1])
CHAIN = json.loads(CHAIN_FILE.read_text())
LABEL = sys.argv[2] if len(sys.argv) > 2 else CHAIN.get("name") or CHAIN_FILE.stem

sys.path.insert(0, str(R / "src"))
os.environ["RUNPOD_H3_REALISM_LORA"] = ""
if CHAIN.get("turbo_lora"):
    os.environ["RUNPOD_H3_MULTISHOT_TURBO_LORA"] = CHAIN["turbo_lora"]
    os.environ["RUNPOD_H3_MULTISHOT_TURBO_STEPS"] = str(CHAIN.get("turbo_steps") or 8)
from novelvideo.generators.runpod_minimax_h3_multishot_video import (  # noqa: E402
    build_h3_multishot_graph, dims_for_multishot, join_shots_script, multishot_sampling_plan)

SHOTS = CHAIN["shots"]
FRAMES = int(CHAIN["frames"])
ASPECT = CHAIN.get("aspect_ratio") or "16:9"
CHECKPOINT = CHAIN.get("checkpoint") or "ref2va"
VOICE_REFS = CHAIN.get("voice_refs") or []
REFERENCE_IMAGES = CHAIN.get("reference_images") or []


def http(method, path, data=None, headers=None, raw=False):
    req = urllib.request.Request(URL + path, data=data, headers=headers or {}, method=method)
    with urllib.request.urlopen(req, timeout=120) as r:
        body = r.read()
    return body if raw else json.loads(body)


def upload(path: Path, name: str) -> str:
    b = uuid.uuid4().hex
    body = (f"--{b}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n").encode() \
        + path.read_bytes() + (f"\r\n--{b}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{b}--\r\n").encode()
    return http("POST", "/upload/image", body, {"Content-Type": f"multipart/form-data; boundary={b}"})["name"]


def main():
    run = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + f"_{socket.gethostname()}_{LABEL}"
    D = RUNS / run
    D.mkdir(parents=True, exist_ok=True)
    helper_errors = []
    try:
        subprocess.run(["bash", str(POD / "snapshot_box.sh"), str(D), MODELS], check=True, timeout=600)
    except Exception as e:  # noqa: BLE001
        helper_errors.append(f"snapshot: {e}")
    mon = subprocess.Popen(["bash", str(POD / "memmon.sh"), str(D / "mem.csv"), "2"])
    smon = subprocess.Popen([sys.executable, str(POD / "sysmon.py"), str(D / "sysmon.csv"), "2"])
    log_off = SERVER_LOG.stat().st_size if SERVER_LOG.exists() else None
    if log_off is None:
        helper_errors.append(f"server log {SERVER_LOG} not found: comfy.log/phases.json will be empty")
    try:
        _run(D)
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
        try:
            sys.path.insert(0, str(POD))
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
        print(f"run dir: {D}")


def _run(D: Path):
    w, h = dims_for_multishot(ASPECT)
    sampling = multishot_sampling_plan(CHECKPOINT)
    sp = CHAIN.get("start_image")
    start_name = upload(R / sp, "chain_start.png") if sp else None
    voice_names = [upload(R / v, f"chain_voice_{k}{Path(v).suffix}") for k, v in enumerate(VOICE_REFS)]
    reference_names = [upload(R / p, f"chain_ref_{k}{Path(p).suffix}") for k, p in enumerate(REFERENCE_IMAGES)]
    graph = build_h3_multishot_graph(
        script=join_shots_script(SHOTS), shot_count=len(SHOTS), width=w, height=h, frames_per_shot=FRAMES, seed=SEED,
        steps=int(sampling.get("steps") or 20), checkpoint=CHECKPOINT, start_image_name=start_name, reference_image_names=reference_names,
        voice_ref_names=voice_names,
        pdd_nfe=str(sampling.get("pdd_nfe") or ""), pdd_file=str(sampling.get("pdd_file") or ""),
        output_scale=float(sampling.get("output_scale") or 1.0), turbo_lora=str(sampling.get("turbo_lora") or ""),
        chain_normalize=str(sampling.get("chain_normalize") or "off"), realism_lora=str(sampling.get("realism_lora") or ""),
        realism_strength=float(sampling.get("realism_strength") or 1.0), realism_trigger=str(sampling.get("realism_trigger") or ""))
    rec = {"label": LABEL, "chain": str(CHAIN_FILE), "note": os.environ.get("RENDER_NOTE", ""),
           "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "run_dir": D.name, "comfy_url": URL,
           "resolution": f"{w}x{h}", "aspect_ratio": ASPECT, "shots": len(SHOTS), "frames_per_shot": FRAMES, "sampling": sampling, "logs": []}
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
