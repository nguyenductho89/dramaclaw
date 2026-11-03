"""Variant B on the rented box: Three.js previs VIDEO as H3 `<Video 1>` (ref2va, 1 shot), local ComfyUI, no RunPod/R2.

Same inputs as pipeline_video_ref.py (photo_f0.png first frame, previs_shot1.mp4 as <Video 1>, same PROMPT) so the
result is comparable with the RunPod attempt that died (encode text ~15 min, 40 min timeout, cancelled).
Needs the ref2va checkpoint + ref2va PDD (or turbo LoRA) on the box (see RUN_ON_RENTED_4090.md section "ref2va").

  BENCH_REF_MODE=pdd|turbo|base  (default pdd: Ref2VA-Acc-8Step)   BENCH_FRAMES=124   BENCH_VIDEO=0 (no <Video 1>, control)
Writes previs_h3_test/runs/<ts>_<host>_<label>/ like bench_multishot30_local.py (meta.json, mem.csv, comfy.log, result.json,
video.mp4, index.csv row with shots=1).
"""
import csv, json, os, re, socket, subprocess, sys, time, urllib.parse, urllib.request, uuid
from pathlib import Path

R = Path(__file__).resolve().parents[2]; T = R / "previs_h3_test"; HERE = Path(__file__).resolve().parent
LABEL = sys.argv[1] if len(sys.argv) > 1 else "video_ref"
URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
TIMEOUT = float(os.environ.get("BENCH_TIMEOUT_S", "7200"))
SERVER_LOG = Path(os.environ.get("BENCH_SERVER_LOG", "/opt/bench/comfy_server.log"))
MODELS = os.environ.get("BENCH_MODELS", "/opt/models")
FRAMES = int(os.environ.get("BENCH_FRAMES", "124"))
MODE = os.environ.get("BENCH_REF_MODE", "pdd")
USE_VIDEO = os.environ.get("BENCH_VIDEO", "1") == "1"
os.environ["RUNPOD_H3_REALISM_LORA"] = ""
sys.path.insert(0, str(R / "src"))
_src = (HERE / "pipeline_video_ref.py").read_text()
PROMPT = {}
exec(compile(_src[_src.index("PROMPT = ("):_src.index("async def main")], "prompt", "exec"), PROMPT)
PROMPT = PROMPT["PROMPT"]
from novelvideo.generators.runpod_minimax_h3_video import build_h3_ref2va_graph  # noqa: E402


def http(method, path, data=None, headers=None, raw=False):
    req = urllib.request.Request(URL + path, data=data, headers=headers or {}, method=method)
    with urllib.request.urlopen(req, timeout=120) as r:
        body = r.read()
    return body if raw else json.loads(body)


def upload(path: Path, name: str, mime: str) -> str:
    b = uuid.uuid4().hex
    body = (f"--{b}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\nContent-Type: {mime}\r\n\r\n").encode() \
        + path.read_bytes() + (f"\r\n--{b}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{b}--\r\n").encode()
    return http("POST", "/upload/image", body, {"Content-Type": f"multipart/form-data; boundary={b}"})["name"]


def main():
    run = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + f"_{socket.gethostname()}_{LABEL}"
    D = T / "runs" / run; D.mkdir(parents=True, exist_ok=True)
    errs = []
    try:
        subprocess.run(["bash", str(HERE / "snapshot_box.sh"), str(D), MODELS], check=True, timeout=600)
    except Exception as e:  # noqa: BLE001
        errs.append(f"snapshot: {e}")
    mon = subprocess.Popen(["bash", str(HERE / "memmon.sh"), str(D / "mem.csv"), "2"])
    smon = subprocess.Popen([sys.executable, str(HERE / "sysmon.py"), str(D / "sysmon.csv"), "2"])
    off = SERVER_LOG.stat().st_size if SERVER_LOG.exists() else None
    res = {"label": LABEL, "variant": f"B video-ref mode={MODE} use_video={USE_VIDEO}", "frames": FRAMES, "resolution": "1344x768",
           "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    t0 = time.time(); data = b""
    try:
        img = upload(T / "photo_f0.png", "vr_first.png", "image/png")
        vid = upload(T / "previs_shot1.mp4", "vr_previs.mp4", "video/mp4") if USE_VIDEO else None
        kw = dict(pdd_file=None, base_steps=20, turbo_lora=None, turbo_steps=None)
        if MODE == "pdd":
            kw.update(pdd_file="MiniMax-H3-Ref2VA-Acc-8Step.safetensors")
        elif MODE == "turbo":
            kw.update(pdd_file="", turbo_lora="minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors", turbo_steps=6)
        elif MODE == "base":
            kw.update(pdd_file="")
        graph = build_h3_ref2va_graph(prompt=PROMPT, image_names=[img], audio_names=[], seed=1234, width=1344, height=768, frames=FRAMES,
                                      realism_lora="", video_names=[vid] if vid else None, video_has_audio=[False] if vid else None, **kw)
        (D / "graph.json").write_text(json.dumps(graph, indent=2))
        pid = http("POST", "/prompt", json.dumps({"prompt": graph, "client_id": uuid.uuid4().hex}).encode(), {"Content-Type": "application/json"})["prompt_id"]
        out = None
        while time.time() - t0 < TIMEOUT:
            time.sleep(5)
            h = http("GET", f"/history/{pid}")
            if pid in h:
                st = h[pid].get("status", {})
                if st.get("status_str") == "error":
                    res["error"] = json.dumps(st)[:1500]
                out = h[pid].get("outputs", {}); break
        else:
            res["error"] = f"timeout {TIMEOUT:.0f}s"; http("POST", "/interrupt", b"{}", {"Content-Type": "application/json"})
        for node in (out or {}).values():
            for v in node.values():
                for it in v if isinstance(v, list) else []:
                    if isinstance(it, dict) and str(it.get("filename", "")).endswith(".mp4"):
                        q = urllib.parse.urlencode({k: it.get(k, "") for k in ("filename", "subfolder", "type")})
                        data = http("GET", f"/view?{q}", raw=True)
        if not data and not res.get("error"):
            res["error"] = "no mp4 output"
    except Exception as e:  # noqa: BLE001
        res["error"] = f"{type(e).__name__}: {e}"
    finally:
        mon.terminate()
        smon.terminate()
        if off is not None:
            with SERVER_LOG.open("rb") as f:
                f.seek(off); (D / "comfy.log").write_bytes(f.read())
        res.update(wall_seconds=round(time.time() - t0, 1), video_bytes=len(data), helper_errors=errs)
        if data:
            (D / "video.mp4").write_bytes(data)
        (D / "result.json").write_text(json.dumps(res, indent=2, default=str))
        subprocess.run(["bash", str(HERE / "postrun.sh"), str(D)], timeout=600)
        print(json.dumps(res, indent=2, default=str)); print("run dir:", D)


main()
