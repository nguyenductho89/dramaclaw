"""scripts/fake_media_gateway against a stub ComfyUI: graph shape, response contract, task lifecycle."""
from __future__ import annotations

import base64
import io
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import pytest
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.fake_media_gateway import h3_graph, qwen_graph  # noqa: E402
from scripts.fake_media_gateway.comfy_client import ComfyClient  # noqa: E402
from scripts.fake_media_gateway.server import create_app  # noqa: E402

PNG = io.BytesIO()
Image.new("RGB", (8, 8), "red").save(PNG, "PNG")
PNG_BYTES = PNG.getvalue()
MP4_BYTES = b"\x00\x00\x00\x18ftypmp42fake-mp4"
H3_NODES = [
    "UNETLoader", "CLIPLoader", "VAELoader", "MiniMaxH3MemoryEfficientSageAttentionPatch", "ModelAttentionBackend",
    "BlockSparseAttention", "MiniMaxH3SigmaShift", "LoraLoaderModelOnly", "LoadImage", "LoadAudio", "RandomNoise",
    "KSamplerSelect", "ManualSigmas", "BasicGuider", "SamplerCustomAdvanced", "VAEDecode", "VAEDecodeAudio",
    "CreateVideo", "SaveVideo",
]


class StubComfy:
    """Records what the gateway sends; answers like ComfyUI 0.37.2 for the routes the gateway uses."""

    def __init__(self, *, h3_nodes: list[str] | None = None) -> None:
        self.uploads: list[str] = []
        self.prompts: list[dict] = []
        self.object_info = {n: {} for n in (h3_nodes if h3_nodes is not None else H3_NODES)}
        self.object_info["ModelAttentionBackend"] = {"input": ["comfy kitchen attention"]}
        self.object_info["MiniMaxH3Unified"] = {
            "input": ["omni_reference", "ref_images", "ref_image_", "ref_audios", "ref_audio_", "audio_vae"]}
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def _send(self, body: bytes, ctype: str = "application/json") -> None:
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                if self.path == "/upload/image":
                    name = raw.split(b'filename="', 1)[1].split(b'"', 1)[0].decode()
                    stub.uploads.append(name)
                    self._send(json.dumps({"name": name}).encode())
                elif self.path == "/prompt":
                    stub.prompts.append(json.loads(raw)["prompt"])
                    self._send(json.dumps({"prompt_id": f"p{len(stub.prompts)}", "node_errors": {}}).encode())
                else:
                    self._send(b"{}")

            def do_GET(self):
                if self.path == "/object_info":
                    self._send(json.dumps(stub.object_info).encode())
                elif self.path == "/system_stats":
                    self._send(b"{}")
                elif self.path.startswith("/history/"):
                    pid = self.path.rsplit("/", 1)[1]
                    graph = stub.prompts[int(pid[1:]) - 1]
                    if "31" in graph:
                        outputs = {"31": {"images": [{"filename": "v.mp4", "subfolder": "video", "type": "output"}], "animated": [True]}}
                    else:
                        outputs = {"8": {"images": [{"filename": "k.png", "subfolder": "", "type": "output"}]}}
                    self._send(json.dumps({pid: {"status": {"status_str": "success"}, "outputs": outputs}}).encode())
                elif self.path.startswith("/view"):
                    self._send(MP4_BYTES if "v.mp4" in self.path else PNG_BYTES, "application/octet-stream")
                elif self.path == "/ref.png":
                    self._send(PNG_BYTES, "image/png")
                else:
                    self._send(b"{}")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def close(self) -> None:
        self.server.shutdown()


@pytest.fixture
def stub():
    s = StubComfy()
    yield s
    s.close()


@pytest.fixture
def client(stub, tmp_path):
    app = create_app(output_dir=tmp_path, comfy=ComfyClient(stub.url, timeout_s=10, poll_s=0.01))
    with TestClient(app) as c:
        yield c


def _wait(client: TestClient, task_id: str) -> dict:
    for _ in range(200):
        body = client.get(f"/video/generations/{task_id}").json()
        if body["status"] in {"completed", "failed"}:
            return body
        time.sleep(0.02)
    raise AssertionError("task did not finish")


def test_frames_and_resolution():
    assert h3_graph.frames_for(4) == 107
    assert h3_graph.frames_for(15) == 362
    assert all((h3_graph.frames_for(s) - 5) % 17 == 0 for s in range(4, 16))
    assert h3_graph.resolution("16:9") == (1376, 768)
    for ratio in ("21:9", "16:9", "4:3", "1:1", "3:4", "9:16"):
        w, h = h3_graph.resolution(ratio)
        assert w % 32 == 0 and h % 32 == 0
        assert abs(w * h - 1024 * 1024) / (1024 * 1024) < 0.1


