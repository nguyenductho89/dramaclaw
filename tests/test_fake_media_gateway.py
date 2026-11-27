"""scripts/fake_media_gateway against a stub ComfyUI: graph shape, response contract, task lifecycle."""
from __future__ import annotations

import argparse
import asyncio
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


# ── Vast.ai cost ledger ──────────────────────────────────────────────────────

from scripts.fake_media_gateway import __main__ as gateway_cli  # noqa: E402
from scripts.fake_media_gateway import vast_billing  # noqa: E402
from scripts.fake_media_gateway.vast_billing import Ledger  # noqa: E402


def test_allocate_is_proportional_and_exact():
    shares = vast_billing.allocate(10.0, [30.0, 10.0, 60.0])
    assert shares == [3.0, 1.0, 6.0]
    odd = vast_billing.allocate(1.0, [1.0, 1.0, 1.0])
    assert sum(odd) == pytest.approx(1.0, abs=1e-9) and len(odd) == 3
    assert vast_billing.allocate(2.0, [0.0, 0.0]) == [1.0, 1.0]
    assert vast_billing.allocate(5.0, []) == []


def test_ledger_session_lifecycle(tmp_path):
    ledger = Ledger(tmp_path / "billing")
    assert ledger.record("t0", 5.0, {}) is False  # no open session: nothing written
    session = ledger.start(10.0)
    with pytest.raises(ValueError, match="still open"):
        ledger.start(9.0)
    assert ledger.record("t1", 30.0, {"project": "demo", "episode": 1, "beat_num": 2})
    assert ledger.record("t2", 10.0, {"project": "demo", "episode": 1, "beat_num": 3})
    assert ledger.task("t1")["usd"] is None and ledger.task("t1")["status"] == "open"

    closed = ledger.close(credit_after=6.0)

    assert closed["total_usd"] == 4.0 and closed["status"] == "closed"
    assert ledger.task("t1")["usd"] == 3.0 and ledger.task("t2")["usd"] == 1.0
    assert ledger.task("t1")["session_id"] == session["session_id"]
    assert ledger.open_session() is None
    assert ledger.task("missing") is None
    with pytest.raises(ValueError, match="no open"):
        ledger.close(credit_after=1.0)


def test_ledger_close_rejects_a_credit_increase(tmp_path):
    ledger = Ledger(tmp_path)
    ledger.start(5.0)
    with pytest.raises(ValueError, match="credit rose"):
        ledger.close(credit_after=8.0)
    assert ledger.open_session() is not None  # still open: the user can retry


def test_fetch_vast_credit_reads_credit_field(monkeypatch):
    seen = {}

    class Resp:
        def __init__(self, body):
            self.body = body

        def raise_for_status(self):
            pass

        def json(self):
            return self.body

    def fake_get(url, headers, timeout):
        seen.update(url=url, auth=headers["Authorization"])
        return Resp({"credit": 12.34})

    monkeypatch.setattr(vast_billing.httpx, "get", fake_get)
    assert vast_billing.fetch_vast_credit("k") == 12.34
    assert seen == {"url": vast_billing.VAST_USER_URL, "auth": "Bearer k"}

    monkeypatch.setattr(vast_billing.httpx, "get", lambda *a, **k: Resp({"balance": 1}))
    with pytest.raises(RuntimeError, match="credit"):
        vast_billing.fetch_vast_credit("k")


def _render(client, stub, **extra):
    created = client.post("/video/generations", json={
        "prompt": "walk", "duration": 5, "image": f"{stub.url}/ref.png",
        "metadata": {"dc_context": {"project": "demo", "episode": 2, "beat_num": 7, **extra}}})
    return _wait(client, created.json()["task_id"])


def test_render_time_is_billed_to_the_open_session(stub, tmp_path):
    billing = tmp_path / "billing"
    app = create_app(output_dir=tmp_path / "out", billing_dir=billing,
                     comfy=ComfyClient(stub.url, timeout_s=10, poll_s=0.01))
    ledger = Ledger(billing)
    ledger.start(10.0)
    with TestClient(app) as c:
        done = _render(c, stub, nested={"drop": "me"}, flag=True)
        task_id = done["task_id"]
        assert done["usage"]["gpu_seconds"] > 0

        before = c.get(f"/billing/tasks/{task_id}").json()
        assert (before["status"], before["usd"]) == ("open", None)
        assert before["context"] == {"project": "demo", "episode": 2, "beat_num": 7}

        ledger.close(credit_after=8.5)
        after = c.get(f"/billing/tasks/{task_id}").json()

    assert after["status"] == "closed" and after["usd"] == 1.5
    assert after["gpu_seconds"] == before["gpu_seconds"]


