# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = ["qwen-tts", "soundfile"]
# ///
"""Design narrator voices with the open Qwen3-TTS VoiceDesign model; each clip is a candidate H3 voice_ref.

  uv run video_production_with_skills/tools/qwen_voice_design.py video_production_with_skills/series/science_humor/assets/voices [voices_config.json]

The hosted Voice Design API answered "Model not exist" on this account (2026-11-04), so this runs the Apache-2.0 model
`Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` locally. Device: cuda if present, otherwise cpu (override with TTS_DEVICE).
Writes <name>.wav and voices.json into the output directory.
"""
import json
import os
import sys
import time
from pathlib import Path

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"
SEED = 1234
# Not a line from the script: the pack warns a voice anchor can get re-spoken, so the clip must not match any <d> text.
TEXT = ("In my youth I walked alone through the fields of Lincolnshire, counting the hours by the shadow on the wall. "
        "Now my hands are old, and still I wonder at the quiet order of the world.")
BASE = ("An elderly English man in his eighties, speaking with a refined, traditional British English accent, "
        "unhurried, calm and reflective, like an old scholar recalling his life, in a quiet room. ")
VOICES = {
    "dryraspy": BASE + "Thin, dry, slightly raspy voice with a medium pitch and clear articulation.",
    "deepworn": BASE + "Low, worn, gravelly voice with a deep pitch and a slight tremble of age.",
    "reedysoft": BASE + "Soft, reedy, breathy voice with a higher pitch and a precise, fastidious diction.",
}


def main() -> None:
    out = Path(sys.argv[1])
    # Optional second argument: JSON file {"text": ..., "voices": {name: instruct}} to design other characters' voices.
    text, voices = TEXT, VOICES
    if len(sys.argv) > 2:
        cfg = json.loads(Path(sys.argv[2]).read_text())
        text, voices = cfg["text"], cfg["voices"]
    out.mkdir(parents=True, exist_ok=True)
    device = os.environ.get("TTS_DEVICE") or ("cuda:0" if torch.cuda.is_available() else "cpu")
    dtype = torch.bfloat16 if device.startswith("cuda") else torch.float32
    t0 = time.time()
    model = Qwen3TTSModel.from_pretrained(MODEL, device_map=device, dtype=dtype)
    print(f"loaded on {device} in {time.time() - t0:.0f}s", flush=True)
    meta = {"model": MODEL, "device": device, "seed": SEED, "text": text, "voices": {}}
    for name, instruct in voices.items():
        t0 = time.time()
        torch.manual_seed(SEED)
        wavs, sr = model.generate_voice_design(text=text, language="English", instruct=instruct)
        sf.write(out / f"{name}.wav", wavs[0], sr)
        secs = len(wavs[0]) / sr
        meta["voices"][name] = {"instruct": instruct, "seconds": round(secs, 2), "generate_s": round(time.time() - t0, 1)}
        print(f"{name}: {secs:.1f}s audio in {time.time() - t0:.0f}s", flush=True)
        (out / "voices.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False) + "\n")


main()
