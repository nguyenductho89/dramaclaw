"""Autonomous: wait/retry Qwen photo -> H3 multishot (fl2va, 2 shots) -> save -> git push."""
import asyncio, os, subprocess, sys, time
from pathlib import Path
R = Path("/home/user/dramaclaw"); T = R / "previs_h3_test"; LOG = T / "pipeline.log"
def log(m):
    with open(LOG, "a") as f: f.write(f"{time.strftime('%H:%M:%S')} {m}\n")
def git_push(msg):
    for cmd in (["git","add","previs_h3_test"],["git","commit","-m",msg+"\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01EhYzmkcHeqvJMs2Bxq6Avb"],["git","push","-u","origin","claude/gracious-darwin-bj3gkz"]):
        r = subprocess.run(cmd, cwd=R, capture_output=True, text=True); log(f"{cmd[1]} rc={r.returncode} {r.stderr[-200:]}")
PHOTO = T / "photo_f0.png"
SHOT1 = ("integrated_multimodal_description:\nLive-action film footage, naturalistic dusk lighting, realistic detail, natural skin tones.\n"
"[Shot 1] The shot begins from <Picture 1>: a medium-wide shot at eye level of a tall man in a dark wool coat and a shorter woman in a red scarf and beige trench coat in a stone courtyard at dusk. "
"The camera slowly dollies in toward them. At 0.00 seconds, the two stand still, the man on the left and the woman on the right. At 1.50 seconds, the woman turns her head toward the man. "
"At 3.00 seconds, the man nods and lifts one hand slightly. At 5.00 seconds, the woman takes a small step toward the wooden crate on the right. "
"Do not replace character action with camera movement, lighting changes, particles, fog, or environmental effects. All motion happens at natural real-time speed, not slow motion. "
"The camera holds this framing until the final frame. At 5.17 seconds, the woman rests one hand on the crate. There are no subtitles, captions, on-screen text, logos or watermarks anywhere in frame.\n\n"
"overall_soundscape:\nSoft evening ambience, distant wind, quiet footsteps on stone.\n\nnon_diegetic_music:\nN/A")
SHOT2 = ("integrated_multimodal_description:\nLive-action film footage, naturalistic dusk lighting, realistic detail, natural skin tones.\n"
"[Shot 1] The shot continues in the same stone courtyard at dusk with the same tall man in a dark wool coat and the same shorter woman in a red scarf and beige trench coat beside the wooden crate. "
"A medium shot at eye level, the camera holds steady. At 0.00 seconds, the woman rests one hand on the crate while the man stands a pace behind her. At 2.00 seconds, the man steps forward and looks down at the crate. "
"At 4.00 seconds, the woman looks up at him and gives a small smile. All motion happens at natural real-time speed, not slow motion. "
"The camera holds this framing until the final frame. At 5.17 seconds, both look at the crate. There are no subtitles, captions, on-screen text, logos or watermarks anywhere in frame.\n\n"
"overall_soundscape:\nSoft evening ambience, a faint breeze, a quiet wooden creak.\n\nnon_diegetic_music:\nN/A")
async def main():
    sys.path.insert(0, str(R / "src"))
    # 1) photo: wait for the already-running render, else retry up to 6 times
    for attempt in range(6):
        t0 = time.time()
        while not PHOTO.exists() and time.time() - t0 < 1700:
            running = subprocess.run(["pgrep","-f","^[^ ]*python[^ ]* [^ ]*qwen_render[.]py"],capture_output=True).stdout.strip()
            if not running: break
            await asyncio.sleep(20)
        if PHOTO.exists(): break
        log(f"photo missing, launching qwen_render attempt {attempt+1}")
        subprocess.run([str(R/".venv/bin/python"), str(T/"scripts/qwen_render.py"), "/tmp/claude-0/-home-user-dramaclaw/67ca8485-b069-53b4-8729-882b0a4e87a6/scratchpad"], env={**os.environ,"PYTHONPATH":str(R/"src")}, timeout=1800, capture_output=True)
        src = Path("/tmp/claude-0/-home-user-dramaclaw/67ca8485-b069-53b4-8729-882b0a4e87a6/scratchpad/photo_f0.png")
        if src.exists(): PHOTO.write_bytes(src.read_bytes()); break
    src = Path("/tmp/claude-0/-home-user-dramaclaw/67ca8485-b069-53b4-8729-882b0a4e87a6/scratchpad/photo_f0.png")
    if not PHOTO.exists() and src.exists(): PHOTO.write_bytes(src.read_bytes())
    if not PHOTO.exists(): log("FAILED: no photo"); git_push("previs h3 test: pipeline log (photo failed)"); return
    log("photo ok"); git_push("previs h3 test: previs + photoreal frame")
    # 2) H3 multishot
    from novelvideo.generators.runpod_minimax_h3_multishot_video import (run_multishot_from_files, dims_for_multishot, multishot_sampling_plan, join_shots_script, new_seed)
    w, h = dims_for_multishot("16:9"); sampling = multishot_sampling_plan("fl2va"); log(f"sampling={sampling} {w}x{h}")
    data, info, err = await run_multishot_from_files(script=join_shots_script([SHOT1, SHOT2]), shot_count=2, width=w, height=h, frames_per_shot=124,
        seed=new_seed(), checkpoint="fl2va", sampling=sampling, start_image_path=str(PHOTO), reference_image_paths=[], on_log=lambda m: log(f"job: {m}"), fit_start_image=True)
    if data: (T/"video_h3_multishot.mp4").write_bytes(data); log(f"video ok {len(data)} bytes")
    else: log(f"FAILED video: {err}")
    git_push("previs h3 test: H3 multishot video" if data else "previs h3 test: video failed log")
asyncio.run(main())
