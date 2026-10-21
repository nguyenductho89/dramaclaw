"""`run_compose_episode` must add a MiniMax H3 Multishot segment's video
exactly once (at its first beat), never per-beat, and must never look for
a separate TTS mp3 for it — see `.claude/CLAUDE.md`'s "Segment multishot"
section and `task_backend/runners/video.py`."""

from types import SimpleNamespace

import pytest

pytestmark = pytest.mark.m09


class _FakeTaskManager:
    def __init__(self):
        self.updates = []

    def update_progress_for_project(self, *args, **kwargs):
        self.updates.append((args, kwargs))


def _ctx(tmp_path):
    return SimpleNamespace(output_dir=tmp_path)


def _write_multishot_video(project_dir, episode: int, chain_id: str) -> None:
    video_dir = project_dir / "videos" / "beats" / f"ep{episode:03d}"
    video_dir.mkdir(parents=True, exist_ok=True)
    (video_dir / f"multishot_{chain_id}.mp4").write_bytes(b"video")


def _write_beat_video(project_dir, episode: int, beat_num: int) -> None:
    video_dir = project_dir / "videos" / "beats" / f"ep{episode:03d}"
    video_dir.mkdir(parents=True, exist_ok=True)
    (video_dir / f"beat_{beat_num:02d}.mp4").write_bytes(b"video")


def test_multishot_chain_video_added_once_not_per_beat(monkeypatch, tmp_path):
    from novelvideo.task_backend.runners import video

    _write_multishot_video(tmp_path, episode=1, chain_id="seg_ep001_01")
    manager = _FakeTaskManager()
    commands = []

    def fake_run(cmd, **_kwargs):
        commands.append(cmd)
        if cmd[0] == "ffprobe":
            return SimpleNamespace(returncode=0, stdout="0\n", stderr="")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(video, "get_task_manager", lambda: manager)
    monkeypatch.setattr(video, "run_project_subprocess", fake_run)

    result = video.run_compose_episode(
        {
            "episode": 1,
            "payload": {
                "output_dir": str(tmp_path),
                "beats": [
                    {"beat_number": 1, "multishot_chain_id": "seg_ep001_01"},
                    {"beat_number": 2, "multishot_chain_id": "seg_ep001_01"},
                    {"beat_number": 3, "multishot_chain_id": "seg_ep001_01"},
                ],
            },
        },
        _ctx(tmp_path),
    )

    assert result["video_path"].endswith("videos/episodes/ep001_final.mp4")
    # Only one ffmpeg call references the chain's mp4 (the per-clip step) —
    # it must not run three times for the three beats in the chain.
    clip_cmds = [
        cmd
        for cmd in commands
        if cmd[0] == "ffmpeg" and any("multishot_seg_ep001_01.mp4" in arg for arg in cmd)
    ]
    assert len(clip_cmds) == 1
    # The final concat step takes exactly one input clip (one chain = one
    # clip), not three.
    concat_cmd = next(cmd for cmd in commands if cmd[0] == "ffmpeg" and "-filter_complex" in cmd)
    assert concat_cmd.count("-i") == 1


def test_multishot_chain_uses_embedded_audio_not_separate_mp3(monkeypatch, tmp_path):
    from novelvideo.task_backend.runners import video

    _write_multishot_video(tmp_path, episode=1, chain_id="seg_ep001_01")
    # Even if a stray TTS mp3 happened to exist at this beat number, a
    # chain beat must never be muxed against it — H3's own muxed audio is
    # authoritative for the whole segment.
    audio_dir = tmp_path / "audio" / "ep001"
    audio_dir.mkdir(parents=True)
    (audio_dir / "beat_01.mp3").write_bytes(b"audio")

    manager = _FakeTaskManager()
    commands = []

    def fake_run(cmd, **_kwargs):
        commands.append(cmd)
        if cmd[0] == "ffprobe":
            return SimpleNamespace(returncode=0, stdout="0\n", stderr="")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(video, "get_task_manager", lambda: manager)
    monkeypatch.setattr(video, "run_project_subprocess", fake_run)

    video.run_compose_episode(
        {
            "episode": 1,
            "payload": {
                "output_dir": str(tmp_path),
                "beats": [{"beat_number": 1, "multishot_chain_id": "seg_ep001_01"}],
            },
        },
        _ctx(tmp_path),
    )

    clip_cmd = next(
        cmd
        for cmd in commands
        if cmd[0] == "ffmpeg" and any("multishot_seg_ep001_01.mp4" in arg for arg in cmd)
    )
    assert "beat_01.mp3" not in " ".join(clip_cmd)
    assert clip_cmd.count("-i") == 1  # video only, no second -i for the mp3


def test_non_chain_beat_still_uses_per_beat_video(monkeypatch, tmp_path):
    from novelvideo.task_backend.runners import video

    _write_beat_video(tmp_path, episode=1, beat_num=5)
    manager = _FakeTaskManager()
    commands = []

    def fake_run(cmd, **_kwargs):
        commands.append(cmd)
        if cmd[0] == "ffprobe":
            return SimpleNamespace(returncode=0, stdout="0\n", stderr="")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(video, "get_task_manager", lambda: manager)
    monkeypatch.setattr(video, "run_project_subprocess", fake_run)

    video.run_compose_episode(
        {
            "episode": 1,
            "payload": {"output_dir": str(tmp_path), "beats": [{"beat_number": 5}]},
        },
        _ctx(tmp_path),
    )

    assert any(
        cmd[0] == "ffmpeg" and "beat_0005.mp4" in cmd[-1] for cmd in commands
    )
