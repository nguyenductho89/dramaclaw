"""Contract tests for the shot-by-shot video breakdown (freezone_video_breakdown).

Covers three things: the route forwards parameters verbatim into the task payload, the
job-layer data-cleaning logic (model timestamps are not trustworthy), and the runner only
hands out URLs -- disk paths must never leak to the frontend.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from novelvideo.api.routes import freezone as freezone_routes
from novelvideo.freezone import jobs as freezone_jobs
from novelvideo.freezone.jobs import (
    _group_breakdown_shots,
    _normalize_breakdown_shots,
    _select_motion_shots,
    build_video_breakdown_prompt,
    plan_breakdown_frame_count,
    plan_breakdown_shot_range,
)
from novelvideo.project_context import ProjectContext


def _async_return(value: object):
    """Stand in for a coroutine that would really shell out to ffmpeg: swallow all args, return a fixed result."""

    async def _stub(*_args: object, **_kwargs: object) -> object:
        return value

    return _stub


def _ctx(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="proj_breakdown_1",
        project_name="demo",
        owner_type="user",
        owner_id="user_owner",
        owner_username="alice",
        requester_user_id="user_editor",
        requester_username="bob",
        requester_principals=(("user", "user_editor"),),
        effective_role="editor",
        home_node_id="node_a",
        output_dir=tmp_path / "output" / "alice" / "demo",
        state_dir=tmp_path / "state" / "alice" / "demo",
        runtime_dir=tmp_path / "runtime" / "alice" / "demo",
        is_home_node=True,
    )


def test_breakdown_prompt_demands_segment_lighting_and_music() -> None:
    prompt = build_video_breakdown_prompt(frame_count=8, duration_sec=12.5, group_size=4)

    assert "about 12.50 seconds" in prompt
    assert "at most 4 shots" in prompt
    # The frontend storyboard card is "shot # | shot size · lighting | description";
    # the card is incomplete if any of these three fields is missing.
    assert '"segment"' in prompt
    assert '"shot_size"' in prompt
    assert '"lighting"' in prompt
    assert '"description"' in prompt
    assert '"music"' in prompt
    assert "Output strictly a JSON object" in prompt


def test_prompt_shot_range_scales_with_duration_at_medium_granularity() -> None:
    # Longer clips get more shots, but at a medium grain of ~2.5s/shot -- a 45s clip no
    # longer gets chopped into 40 shots (= 11 storyboard groups, more tiring than the source).
    sparse = build_video_breakdown_prompt(frame_count=8, duration_sec=12.5)
    dense = build_video_breakdown_prompt(frame_count=40, duration_sec=45.0)

    assert "Split into 4-5 shots" in sparse
    assert "Split into 13-18 shots" in dense
    assert "medium grain" in dense


def test_frame_count_tracks_duration_and_stays_inside_the_cap() -> None:
    # One frame per second, with a floor for short clips and a ceiling (max_frames) for long ones.
    assert plan_breakdown_frame_count(duration_sec=45.0, max_frames=40) == 40
    assert plan_breakdown_frame_count(duration_sec=24.0, max_frames=40) == 24
    assert plan_breakdown_frame_count(duration_sec=3.0, max_frames=40) == 8
    # When duration probing fails, use the whole budget rather than guess at a density.
    assert plan_breakdown_frame_count(duration_sec=None, max_frames=40) == 40
    # When the caller lowers the cap, the cap wins (and drags the floor down with it).
    assert plan_breakdown_frame_count(duration_sec=60.0, max_frames=5) == 5


def test_shot_range_follows_duration_not_frame_density() -> None:
    # An 8-second clip shouldn't be split into 20 shots of 0.4s each just because 20 frames were extracted.
    assert plan_breakdown_shot_range(frame_count=20, duration_sec=8.0) == (3, 3)
    # Long clips use a medium grain based on duration, not frame count as shot count (60s -> 24 shots, not 40).
    assert plan_breakdown_shot_range(frame_count=40, duration_sec=60.0) == (17, 24)
    # Frame count is a hard ceiling: a shot can't be carved out of footage nobody looked at.
    assert plan_breakdown_shot_range(frame_count=10, duration_sec=60.0) == (7, 10)
    # When duration is unknown, approximate it with frame count (extraction is already one frame/second).
    assert plan_breakdown_shot_range(frame_count=25, duration_sec=None) == (7, 10)
    # Even a very short clip gets at least 3 shots, otherwise "storyboard groups" is meaningless.
    assert plan_breakdown_shot_range(frame_count=8, duration_sec=2.0) == (3, 3)


@pytest.mark.asyncio
async def test_breakdown_frames_span_the_whole_video_not_just_the_head(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[list[str]] = []

    async def fake_scene_cmd(cmd: list[str]) -> bool:
        calls.append(cmd)
        pattern = Path(cmd[-1])
        pattern.parent.mkdir(parents=True, exist_ok=True)
        # Fast-cut footage: 100 cuts across the whole clip, file names are PTS, all the way to the end.
        for index in range(100):
            (pattern.parent / f"scene_{index * 30:05d}.jpg").write_bytes(b"x")
        return True

    async def fail_if_called(cmd: list[str]) -> None:
        raise AssertionError(f"should not fall back to even sampling when cuts are dense enough: {cmd}")

    monkeypatch.setattr(freezone_jobs, "_try_run_cmd", fake_scene_cmd)
    monkeypatch.setattr(freezone_jobs, "_run_cmd", fail_if_called)

    frames = await freezone_jobs._extract_breakdown_frames(
        video_path=tmp_path / "clip.mp4",
        out_dir=tmp_path / "frames",
        target_frames=10,
        scene_threshold=0.3,
        duration_sec=100.0,
    )

    # Scene detection must not use the target frame count as -frames:v: that would stop
    # decoding at the 10th cut, never even looking at the other 90, leaving the breakdown
    # covering only the start of the video.
    scene_cmd = calls[0]
    assert scene_cmd[scene_cmd.index("-frames:v") + 1] == str(
        freezone_jobs._BREAKDOWN_SCENE_SCAN_LIMIT
    )
    # Limited-range yuv420p makes the mjpeg encoder refuse to open at all, producing zero frames.
    assert "format=yuvj420p" in scene_cmd[scene_cmd.index("-vf") + 1]
    assert len(frames) == 10
    assert frames[0].name == "scene_00000.jpg"
    assert frames[-1].name == "scene_02970.jpg"
    # Unselected frames must not linger on disk, or one breakdown run would leave behind hundreds of unused images.
    assert len(list((tmp_path / "frames").glob("scene_*.jpg"))) == 10


@pytest.mark.asyncio
async def test_breakdown_frames_fall_back_to_even_sampling_for_one_take_clips(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[list[str]] = []

    async def fake_scene_cmd(cmd: list[str]) -> bool:
        calls.append(cmd)
        pattern = Path(cmd[-1])
        pattern.parent.mkdir(parents=True, exist_ok=True)
        # A single unbroken take: scene detection only finds two cuts, not enough to split finely.
        for index in range(2):
            (pattern.parent / f"scene_{index * 30:05d}.jpg").write_bytes(b"x")
        return True

    async def fake_even_cmd(cmd: list[str]) -> None:
        calls.append(cmd)
        pattern = Path(cmd[-1])
        pattern.parent.mkdir(parents=True, exist_ok=True)
        for index in range(1, 13):
            (pattern.parent / f"even_{index:05d}.jpg").write_bytes(b"x")

    monkeypatch.setattr(freezone_jobs, "_try_run_cmd", fake_scene_cmd)
    monkeypatch.setattr(freezone_jobs, "_run_cmd", fake_even_cmd)

    frames = await freezone_jobs._extract_breakdown_frames(
        video_path=tmp_path / "clip.mp4",
        out_dir=tmp_path / "frames",
        target_frames=12,
        scene_threshold=0.3,
        duration_sec=12.0,
    )

    assert len(calls) == 2
    even_cmd = calls[1]
    # 12 seconds needs 12 frames -> one frame per second.
    assert "fps=1.000000" in even_cmd[even_cmd.index("-vf") + 1]
    assert len(frames) == 12
    assert all(path.name.startswith("even_") for path in frames)
    # Took the even-sampling path, so the scene frames are garbage and must not leak into the model input.
    assert list((tmp_path / "frames").glob("scene_*.jpg")) == []


@pytest.mark.asyncio
async def test_breakdown_frames_fall_back_to_even_sampling_when_scene_scan_hits_the_limit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    limit = freezone_jobs._BREAKDOWN_SCENE_SCAN_LIMIT
    calls: list[list[str]] = []

    async def fake_scene_cmd(cmd: list[str]) -> bool:
        calls.append(cmd)
        pattern = Path(cmd[-1])
        pattern.parent.mkdir(parents=True, exist_ok=True)
        # Footage with a cut every two frames: -frames:v stops at the cap, with the last
        # frame only reaching 16s even though the clip is 20s long.
        for index in range(limit):
            (pattern.parent / f"scene_{index * 2:05d}.jpg").write_bytes(b"x")
        return True

    async def fake_even_cmd(cmd: list[str]) -> None:
        calls.append(cmd)
        pattern = Path(cmd[-1])
        pattern.parent.mkdir(parents=True, exist_ok=True)
        for index in range(1, 21):
            (pattern.parent / f"even_{index:05d}.jpg").write_bytes(b"x")

    monkeypatch.setattr(freezone_jobs, "_try_run_cmd", fake_scene_cmd)
    monkeypatch.setattr(freezone_jobs, "_run_cmd", fake_even_cmd)

    frames = await freezone_jobs._extract_breakdown_frames(
        video_path=tmp_path / "clip.mp4",
        out_dir=tmp_path / "frames",
        target_frames=20,
        scene_threshold=0.3,
        duration_sec=20.0,
    )

    # There are enough scene frames, but they only cover up to 16s; must fall back to even
    # sampling, which covers the whole clip.
    assert len(calls) == 2
    even_cmd = calls[1]
    assert "fps=1.000000" in even_cmd[even_cmd.index("-vf") + 1]
    assert len(frames) == 20
    assert all(path.name.startswith("even_") for path in frames)
    assert list((tmp_path / "frames").glob("scene_*.jpg")) == []


def test_normalize_shots_fills_missing_times_and_keeps_them_monotonic() -> None:
    shots = _normalize_breakdown_shots(
        [
            {"shot": 1, "description": "door opens"},
            {"shot": 2, "start_time": 1.0, "end_time": 0.5, "description": "turns around"},
            {"shot": 3, "start_time": 99.0, "end_time": 120.0, "description": "wide shot"},
        ],
        duration_sec=9.0,
        frame_count=6,
        group_size=4,
    )

    assert [shot["code"] if "code" in shot else shot["shot"] for shot in shots] == [1, 2, 3]
    assert shots[0]["start_time"] == 0.0
    for previous, current in zip(shots, shots[1:]):
        assert current["start_time"] >= previous["start_time"]
        assert current["end_time"] >= current["start_time"]
    # Out-of-range times must be clamped inside the clip length, or ffmpeg would cut a 0-second clip.
    assert all(shot["end_time"] <= 9.0 for shot in shots)


def test_normalize_shots_backfills_required_display_fields() -> None:
    (shot,) = _normalize_breakdown_shots(
        [{"visual_description": "boy looks up"}],
        duration_sec=4.0,
        frame_count=3,
        group_size=4,
    )

    assert shot["description"] == "boy looks up"
    assert shot["shot_size"]
    assert shot["lighting"]
    assert shot["camera_movement"]
    assert 1 <= shot["keyframe"] <= 3


def test_group_shots_uses_model_segments_when_present() -> None:
    shots = _normalize_breakdown_shots(
        [{"segment": 1}, {"segment": 1}, {"segment": 2}],
        duration_sec=6.0,
        frame_count=3,
        group_size=4,
    )

    groups = _group_breakdown_shots(
        shots,
        segments=[{"segment": 1, "label": "Opening"}, {"segment": 2, "label": "Conflict"}],
        group_size=4,
    )

    assert [group["label"] for group in groups] == ["Opening", "Conflict"]
    assert [len(group["shots"]) for group in groups] == [2, 1]
    assert [group["group_index"] for group in groups] == [1, 2]


def test_group_shots_falls_back_to_even_split_when_model_gives_one_segment() -> None:
    shots = _normalize_breakdown_shots(
        [{"segment": 1} for _ in range(9)],
        duration_sec=18.0,
        frame_count=9,
        group_size=4,
    )

    groups = _group_breakdown_shots(shots, segments=[], group_size=4)

    assert [len(group["shots"]) for group in groups] == [4, 4, 1]
    assert [group["label"] for group in groups] == [
        "Storyboard group 01",
        "Storyboard group 02",
        "Storyboard group 03",
    ]


def test_group_shots_caps_long_model_segments_at_group_size() -> None:
    shots = _normalize_breakdown_shots(
        [{"segment": 1} for _ in range(10)] + [{"segment": 2} for _ in range(3)],
        duration_sec=26.0,
        frame_count=13,
        group_size=4,
    )

    groups = _group_breakdown_shots(
        shots,
        segments=[{"segment": 1, "label": "Riding into the field"}, {"segment": 2, "label": "Stops to listen"}],
        group_size=4,
    )

    # The model's first beat has 10 shots; without a cap it would pile up as one huge group on the canvas.
    assert [len(group["shots"]) for group in groups] == [4, 4, 2, 3]
    assert [group["label"] for group in groups] == [
        "Riding into the field (1/3)",
        "Riding into the field (2/3)",
        "Riding into the field (3/3)",
        "Stops to listen",
    ]
    assert [group["group_index"] for group in groups] == [1, 2, 3, 4]
    # Each split-off group is its own storyboard group; the shots' segment field must follow,
    # not keep pointing at the original beat.
    assert [shot["segment"] for group in groups for shot in group["shots"]] == [
        1,
        1,
        1,
        1,
        2,
        2,
        2,
        2,
        3,
        3,
        4,
        4,
        4,
    ]


def test_malformed_key_value_pair_is_repaired_instead_of_failing_the_whole_read() -> None:
    # Real incident: the model wrote "shot":25 as "shot25, repeating the typo across several
    # shots, invalidating a whole 20KB breakdown table over one dropped token.
    raw = (
        '{"title":"field","segments":[{"segment":1,"label":"opening"}],"shots":['
        '{"shot":1,"segment":1,"description":"boy rides bike"},'
        '{"shot2,"segment":1,"description":"wide shot of rice field"},'
        '{"shot3,"segment":1,"description":"looking up at the sky"}],'
        '"music":{"description":"soft","bpm":76}}'
    )

    parsed = freezone_jobs.loads_model_json(raw)

    assert [shot["shot"] for shot in parsed["shots"]] == [1, 2, 3]
    assert [shot["description"] for shot in parsed["shots"]] == [
        "boy rides bike",
        "wide shot of rice field",
        "looking up at the sky",
    ]
    assert parsed["title"] == "field"
    assert parsed["music"]["bpm"] == 76


def test_unrepairable_shot_is_dropped_so_the_rest_of_the_read_survives() -> None:
    raw = (
        '{"shots":['
        '{"shot":1,"description":"usable"},'
        '{"shot":2,"description":"broken" "also broken"},'
        '{"shot":3,"description":"usable too"}]}'
    )

    parsed = freezone_jobs.loads_model_json(raw)

    assert [shot["shot"] for shot in parsed["shots"]] == [1, 3]


def test_hopeless_output_still_raises_so_the_job_can_retry() -> None:
    with pytest.raises(json.JSONDecodeError):
        freezone_jobs.loads_model_json("this is not JSON, the model is just chatting")


def test_code_fenced_json_is_still_accepted() -> None:
    parsed = freezone_jobs.loads_model_json('```json\n{"shots":[{"shot":1}]}\n```')

    assert parsed["shots"] == [{"shot": 1}]


@pytest.mark.asyncio
async def test_breakdown_retries_once_when_the_model_output_is_beyond_repair(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A breakdown run takes a few minutes; better to retry once ourselves than make the user re-upload the video."""

    video = tmp_path / "clip.mp4"
    video.write_bytes(b"fake")
    frame = tmp_path / "frame_00001.jpg"
    # Needs to be a real openable image, since it gets decoded/compressed before being sent to the model.
    Image.new("RGB", (8, 8), "white").save(frame, format="JPEG")

    monkeypatch.setattr(freezone_jobs.shutil, "which", lambda _name: "/usr/bin/ffmpeg")
    monkeypatch.setattr(
        freezone_jobs, "_probe_video_duration", _async_return(8.0), raising=True
    )
    monkeypatch.setattr(
        freezone_jobs, "_extract_breakdown_frames", _async_return([frame]), raising=True
    )
    monkeypatch.setattr(
        freezone_jobs, "_extract_frame_at", _async_return(None), raising=True
    )

    calls: list[int] = []

    async def flaky_vision(**_kwargs: object) -> tuple[str, str]:
        calls.append(1)
        if len(calls) == 1:
            return "vision-model", "Sorry, I can't parse this video."
        return "vision-model", '{"title":"field","shots":[{"shot":1,"segment":1}]}'

    monkeypatch.setattr(
        "novelvideo.freezone.vision_gateway.call_freezone_vision_model", flaky_vision
    )

    payload = await freezone_jobs.run_freezone_video_breakdown(
        project_dir=tmp_path / "project",
        job_id="job_retry",
        video_path=video,
        dimensions=["storyboard"],
    )

    assert len(calls) == 2
    assert payload["title"] == "field"
    # The first attempt's raw output must be saved to disk, so it can still be inspected on failure.
    raw_dump = (
        tmp_path / "project" / "freezone" / "_outputs" / "freezone_video_breakdown" / "job_retry"
    )
    assert (raw_dump / "raw_response.txt").read_text(encoding="utf-8").startswith("Sorry")


