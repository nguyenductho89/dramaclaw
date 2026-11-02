"""Run the InfiniteTalk graph on the pod's ComfyUI via its HTTP proxy.

Usage: python run_it.py <image.png> <audio.mp3> <seconds> <out.mp4> [width height]
"""
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE = "https://zz2ez2la01xw7p-8188.proxy.runpod.net"
img, aud, secs, out = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
W = int(sys.argv[5]) if len(sys.argv) > 5 else 480
H = int(sys.argv[6]) if len(sys.argv) > 6 else 832
FPS = 25
frames = int(secs * FPS)


def upload(path):
    name = path.rsplit("/", 1)[-1]
    b = uuid.uuid4().hex
    body = (
        f'--{b}\r\nContent-Disposition: form-data; name="image"; filename="{name}"\r\n'
        "Content-Type: application/octet-stream\r\n\r\n"
    ).encode() + open(path, "rb").read() + (
        f'\r\n--{b}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n--{b}--\r\n'
    ).encode()
    req = urllib.request.Request(
        BASE + "/upload/image", data=body, headers={"Content-Type": f"multipart/form-data; boundary={b}", "User-Agent": "curl/8.7.1"}
    )
    return json.load(urllib.request.urlopen(req, timeout=120))["name"]


def call(path, data=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(data).encode() if data is not None else None,
        headers={"Content-Type": "application/json", "User-Agent": "curl/8.7.1"},
    )
    try:
        return json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read().decode()[:4000])
        sys.exit(3)


p = json.load(open("api_raw.json"))
img_name, aud_name = upload(img), upload(aud)
p["284"]["inputs"]["image"] = img_name
p["125"]["inputs"]["audio"] = aud_name
p["245"]["inputs"]["value"] = W
p["246"]["inputs"]["value"] = H
p["270"]["inputs"]["value"] = frames
p["122"]["inputs"]["model"] = "Wan2_1-I2V-14B-480P_fp8_e4m3fn.safetensors"
p["122"]["inputs"]["attention_mode"] = "sdpa"
p["120"]["inputs"]["model"] = "InfiniteTalk/Wan2_1-InfiniTetalk-Single_fp16.safetensors"
p["134"]["inputs"]["blocks_to_swap"] = 10
p["241"]["inputs"]["positive_prompt"] = (
    "A serene Buddha seated in meditation, speaking calmly and gently to the viewer, "
    "natural lip movement while chanting, subtle blinking and slight head movement, "
    "still camera, soft temple lighting"
)
p["131"]["inputs"].update(
    {"frame_rate": FPS, "loop_count": 0, "filename_prefix": "IT_test", "format": "video/h264-mp4",
     "pingpong": False, "save_output": True, "pix_fmt": "yuv420p", "crf": 19, "save_metadata": False,
     "trim_to_audio": False}
)

res = call("/prompt", {"prompt": p, "client_id": uuid.uuid4().hex})
if res.get("node_errors"):
    print("NODE ERRORS", json.dumps(res["node_errors"], indent=1)[:3000])
pid = res["prompt_id"]
print("queued", pid, flush=True)
t0 = time.time()
while True:
    time.sleep(10)
    h = call(f"/history/{pid}")
    if pid in h:
        st = h[pid]["status"]
        print("status", st.get("status_str"), round(time.time() - t0), "s")
        if st.get("status_str") != "success":
            print(json.dumps(st.get("messages"), indent=1)[:3000])
            sys.exit(1)
        outs = h[pid]["outputs"]
        for nid, o in outs.items():
            for key in ("gifs", "videos", "images"):
                for f in o.get(key, []):
                    print("output", nid, f)
                    if f["filename"].endswith(".mp4"):
                        url = f"{BASE}/view?filename={f['filename']}&subfolder={f.get('subfolder','')}&type={f.get('type','output')}"
                        subprocess.run(["curl", "-s", "-o", out, url], check=True)
                        print("saved", out)
        break
    if time.time() - t0 > 3000:
        print("timeout")
        sys.exit(2)
