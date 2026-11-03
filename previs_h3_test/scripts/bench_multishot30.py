"""30 s H3 multishot (6 shots x 124 frames, fl2va, PDD 8) on a 24 GB card, to measure offload cost and peak RAM/VRAM.

The worker logs carry the memory samples (VRAMMON / RAMMON lines, see bench_offload_endpoint notes); this script only
records wall time and the job log. Run with the TEST endpoint:
  RUNPOD_H3_MULTISHOT_ENDPOINT_ID=<test endpoint> RUNPOD_H3_MULTISHOT_TIMEOUT_SECONDS=10800 \
  python previs_h3_test/scripts/bench_multishot30.py <label>
"""
import asyncio, json, sys, time
from pathlib import Path

R = Path(__file__).resolve().parents[2]
T = R / "previs_h3_test"
LABEL = sys.argv[1] if len(sys.argv) > 1 else "ms30"
HEAD = "integrated_multimodal_description:\nLive-action film footage, naturalistic dusk lighting, realistic detail, natural skin tones.\n"
TAIL = ("All motion happens at natural real-time speed, not slow motion. The camera holds this framing until the final frame. "
        "There are no subtitles, captions, on-screen text, logos or watermarks anywhere in frame.\n\n"
        "overall_soundscape:\nSoft evening ambience, a faint breeze, quiet footsteps on stone.\n\nnon_diegetic_music:\nN/A")
BEATS = [
    "The shot begins from <Picture 1>: a medium-wide shot at eye level of a tall man in a dark wool coat and a shorter woman in a red scarf and beige trench coat in a stone courtyard at dusk. The camera slowly dollies in. At 0.00 seconds the two stand still. At 1.50 seconds the woman turns her head toward the man. At 3.00 seconds the man nods. At 5.00 seconds the woman steps toward the wooden crate.",
    "Same courtyard, same man and woman beside the wooden crate, medium shot. At 0.00 seconds the woman rests one hand on the crate. At 2.00 seconds the man steps forward and looks down at it. At 4.00 seconds the woman looks up at him and smiles slightly.",
    "Same courtyard, close two-shot of the same man and woman. At 0.00 seconds both look at the crate. At 1.50 seconds the man crouches and runs his fingers along its lid. At 3.50 seconds the woman kneels beside him and points at a latch.",
    "Same courtyard, medium shot from the side. At 0.00 seconds the man lifts the lid a few centimeters. At 2.00 seconds a thin line of warm light spills out across his face. At 4.00 seconds the woman leans in and the light catches her red scarf.",
    "Same courtyard, medium-wide shot, the camera slowly pulls back. At 0.00 seconds the man lets the lid fall closed. At 2.50 seconds both stand up and look toward the dark archway at the back. At 4.50 seconds the woman steps toward the archway.",
    "Same courtyard, medium-wide shot from behind the two figures. At 0.00 seconds the man follows the woman toward the archway. At 2.50 seconds they stop together at its edge. At 4.50 seconds the woman glances back once at the crate before they continue into the shadow.",
]
SHOTS = [HEAD + f"[Shot 1] {b} " + TAIL for b in BEATS]


async def main():
    sys.path.insert(0, str(R / "src"))
    from novelvideo.generators.runpod_minimax_h3_multishot_video import (
        run_multishot_from_files, dims_for_multishot, multishot_sampling_plan, join_shots_script, new_seed)
    w, h = dims_for_multishot("16:9")
    sampling = multishot_sampling_plan("fl2va")
    rec = {"label": LABEL, "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "resolution": f"{w}x{h}", "shots": len(SHOTS),
           "frames_per_shot": 124, "sampling": sampling, "logs": []}
    t0 = time.time()
    data, info, err = await run_multishot_from_files(
        script=join_shots_script(SHOTS), shot_count=len(SHOTS), width=w, height=h, frames_per_shot=124, seed=1234, checkpoint="fl2va",
        sampling=sampling, start_image_path=str(T / "photo_f0.png"), reference_image_paths=[],
        on_log=lambda m: rec["logs"].append(f"{time.time() - t0:7.1f}s {m}"), fit_start_image=True)
    rec.update(wall_seconds=round(time.time() - t0, 1), runpod_status=info, error=err or None, video_bytes=len(data or b""))
    if data:
        (T / f"bench_{LABEL}.mp4").write_bytes(data)
    (T / f"bench_{LABEL}.json").write_text(json.dumps(rec, indent=2, ensure_ascii=False, default=str))
    print(json.dumps({k: v for k, v in rec.items() if k != "logs"}, indent=2, default=str))


asyncio.run(main())
