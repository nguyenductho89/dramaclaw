"""Offload benchmark: H3 ref2va (turbo LoRA) on a 24/32 GB card, to measure the cost of streaming DiT weights over PCIe.

Same job on every card/flag set so the numbers compare: first frame = photo_f0.png, 1344x768, 124 frames, fixed seed.
Usage (the endpoint env must already carry the COMFY_EXTRA_ARGS under test):
  RUNPOD_H3_VIDEO_ENDPOINT_ID=<test endpoint> RUNPOD_H3_PDD_REF2VA= \
  RUNPOD_H3_TURBO_LORA_REF2VA=minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors RUNPOD_H3_TURBO_STEPS_REF2VA=6 \
  python research/h3_benchmarks/scripts/bench_offload.py <label>   # e.g. 4090_default
Writes research/h3_benchmarks/bench_offload_<label>.json. Per-step sampling time, VAE decode time and peak RAM are NOT here:
read them from the worker log (stream-worker-logs) and add them to the json by hand.
"""
import asyncio, json, sys, time
from pathlib import Path

R = Path(__file__).resolve().parents[3]
T = R / "research/h3_benchmarks"
LABEL = sys.argv[1] if len(sys.argv) > 1 else "run"

PROMPT = (
    "subject_definitions:\n<Picture 1> is the first frame of [Shot 1]: a stone courtyard at dusk, a tall man in a dark coat on the left, "
    "a woman in a red scarf on the right, matching <Picture 1> exactly in face, hair and clothing.\n\n"
    "summary:\nA 5-second 16:9 shot that begins from <Picture 1>. The woman turns toward the man and steps forward.\n\n"
    "retention_analysis:\n<Picture 1> ([Shot 1] first frame): fully_preserved - framing, people, costumes and lighting.\n\n"
    "detailed_description:\nLive-action film footage, naturalistic dusk lighting.\n"
    "[Shot 1] The shot begins from <Picture 1>, a medium-wide shot at eye level. At 0.00 seconds, both stand still. "
    "At 1.50 seconds, the woman turns her head toward the man. At 3.00 seconds, the man nods. At 5.00 seconds, the woman steps forward. "
    "Natural real-time speed, no subtitles, text or watermarks.\n\n"
    "overall_soundscape:\nSoft evening ambience, quiet footsteps.\n\nnon_diegetic_music:\nN/A"
)


async def main():
    sys.path.insert(0, str(R / "src"))
    from novelvideo.generators.runpod_minimax_h3_video import RunPodMiniMaxH3VideoGenerator
    from novelvideo.generators.video_generator import ShotReference
    out = T / f"bench_offload_{LABEL}.mp4"
    rec = {"label": LABEL, "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "logs": []}
    t0 = time.time()
    res = await RunPodMiniMaxH3VideoGenerator().generate(
        image_path=str(T / "photo_f0.png"), prompt=PROMPT, output_path=str(out), aspect_ratio="16:9", duration=5.17,
        references=[ShotReference(type="image", path=str(T / "photo_f0.png"), role="character_reference")],
        h3_mode="ref2va", two_stage=False, audio_refine=False, on_log=lambda m: rec["logs"].append(f"{time.time() - t0:7.1f}s {m}"))
    rec.update(wall_seconds=round(time.time() - t0, 1), status=str(getattr(res, "status", None)), error=getattr(res, "error", None),
               video_bytes=out.stat().st_size if out.exists() else 0)
    (T / f"bench_offload_{LABEL}.json").write_text(json.dumps(rec, indent=2, ensure_ascii=False, default=str))
    print(json.dumps({k: v for k, v in rec.items() if k != "logs"}, indent=2, default=str))


asyncio.run(main())
