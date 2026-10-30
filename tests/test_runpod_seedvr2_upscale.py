import subprocess

import numpy as np
import pytest

from novelvideo.generators import runpod_seedvr2_upscale as m


def test_plan_covers_clip_with_overlap_and_full_length_segments():
    segs = m.plan_segments(124, 41, 8)
    assert segs[0].start == 0 and segs[-1].end == 124
    assert all(s.length == 41 for s in segs)
    for a, b in zip(segs, segs[1:]):
        assert a.end - b.start >= 8


def test_plan_short_clip_is_one_segment():
    assert m.plan_segments(33, 41, 8) == [m.Segment(0, 33)]


@pytest.mark.parametrize("frames", [40, 4, 2])
def test_plan_rejects_non_4n1_segment(frames):
    with pytest.raises(ValueError):
        m.plan_segments(124, frames, 1)


def test_crossfade_weights_go_from_prev_to_next():
    w = m.crossfade_weights(9)
    assert w[0] == pytest.approx(1.0) and w[-1] == pytest.approx(0.0)
    assert np.all(np.diff(w) <= 1e-6)


def test_stitch_identical_overlaps_reproduces_source():
    rng = np.random.default_rng(0)
    clip = rng.integers(0, 256, size=(124, 4, 6, 3), dtype=np.uint8)
    segs = m.plan_segments(124, 41, 8)
    out = m.stitch_segments(segs, [clip[s.start : s.end] for s in segs])
    assert np.array_equal(out, clip)


def test_stitch_blends_inside_overlap_only():
    segs = [m.Segment(0, 9), m.Segment(5, 14)]
    a = np.zeros((9, 1, 1, 3), np.uint8)
    b = np.full((9, 1, 1, 3), 200, np.uint8)
    out = m.stitch_segments(segs, [a, b])
    assert (out[:5] == 0).all() and (out[9:] == 200).all()
    assert out[5, 0, 0, 0] == 0 and out[8, 0, 0, 0] == 200


@pytest.mark.parametrize("total,seg,ov", [(124, 41, 8), (841, 41, 8), (60, 41, 8), (33, 41, 8), (100, 21, 20)])
def test_iter_stitched_matches_stitch_segments(total, seg, ov):
    rng = np.random.default_rng(total)
    segs = m.plan_segments(total, seg, ov)
    # Different content per segment so the crossfade is actually exercised.
    per_seg = [rng.integers(0, 256, size=(s.length, 4, 6, 3), dtype=np.uint8) for s in segs]
    expected = m.stitch_segments(segs, per_seg)
    chunks = list(m.iter_stitched(segs, iter(per_seg)))
    assert np.array_equal(np.concatenate(chunks), expected)
    assert max(c.shape[0] for c in chunks) <= seg


def test_iter_stitched_rejects_short_segment():
    segs = m.plan_segments(124, 41, 8)
    bad = [np.zeros((s.length - (1 if i == 1 else 0), 2, 2, 3), np.uint8) for i, s in enumerate(segs)]
    with pytest.raises(ValueError):
        list(m.iter_stitched(segs, iter(bad)))


def test_graph_has_no_temporal_chunk_and_uses_requested_model():
    g = m.build_seedvr2_segment_graph(video_name="v.mp4", unet_name=m.SEEDVR2_7B_UNET, seed=1)
    types = {n["class_type"] for n in g.values()}
    assert "SeedVR2TemporalChunk" not in types
    assert {"SeedVR2Preprocess", "SeedVR2Conditioning", "SeedVR2PostProcessing", "VAEEncodeTiled", "VAEDecodeTiled"} <= types
    assert g["3"]["inputs"]["unet_name"] == m.SEEDVR2_7B_UNET
    assert g["8"]["inputs"]["latent_image"] == ["6", 0]


def test_ffmpeg_cut_and_roundtrip(tmp_path):
    src = tmp_path / "src.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=24:duration=2",
         "-pix_fmt", "yuv420p", str(src)],
        check=True,
    )
    w, h, fps, n = m.probe_video(src)
    assert (w, h, n) == (64, 48, 48) and fps == pytest.approx(24)
    seg = m.Segment(10, 31)
    out = tmp_path / "seg.mp4"
    m.cut_resized_segment(src, out, seg, 128, 96, fps)
    assert m.probe_video(out)[::3] == (128, 21)


async def test_orchestrator_with_fake_runpod_resumes_and_keeps_audio(tmp_path, monkeypatch):
    from novelvideo.generators import nanobanana_grid

    src = tmp_path / "src.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=24:duration=5",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-pix_fmt", "yuv420p", "-shortest", str(src)],
        check=True,
    )
    calls = []

    async def fake_job(*, upload_batch, label, graph, **_):
        calls.append(label)
        assert "SeedVR2TemporalChunk" not in {n["class_type"] for n in graph.values()}
        return upload_batch[0][1], "", ""

    monkeypatch.setattr(nanobanana_grid, "_runpod_run_graph_job", fake_job)
    work = tmp_path / "work"
    dst = tmp_path / "out.mp4"
    res = await m.upscale_video_chunked(src, dst, scale=2.0, work_dir=work, endpoint_id="x")
    assert res.error == "" and len(calls) == len(res.segments) == 4
    w, h, _, n = m.probe_video(dst)
    assert (w, h, n) == (128, 96, 120)
    audio = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type",
                            "-of", "csv=p=0", str(dst)], capture_output=True, text=True).stdout
    assert "audio" in audio

    calls.clear()
    await m.upscale_video_chunked(src, tmp_path / "out2.mp4", scale=2.0, work_dir=work, endpoint_id="x")
    assert calls == []  # cached segments are not re-sent