def test_render_without_a_session_reports_gpu_seconds_only(stub, tmp_path):
    app = create_app(output_dir=tmp_path / "out", comfy=ComfyClient(stub.url, timeout_s=10, poll_s=0.01))
    with TestClient(app) as c:
        done = _render(c, stub)
        body = c.get(f"/billing/tasks/{done['task_id']}").json()
        assert c.get("/billing/tasks/nope").status_code == 404
    assert body["status"] == "unbilled" and body["usd"] is None and body["gpu_seconds"] > 0
    assert not (tmp_path / "out_billing").exists()  # the ledger is written only for an open session


def test_failed_render_still_bills_its_gpu_time(stub, tmp_path, monkeypatch):
    async def boom(self, graph):
        await asyncio.sleep(0.02)
        raise RuntimeError("ComfyUI crashed")

    monkeypatch.setattr(ComfyClient, "render_video", boom)
    billing = tmp_path / "billing"
    app = create_app(output_dir=tmp_path / "out", billing_dir=billing,
                     comfy=ComfyClient(stub.url, timeout_s=10, poll_s=0.01))
    Ledger(billing).start(3.0)
    with TestClient(app) as c:
        done = _render(c, stub)
    assert done["status"] == "failed" and done["usage"]["gpu_seconds"] >= 0.02
    assert Ledger(billing).task(done["task_id"])["gpu_seconds"] >= 0.02


def test_billing_cli_prints_the_per_beat_table(tmp_path, capsys):
    base = dict(billing_dir=str(tmp_path), session=None, credit_before=None, credit_after=None)
    gateway_cli._billing(argparse.Namespace(action="start", **{**base, "credit_before": 20.0}))
    Ledger(tmp_path).record("task_a", 60.0, {"project": "demo", "episode": 1, "beat_num": 4})
    gateway_cli._billing(argparse.Namespace(action="close", **{**base, "credit_after": 17.5}))
    out = capsys.readouterr().out

    assert "credit before: 20.0" in out and "total:         $2.5000" in out
    assert "task_a" in out and "2.5000" in out

    gateway_cli._billing(argparse.Namespace(action="report", **base))
    assert "closed" in capsys.readouterr().out


def test_billing_cli_needs_a_key_or_a_flag(tmp_path, monkeypatch):
    monkeypatch.delenv("VAST_API_KEY", raising=False)
    with pytest.raises(SystemExit, match="VAST_API_KEY"):
        gateway_cli._billing(argparse.Namespace(
            action="start", billing_dir=str(tmp_path), session=None, credit_before=None, credit_after=None))


