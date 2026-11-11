"""Variant B: Three.js previs VIDEO as H3 `<Video 1>` reference (ref2va, 1-shot).

First frame `<Picture 1>` = the Qwen photoreal frame. `<Video 1>` = previs_shot1.mp4 (low-poly dolly-in).
Writes benchmark_video_ref.json, video_h3_ref2va_previs.mp4, then commits/pushes.
Run with RUNPOD_H3_PDD_REF2VA= (empty, base/turbo path) and the turbo LoRA env, see run command in README note.
"""
import asyncio, json, os, subprocess, sys, time
from pathlib import Path

R = Path("/home/user/dramaclaw"); T = R / "research/h3_benchmarks"; LOG = T / "pipeline.log"
BENCH = T / "benchmark_video_ref.json"
BM = {"variant": "B: previs video as <Video 1> (ref2va)", "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "stages": {}}


def log(m):
    with open(LOG, "a") as f:
        f.write(f"{time.strftime('%H:%M:%S')} [video_ref] {m}\n")


def save():
    BENCH.write_text(json.dumps(BM, indent=2, ensure_ascii=False, default=str))


def git_push(msg):
    for cmd in (["git", "add", "research/h3_benchmarks"],
                ["git", "commit", "-m", msg + "\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01EhYzmkcHeqvJMs2Bxq6Avb"],
                ["git", "push", "-u", "origin", "claude/gracious-darwin-bj3gkz"]):
        r = subprocess.run(cmd, cwd=R, capture_output=True, text=True)
        log(f"{cmd[1]} rc={r.returncode}")


PROMPT = (
    "subject_definitions:\n"
    "<Picture 1> is the first frame of [Shot 1], a stone-paved courtyard at dusk with an old brick wall behind, a tall man in a dark wool coat on the left, "
    "a shorter woman in a red scarf and beige trench coat on the right, and a wooden crate at the far right.\n"
    "<Video 1> is a rough low-polygon previsualization of the shot. It defines only the camera path (a slow dolly-in toward the two figures) and the blocking of the figures; "
    "its flat colors, geometry and low-poly look are not part of the target video and never appear on screen.\n\n"
    "summary:\n"
    "A 5-second 16:9 medium-wide shot that begins from <Picture 1>. The camera slowly dollies in, following the camera movement of <Video 1>, while the woman turns toward the man and steps toward the crate. "
    "Ends with the woman resting one hand on the crate.\n\n"
    "retention_analysis:\n"
    "<Picture 1> ([Shot 1] first frame): fully_preserved - the video starts exactly from its framing, people, costumes, wall, pavement and lighting.\n"
    "<Video 1> ([Shot 1]): attribute_transfer - camera movement and figure blocking only; no flat color, geometry or low-poly look is carried over.\n\n"
    "detailed_description:\n"
    "Live-action film footage, naturalistic dusk lighting, realistic detail, natural skin tones.\n"
    "[Shot 1] The shot begins from <Picture 1>: a medium-wide shot at eye level. The camera slowly dollies in toward the two figures, matching the camera movement of <Video 1>. "
    "At 0.00 seconds, the man and the woman stand still, the man on the left and the woman on the right. At 1.50 seconds, the woman turns her head toward the man. "
    "At 3.00 seconds, the man nods and lifts one hand slightly. At 5.00 seconds, the woman takes a small step toward the wooden crate. "
    "Do not replace character action with camera movement, lighting changes, particles, fog, or environmental effects. All motion happens at natural real-time speed, not slow motion. "
    "The camera holds this framing until the final frame. At 5.17 seconds, the woman rests one hand on the crate. "
    "There are no subtitles, captions, on-screen text, logos or watermarks anywhere in frame.\n\n"
    "overall_soundscape:\nSoft evening ambience, distant wind, quiet footsteps on stone.\n\n"
    "non_diegetic_music:\nN/A"
)


async def main():
    sys.path.insert(0, str(R / "src"))
    from novelvideo.generators.runpod_minimax_h3_video import RunPodMiniMaxH3VideoGenerator
    from novelvideo.generators.video_generator import ShotReference
    from novelvideo.config import (RUNPOD_H3_VIDEO_ENDPOINT_ID, RUNPOD_H3_PDD_REF2VA, RUNPOD_H3_TURBO_LORA_REF2VA, RUNPOD_H3_TURBO_STEPS_REF2VA)
    BM["config"] = {"endpoint": RUNPOD_H3_VIDEO_ENDPOINT_ID, "pdd_ref2va": RUNPOD_H3_PDD_REF2VA, "turbo_lora": RUNPOD_H3_TURBO_LORA_REF2VA,
                    "turbo_steps": RUNPOD_H3_TURBO_STEPS_REF2VA, "mode": "ref2va", "resolution": "1344x768 (16:9, formal)", "frames": 124,
                    "first_frame": "photo_f0.png (Qwen photoreal)", "ref_video": "previs_shot1.mp4 (Three.js previs, 124 frames @24fps)"}
    save()
    out = T / "video_h3_ref2va_previs.mp4"
    gen = RunPodMiniMaxH3VideoGenerator()
    t0 = time.time(); BM["stages"]["h3_ref2va"] = {"wall_start_utc": time.strftime("%H:%M:%S", time.gmtime())}; save()
    res = await gen.generate(
        image_path=str(T / "photo_f0.png"), prompt=PROMPT, output_path=str(out), aspect_ratio="16:9", duration=5.17,
        references=[ShotReference(type="video", path=str(T / "previs_shot1.mp4"), role="motion_reference")],
        h3_mode="ref2va", two_stage=False, audio_refine=False, on_log=lambda m: log(f"job: {m}"))
    BM["stages"]["h3_ref2va"].update({"wall_seconds": round(time.time() - t0, 1), "status": str(getattr(res, "status", None)), "error": getattr(res, "error", None)})
    if out.exists():
        pr = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,width,height,r_frame_rate,nb_frames,duration:format=duration,size", "-of", "json", str(out)], capture_output=True, text=True)
        try:
            BM["stages"]["h3_ref2va"]["ffprobe"] = json.loads(pr.stdout)
        except Exception:
            pass
        log(f"video ok {out.stat().st_size} bytes")
    else:
        log(f"FAILED: {getattr(res, 'error', None)}")
    save()
    git_push("previs h3 test: variant B (previs video as <Video 1>)" if out.exists() else "previs h3 test: variant B log (failed)")


asyncio.run(main())
