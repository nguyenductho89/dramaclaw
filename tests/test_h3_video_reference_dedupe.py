"""Freezone hands the H3 generator its full reference list, first frame
included — the generator must not upload that image a second time, so
`<Picture N>` in the prompt maps to the Nth connected image."""

from __future__ import annotations

import asyncio

from novelvideo import config
from novelvideo.generators import nanobanana_grid
from novelvideo.generators import runpod_minimax_h3_video as h3
from novelvideo.generators.video_generator import ShotReference


def _run(tmp_path, monkeypatch, references, last_frame=None):
    monkeypatch.setattr(config, "RUNPOD_API_KEY", "test-key")
    monkeypatch.setattr(config, "RUNPOD_H3_VIDEO_ENDPOINT_ID", "test-endpoint")
    monkeypatch.setattr(h3, "_fit_canvas_bytes", lambda data, w, h: data)
    captured: dict = {}

    def fake_upload(payloads):
        captured["names"] = [name for name, _d, _m in payloads]
        raise RuntimeError("stop before network")

    monkeypatch.setattr(nanobanana_grid, "_runpod_upload_inputs_sync", fake_upload)
    result = asyncio.run(
        h3.RunPodMiniMaxH3VideoGenerator().generate(
            image_path=str(tmp_path / "first.png"),
            prompt="test prompt",
            output_path=str(tmp_path / "out.mp4"),
            last_frame_path=last_frame,
            references=references,
            two_stage=False,
            audio_refine=False,
        )
    )
    assert "stop before network" in (result.error or "")
    return captured["names"]


def _write(tmp_path, name):
    path = tmp_path / name
    path.write_bytes(b"img")
    return str(path)


def test_first_frame_in_references_is_not_uploaded_twice(tmp_path, monkeypatch):
    first = _write(tmp_path, "first.png")
    char = _write(tmp_path, "char.png")
    names = _run(
        tmp_path,
        monkeypatch,
        [ShotReference("image", first, "first frame"), ShotReference("image", char, "")],
    )
    assert names == ["h3_first_frame.png", "h3_ref_image_0.png"]


def test_first_frame_only_stays_fl2va(tmp_path, monkeypatch):
    first = _write(tmp_path, "first.png")
    names = _run(tmp_path, monkeypatch, [ShotReference("image", first, "first frame")])
    assert names == ["h3_first_frame.png"]


def test_last_frame_reference_is_not_uploaded_as_a_reference(tmp_path, monkeypatch):
    first = _write(tmp_path, "first.png")
    last = _write(tmp_path, "last.png")
    names = _run(
        tmp_path,
        monkeypatch,
        [ShotReference("image", first, "first frame"), ShotReference("image", last, "last frame")],
        last_frame=last,
    )
    assert names == ["h3_first_frame.png", "h3_last_frame.png"]
