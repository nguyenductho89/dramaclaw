# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = ["qwen-tts", "soundfile"]
# ///
"""Voiceover lines in a designed character's voice, cloned with the Apache-2.0 Qwen3-TTS Base model.

  uv run previs_h3_test/scripts/qwen_voice_clone.py <voice_ref.wav> <ref_text.txt> <lines.json> <out_dir>

lines.json maps clip name to text. Writes <out_dir>/<name>.wav. Device: cuda if present, otherwise cpu (override with TTS_DEVICE).
"""
import json
import os
import sys
import time
from pathlib import Path

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
SEED = 1234


def main() -> None:
    ref_audio, ref_text, lines, out = sys.argv[1], Path(sys.argv[2]).read_text().strip(), json.loads(Path(sys.argv[3]).read_text()), Path(sys.argv[4])
    out.mkdir(parents=True, exist_ok=True)
    device = os.environ.get("TTS_DEVICE") or ("cuda:0" if torch.cuda.is_available() else "cpu")
    dtype = torch.bfloat16 if device.startswith("cuda") else torch.float32
    model = Qwen3TTSModel.from_pretrained(MODEL, device_map=device, dtype=dtype)
    for name, text in lines.items():
        t0 = time.time()
        torch.manual_seed(SEED)
        wavs, sr = model.generate_voice_clone(text=text, language="English", ref_audio=ref_audio, ref_text=ref_text)
        sf.write(out / f"{name}.wav", wavs[0], sr)
        print(f"{name}: {len(wavs[0]) / sr:.1f}s audio in {time.time() - t0:.0f}s", flush=True)


main()