def test_motion_selection_prefers_moving_shots_and_returns_time_order() -> None:
    shots = _normalize_breakdown_shots(
        [
            {"start_time": 0.0, "end_time": 5.0, "camera_movement": "static"},
            {"start_time": 5.0, "end_time": 7.0, "camera_movement": "push in"},
            {"start_time": 7.0, "end_time": 12.0, "camera_movement": "follow"},
        ],
        duration_sec=12.0,
        frame_count=3,
        group_size=4,
    )

    picked = _select_motion_shots(shots, max_clips=2)

    assert [shot["camera_movement"] for shot in picked] == ["push in", "follow"]
    assert picked[0]["start_time"] < picked[1]["start_time"]


def test_motion_selection_falls_back_to_all_shots_when_nothing_moves() -> None:
    shots = _normalize_breakdown_shots(
        [
            {"start_time": 0.0, "end_time": 1.0, "camera_movement": "static"},
            {"start_time": 1.0, "end_time": 5.0, "camera_movement": "still"},
        ],
        duration_sec=5.0,
        frame_count=2,
        group_size=4,
    )

    picked = _select_motion_shots(shots, max_clips=1)

    assert len(picked) == 1
    assert picked[0]["duration"] == 4.0


@pytest.mark.asyncio
async def test_breakdown_task_bills_under_the_shared_video_analyze_feature(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    async def fake_enqueue_project_task(*_args, **kwargs):
        captured.update(kwargs)
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_1"),
            backend="celery",
            queue="node.ffmpeg",
        )

    monkeypatch.setattr(
        freezone_routes,
        "get_task_backend",
        lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task),
    )

    await freezone_routes._enqueue_or_start_freezone_video_analysis(
        ctx=SimpleNamespace(project_id="project_59"),
        username="admin",
        project="59",
        project_dir=tmp_path,
        output_dir=str(tmp_path),
        task_type="freezone_video_breakdown",
        job_id="job_1",
        payload={"video_path": "clip.mp4"},
    )

    assert captured["payload"]["billing"] == {
        "feature_key": "freezone.video_analyze",
        "operation": "video_breakdown",
    }
    # The whole breakdown run is ffmpeg cutting, shouldn't occupy the default queue.
    assert captured["queue_kind"] == "ffmpeg"


