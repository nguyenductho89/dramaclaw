from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from novelvideo.api.schemas import FreezoneVideoSeedvr2UpscaleRequest
from novelvideo.task_backend import run_core
from novelvideo.task_backend.registry import registered_project_task_types

TASK = "freezone_video_upscale_seedvr2"


def test_task_is_registered_and_labelled():
    import novelvideo.task_backend.runners.video  # noqa: F401

    assert '"freezone_video_upscale_seedvr2": "SeedVR2 video upscale"' in (
        Path(run_core.__file__).parents[1] / "api" / "routes" / "tasks.py"
    ).read_text(encoding="utf-8")

    assert TASK in registered_project_task_types()


@pytest.mark.parametrize("bad", [{"segment_frames": 40}, {"scale": 2.5}, {"scale": 0.5}, {"model": "1b"}])
def test_request_rejects_bad_values(bad):
    with pytest.raises(ValidationError):
        FreezoneVideoSeedvr2UpscaleRequest(source_url="/static/x.mp4", **bad)


def test_request_defaults_match_measured_settings():
    req = FreezoneVideoSeedvr2UpscaleRequest(source_url="/static/x.mp4")
    assert (req.scale, req.model, req.segment_frames, req.overlap_frames) == (2.0, "7b", 41, 8)


def test_long_task_gets_timeout_floor_but_others_keep_global(monkeypatch):
    monkeypatch.setenv("ST_PROJECT_TASK_TIMEOUT_S", "3600")
    assert run_core._task_timeout_seconds_for(TASK) == 6 * 3600
    assert run_core._task_timeout_seconds_for("freezone_video_multishot") == 3600
    monkeypatch.setenv("ST_PROJECT_TASK_TIMEOUT_S", "100000")
    assert run_core._task_timeout_seconds_for(TASK) == 100000


async def test_runner_streams_progress_keeps_cache_on_failure_and_cleans_on_success(tmp_path, monkeypatch):
    from novelvideo.generators import runpod_seedvr2_upscale as up
    from novelvideo import runpod_worker_control as ctrl
    from novelvideo.task_backend.runners import video as runner

    src = tmp_path / "src.mp4"
    src.write_bytes(b"not really a video")
    ctx = SimpleNamespace(output_dir=str(tmp_path))
    updates = []
    manager = SimpleNamespace(
        update_progress_for_project=lambda c, t, ratio, **kw: updates.append((ratio, kw.get("current_task")))
    )
    monkeypatch.setattr(runner, "get_task_manager", lambda: manager)
    monkeypatch.setattr("novelvideo.api.deps.make_static_url_for_context", lambda c, rel: f"/static/{rel}")

    started = []

    async def fake_status(key):
        return {"running": False}

    async def fake_start(key):
        started.append(key)

    monkeypatch.setattr(ctrl, "get_status", fake_status)
    monkeypatch.setattr(ctrl, "start_worker", fake_start)

    seen_work = []
    outcome = {"fail": True}

    async def fake_upscale(src_path, dst, *, on_progress, work_dir, **kw):
        seen_work.append(Path(work_dir))
        Path(work_dir).mkdir(parents=True, exist_ok=True)
        (Path(work_dir) / "seg_0000.mp4").write_bytes(b"x")
        on_progress(1, 2, "segment 1/2 upscaled")
        if outcome["fail"]:
            return up.UpscaleResult(error="boom", segments=[up.Segment(0, 41), up.Segment(33, 74)])
        Path(dst).write_bytes(b"out")
        on_progress(2, 2, "stitching")
        return up.UpscaleResult(output_path=str(dst), segments=[up.Segment(0, 41), up.Segment(33, 74)])

    monkeypatch.setattr(up, "upscale_video_chunked", fake_upscale)
    envelope = {"payload": {"job_id": "j1", "project_dir": str(tmp_path), "source_path": str(src), "scale": 2.0, "model": "7b"}}

    with pytest.raises(RuntimeError, match="boom"):
        await runner._run_freezone_video_upscale_seedvr2_async(envelope, ctx)
    assert started == ["qwen_t2i"]
    assert seen_work[0].exists()  # cache kept so a resubmit resumes

    outcome["fail"] = False
    updates.clear()
    result = await runner._run_freezone_video_upscale_seedvr2_async(envelope, ctx)
    assert seen_work[0] == seen_work[1]  # same request -> same work dir
    assert not seen_work[1].exists()  # cleaned after success
    assert result["output_format"] == "mp4" and result["output_url"].endswith("j1.mp4")
    assert result["meta"]["segments"] == 2
    ratios = [r for r, _ in updates]
    assert max(ratios) == pytest.approx(1.0) and ratios == sorted(ratios)