def test_qwen_graph_wires_images_in_order():
    graph = qwen_graph.compose_graph("a cat", ["canvas.png", "ref.png"], seed=7)
    enc = graph["4"]["inputs"]
    assert graph["4"]["class_type"] == "TextEncodeQwenImage21"
    assert enc["images.image_1"] == ["101", 0] and enc["images.image_2"] == ["102", 0]
    assert graph["102"]["inputs"]["image"] == "ref.png"
    with pytest.raises(ValueError):
        qwen_graph.compose_graph("x", [], seed=1)


def test_image_generation_returns_b64_and_uses_requested_ratio(client, stub):
    resp = client.post("/images/generations", json={
        "model": "qwen", "prompt": "a cat", "n": 1, "response_format": "url", "metadata": {"ratio": "16:9"}})
    assert resp.status_code == 200
    assert base64.b64decode(resp.json()["data"][0]["b64_json"]) == PNG_BYTES
    graph = stub.prompts[0]
    assert graph["4"]["inputs"]["prompt"] == "a cat"
    assert "images.image_2" not in graph["4"]["inputs"]


@pytest.mark.parametrize("field", ["image", "images"])
def test_image_edit_downloads_references(client, stub, field):
    ref = f"{stub.url}/ref.png"
    value = [ref] if field == "image" else [{"image_url": ref}]
    resp = client.post("/images/edits", json={"prompt": "edit", field: value})
    assert resp.status_code == 200
    assert len(stub.uploads) == 2  # grey canvas + the reference
    assert stub.prompts[0]["4"]["inputs"]["images.image_2"] == ["102", 0]


def test_video_lifecycle(client, stub):
    created = client.post("/video/generations", json={
        "model": "MiniMax-H3", "prompt": "walk", "duration": 6, "image": f"{stub.url}/ref.png",
        "metadata": {"ratio": "9:16", "reference_images": [f"{stub.url}/ref.png"]}})
    assert created.status_code == 200 and created.json()["status"] == "queued"
    done = _wait(client, created.json()["task_id"])
    assert done["status"] == "completed", done
    assert client.get(done["result_url"].replace("http://testserver", "")).content == MP4_BYTES
    unified = stub.prompts[0]["270"]["inputs"]
    assert unified["duration"] == round(h3_graph.frames_for(6) / 24, 4)
    assert (unified["width"], unified["height"]) == h3_graph.resolution("9:16")
    assert "mode.ref_images.ref_image_1" in unified and "mode.ref_images.ref_image_2" not in unified


@pytest.mark.parametrize("body,needle", [
    ({"prompt": "x", "duration": 5}, "reference images"),
    ({"prompt": "x", "duration": 2, "image": "http://x/a.png"}, "duration"),
    ({"prompt": "x", "duration": 5, "image": "http://x/a.png", "metadata": {"last_frame_image": "http://x/b.png"}}, "last_frame_image"),
    ({"prompt": "x", "duration": 5, "image": "http://x/a.png", "metadata": {"reference_videos": ["http://x/v.mp4"]}}, "reference_videos"),
    ({"duration": 5, "image": "http://x/a.png"}, "prompt"),
])
def test_video_rejects_unsupported_requests(client, body, needle):
    resp = client.post("/video/generations", json=body)
    assert resp.status_code == 400
    assert needle in resp.json()["error"]["message"]


def test_missing_server_node_fails_task_not_server(stub, tmp_path):
    stub.object_info.pop("SamplerCustomAdvanced")
    app = create_app(output_dir=tmp_path, comfy=ComfyClient(stub.url, timeout_s=10, poll_s=0.01))
    with TestClient(app) as c:
        task = c.post("/video/generations", json={"prompt": "x", "duration": 5, "image": f"{stub.url}/ref.png"}).json()
        done = _wait(c, task["task_id"])
    assert done["status"] == "failed" and "SamplerCustomAdvanced" in done["error"]


def test_api_key_and_unknown_task(stub, tmp_path):
    app = create_app(output_dir=tmp_path, api_key="secret", comfy=ComfyClient(stub.url, poll_s=0.01))
    with TestClient(app) as c:
        assert c.get("/video/generations/nope").status_code == 401
        assert c.get("/video/generations/nope", headers={"Authorization": "Bearer secret"}).status_code == 404
        assert c.get("/healthz").json() == {"ok": True}