@pytest.mark.asyncio
async def test_breakdown_route_forwards_every_tuning_option(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    video_path = tmp_path / "clip.mp4"
    video_path.write_bytes(b"mp4")
    captured: dict[str, object] = {}

    async def _fake_resolve(project: str, user: dict, *, required_role: str = "editor"):
        del user, required_role
        return None, "admin", project, tmp_path, str(tmp_path)

    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", _fake_resolve)
    monkeypatch.setattr(freezone_routes, "_new_job_id", lambda: "breakdown_job")
    monkeypatch.setattr(
        freezone_routes,
        "resolve_static_url_to_path",
        lambda _url, _project_dir: video_path,
    )

    async def fake_enqueue(**kwargs):
        captured.update(kwargs)
        captured.update(kwargs["payload"])
        return {"ok": True, "data": {"task_key": f"{kwargs['task_type']}:{kwargs['job_id']}"}}

    monkeypatch.setattr(
        freezone_routes,
        "_enqueue_or_start_freezone_video_analysis",
        fake_enqueue,
    )

    result = await freezone_routes.freezone_video_breakdown(
        project="59",
        body=freezone_routes.FreezoneVideoBreakdownRequest(
            video_url="/static/admin/59/freezone/_uploads/clip.mp4",
            dimensions=["storyboard", "motion"],
            max_frames=12,
            scene_threshold=0.25,
            duration_sec=15.0,
            storyboard_group_size=3,
            max_motion_clips=2,
            motion_clip_max_sec=4.0,
            music_clip_sec=10.0,
        ),
        user={"username": "admin"},
    )

    assert result["data"]["task_key"] == "freezone_video_breakdown:breakdown_job"
    assert captured["video_path"] == video_path.as_posix()
    assert captured["video_url"] == "/static/admin/59/freezone/_uploads/clip.mp4"
    assert captured["dimensions"] == ["storyboard", "motion"]
    assert captured["max_frames"] == 12
    assert captured["scene_threshold"] == 0.25
    assert captured["duration_sec"] == 15.0
    assert captured["storyboard_group_size"] == 3
    assert captured["max_motion_clips"] == 2
    assert captured["motion_clip_max_sec"] == 4.0
    assert captured["music_clip_sec"] == 10.0


def test_breakdown_request_defaults_to_all_three_dimensions() -> None:
    body = freezone_routes.FreezoneVideoBreakdownRequest(video_url="/static/a/1/clip.mp4")

    assert body.dimensions == ["storyboard", "motion", "music"]
    assert body.storyboard_group_size == 4
    assert body.max_motion_clips == 3


@pytest.mark.asyncio
async def test_breakdown_runner_publishes_urls_and_drops_local_paths(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.task_backend.runners import freezone as freezone_runner

    ctx = _ctx(tmp_path)
    project_dir = Path(ctx.output_dir)
    out_dir = project_dir / "freezone" / "_outputs" / "freezone_video_breakdown" / "job"
    out_dir.mkdir(parents=True, exist_ok=True)
    for name in ("shot_01.jpg", "motion_01.mp4", "motion_01.jpg", "music_01.m4a"):
        (out_dir / name).write_bytes(b"bytes")

    class FakeTaskManager:
        def update_progress_for_project(self, *_args, **_kwargs):
            pass

    async def fake_run_freezone_video_breakdown(**_kwargs):
        return {
            "job_id": "job",
            "model": "DC-freezone-vision-LLM",
            "duration_sec": 12.0,
            "title": "chase in the rain",
            "summary": "a boy runs through a rainy night",
            "dimensions": ["storyboard", "motion", "music"],
            "frame_paths": [],
            "storyboard": {
                "label": "Storyboard groups",
                "groups": [
                    {
                        "group_index": 1,
                        "segment": 1,
                        "label": "Storyboard group 01",
                        "shots": [
                            {
                                "code": "S01",
                                "image_path": str(out_dir / "shot_01.jpg"),
                            }
                        ],
                    }
                ],
            },
            "motion": {
                "label": "Motion | camera-movement reference",
                "clips": [
                    {
                        "code": "M01",
                        "video_path": str(out_dir / "motion_01.mp4"),
                        "preview_image_path": str(out_dir / "motion_01.jpg"),
                    }
                ],
            },
            "music": {
                "label": "Music | BGM reference clip",
                "clip": {"code": "A01", "audio_path": str(out_dir / "music_01.m4a")},
            },
            "raw": {"shots": []},
            "output_path": str(out_dir / "breakdown.json"),
        }

    monkeypatch.setattr(freezone_runner, "get_task_manager", lambda: FakeTaskManager())
    monkeypatch.setattr(
        "novelvideo.freezone.jobs.run_freezone_video_breakdown",
        fake_run_freezone_video_breakdown,
    )

    result = await freezone_runner._run_freezone_video_breakdown_async(
        {
            "task_type": "freezone_video_breakdown",
            "payload": {
                "job_id": "job",
                "project_dir": str(project_dir),
                "video_path": str(project_dir / "clip.mp4"),
                "video_url": "/static/projects/proj_breakdown_1/clip.mp4",
            },
        },
        ctx,
    )

    shot = result["storyboard"]["groups"][0]["shots"][0]
    clip = result["motion"]["clips"][0]
    music_clip = result["music"]["clip"]

    assert "image_path" not in shot
    assert "video_path" not in clip
    assert "preview_image_path" not in clip
    assert "audio_path" not in music_clip
    assert shot["image_url"].startswith("/static/projects/proj_breakdown_1/")
    assert clip["video_url"].startswith("/static/projects/proj_breakdown_1/")
    assert clip["preview_image_url"].startswith("/static/projects/proj_breakdown_1/")
    assert music_clip["audio_url"].startswith("/static/projects/proj_breakdown_1/")
    # The raw model response is only for troubleshooting, never part of the API response.
    assert "raw" not in result
    assert "output_path" not in result
    assert result["source_video_url"] == "/static/projects/proj_breakdown_1/clip.mp4"


@pytest.mark.asyncio
async def test_breakdown_runner_keeps_music_null_when_source_has_no_audio(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.task_backend.runners import freezone as freezone_runner

    ctx = _ctx(tmp_path)
    project_dir = Path(ctx.output_dir)
    project_dir.mkdir(parents=True, exist_ok=True)

    class FakeTaskManager:
        def update_progress_for_project(self, *_args, **_kwargs):
            pass

    async def fake_run_freezone_video_breakdown(**_kwargs):
        return {
            "job_id": "job",
            "dimensions": ["music"],
            "frame_paths": [],
            "storyboard": None,
            "motion": None,
            "music": {"label": "Music | BGM reference clip", "clip": None},
            "output_path": "",
        }

    monkeypatch.setattr(freezone_runner, "get_task_manager", lambda: FakeTaskManager())
    monkeypatch.setattr(
        "novelvideo.freezone.jobs.run_freezone_video_breakdown",
        fake_run_freezone_video_breakdown,
    )

    result = await freezone_runner._run_freezone_video_breakdown_async(
        {
            "task_type": "freezone_video_breakdown",
            "payload": {"job_id": "job", "project_dir": str(project_dir), "video_path": "clip.mp4"},
        },
        ctx,
    )

    # No audio track means clip is None: the frontend uses this to skip creating an audio node
    # rather than creating one that can't be opened.
    assert result["music"]["clip"] is None
    assert result["storyboard"] is None
