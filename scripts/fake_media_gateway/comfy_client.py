"""Async ComfyUI HTTP client: upload, queue a graph, poll /history, fetch the output file.

Ported from ad-with-skills tools/comfy_qwen.py (upload, render) and tools/render_chain.py (.mp4 lookup).
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from urllib.parse import urlencode

import httpx


class ComfyError(RuntimeError):
    pass


class ComfyClient:
    def __init__(self, url: str, *, timeout_s: float = 1800.0, poll_s: float = 2.0) -> None:
        self.url = url.rstrip("/")
        self.timeout_s = timeout_s
        self.poll_s = poll_s

    async def _request(self, method: str, path: str, **kwargs) -> httpx.Response:
        async with httpx.AsyncClient(base_url=self.url, timeout=300.0) as client:
            resp = await client.request(method, path, **kwargs)
        resp.raise_for_status()
        return resp

    async def upload(self, name: str, data: bytes, content_type: str = "image/png") -> str:
        resp = await self._request(
            "POST",
            "/upload/image",
            files={"image": (name, data, content_type)},
            data={"overwrite": "true"},
        )
        return resp.json()["name"]

    async def object_info(self) -> dict:
        return (await self._request("GET", "/object_info")).json()

    async def system_stats(self) -> dict:
        return (await self._request("GET", "/system_stats")).json()

    async def run(self, graph: dict) -> dict:
        """Queue `graph` and wait until it finishes; returns the history entry's `outputs`."""
        resp = await self._request(
            "POST", "/prompt", json={"prompt": graph, "client_id": uuid.uuid4().hex}
        )
        body = resp.json()
        if body.get("node_errors"):
            raise ComfyError(f"node_errors: {json.dumps(body['node_errors'])[:1000]}")
        pid = body["prompt_id"]
        deadline = time.monotonic() + self.timeout_s
        while time.monotonic() < deadline:
            await asyncio.sleep(self.poll_s)
            hist = (await self._request("GET", f"/history/{pid}")).json()
            if pid not in hist:
                continue
            status = hist[pid].get("status", {})
            if status.get("status_str") == "error":
                raise ComfyError(json.dumps(status)[:1500])
            return hist[pid].get("outputs", {})
        try:
            await self._request("POST", "/interrupt")
        except httpx.HTTPError:
            pass
        raise TimeoutError(f"prompt {pid} not done after {self.timeout_s:.0f}s")

    async def fetch(self, item: dict) -> bytes:
        query = urlencode({k: item.get(k, "") for k in ("filename", "subfolder", "type")})
        return (await self._request("GET", f"/view?{query}")).content

    async def render_image(self, graph: dict, node: str = "8") -> bytes:
        outputs = await self.run(graph)
        for item in outputs.get(node, {}).get("images", []):
            return await self.fetch(item)
        raise ComfyError("finished without an image")

    async def render_video(self, graph: dict) -> bytes:
        outputs = await self.run(graph)
        for node_out in outputs.values():
            for items in node_out.values():
                if not isinstance(items, list):
                    continue
                for item in items:
                    if isinstance(item, dict) and str(item.get("filename", "")).endswith(".mp4"):
                        return await self.fetch(item)
        raise ComfyError("finished without an .mp4")