async def test_generator_payload_for_h3_is_accepted_and_billed_by_the_gateway(stub, tmp_path, monkeypatch):
    """What NewApiVideoGenerator really sends for a Ref2VA beat becomes the omni_reference graph, in label order."""
    import urllib.parse

    from novelvideo.generators import video_generator as video_module
    from novelvideo.generators.video_generator import NewApiVideoGenerator, ShotReference, VideoGenStatus

    billing = tmp_path / "billing"
    app = create_app(output_dir=tmp_path / "out", billing_dir=billing,
                     comfy=ComfyClient(stub.url, timeout_s=10, poll_s=0.01))
    Ledger(billing).start(5.0)
    generator = NewApiVideoGenerator(api_key="k", endpoint="https://newapi.example", model="MiniMax-H3")

    async def noop(*_a, **_k):
        return "reservation"

    async def download(_url, output_path):
        Path(output_path).write_bytes(b"video")
        return b"video"

    with TestClient(app) as c:
        seen = {}

        async def post_json(_url, payload):
            seen["payload"] = payload
            resp = c.post("/video/generations", json=payload)
            assert resp.status_code == 200, resp.text
            return resp.json()

        async def get_json(url):
            return _wait(c, urllib.parse.urlsplit(url).path.rsplit("/", 1)[1])

        monkeypatch.setattr(video_module, "_reserve_video_model_call", noop)
        monkeypatch.setattr(video_module, "_confirm_video_model_call", noop)
        monkeypatch.setattr(video_module, "_refund_video_model_call", noop)
        monkeypatch.setattr(generator, "_post_json", post_json)
        monkeypatch.setattr(generator, "_get_json", get_json)
        monkeypatch.setattr(generator, "_download_video", download)

        result = await generator.generate(
            image_path=None, prompt="subject_definitions:\n<Picture 1> ...", output_path=str(tmp_path / "v.mp4"),
            duration=6, aspect_ratio="9:16", poll_interval=0, max_polls=1,
            project_output_dir=str(tmp_path / "demo"), episode=1, beat_num=3, task_type="single_video",
            references=[ShotReference("image", f"{stub.url}/ref.png", "<Picture 1>"),
                        ShotReference("image", f"{stub.url}/ref.png?2", "<Picture 2>"),
                        ShotReference("audio", f"{stub.url}/ref.png?voice", "<Audio 1>")])
        assert result.status == VideoGenStatus.DONE, result.error
        billed = c.get(f"/billing/tasks/{result.task_id}").json()

    unified = stub.prompts[0]["270"]["inputs"]
    assert "image" not in seen["payload"]
    assert sorted(k for k in unified if k.startswith(("mode.ref_images.", "mode.ref_audios."))) == [
        "mode.ref_audios.ref_audio_0", "mode.ref_images.ref_image_0", "mode.ref_images.ref_image_1"]
    assert (unified["width"], unified["height"]) == h3_graph.resolution("9:16")
    assert billed["context"] == {"project": "demo", "episode": 1, "beat_num": 3, "task_type": "single_video"}
    assert billed["status"] == "open" and billed["gpu_seconds"] > 0


def test_v1_prefix_is_accepted_for_every_route(client, stub):
    assert client.get("/v1/healthz").status_code == 200
    assert client.post("/v1/images/generations", json={"prompt": "a cat", "metadata": {"ratio": "1:1"}}).status_code == 200


def test_text_passthrough_forwards_chat_to_upstream(stub, tmp_path, monkeypatch):
    import httpx

    seen = {}

    class _Upstream(httpx.AsyncClient):
        async def post(self, url, json=None, headers=None, **kwargs):
            seen.update(url=url, json=json, auth=headers.get("Authorization"))
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    monkeypatch.setattr("scripts.fake_media_gateway.server.httpx.AsyncClient", _Upstream)
    from scripts.fake_media_gateway.server import create_app

    app = create_app(
        output_dir=tmp_path / "out", api_key="", comfy=stub,
        text_upstream_url="https://llm.example/v1/", text_upstream_api_key="secret",
    )
    with TestClient(app) as c:
        body = {"model": "deepseek-chat", "messages": [{"role": "user", "content": "hi"}]}
        resp = c.post("/v1/chat/completions", json=body)
        no_stream = c.post("/chat/completions", json={**body, "stream": True})

    assert resp.json()["choices"][0]["message"]["content"] == "ok"
    assert seen == {"url": "https://llm.example/v1/chat/completions", "json": body, "auth": "Bearer secret"}
    assert no_stream.status_code == 400


@pytest.mark.parametrize(
    "text_model, sent, forwarded",
    [
        ("real-model", "DC-h3-prompt-composer-LLM", "real-model"),
        ("real-model", "other-model", "other-model"),
        ("", "DC-h3-prompt-composer-LLM", "DC-h3-prompt-composer-LLM"),
    ],
)
def test_text_passthrough_rewrites_dc_aliases_only_when_configured(
    stub, tmp_path, monkeypatch, text_model, sent, forwarded
):
    import httpx

    seen = {}

    class _Upstream(httpx.AsyncClient):
        async def post(self, url, json=None, headers=None, **kwargs):
            seen.update(model=json["model"])
            return httpx.Response(200, json={"choices": []})

    monkeypatch.setattr("scripts.fake_media_gateway.server.httpx.AsyncClient", _Upstream)
    monkeypatch.setenv("FAKE_GATEWAY_TEXT_MODEL", text_model)
    from scripts.fake_media_gateway.server import create_app

    app = create_app(output_dir=tmp_path / "out", api_key="", comfy=stub, text_upstream_url="https://llm.example/v1")
    with TestClient(app) as c:
        c.post("/v1/chat/completions", json={"model": sent, "messages": []})

    assert seen == {"model": forwarded}
