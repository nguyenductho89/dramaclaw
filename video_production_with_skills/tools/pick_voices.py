#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = ["resemblyzer", "setuptools<81", "numpy<2.3"]
# ///
"""Score every Einstein-candidate x Newton-candidate pair by Resemblyzer cross-cosine, pick the lowest
(most different-sounding) pair, and copy those two files to <voice_dir>/einstein.wav and <voice_dir>/newton.wav.

  uv run video_production_with_skills/tools/pick_voices.py <einstein_cands_dir> <newton_cands_dir> <voice_dir>

Writes <voice_dir>/voice_pick_report.json with the full cosine matrix so the pick can be reviewed/overridden later.
"""
import json
import shutil
import sys
from pathlib import Path

import numpy as np
from resemblyzer import VoiceEncoder, preprocess_wav


def main() -> int:
    bdir, adir, voice_dir = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    b_files = sorted(p for p in bdir.glob("*.wav"))
    a_files = sorted(p for p in adir.glob("*.wav"))
    if not b_files or not a_files:
        sys.exit(f"no wav candidates found in {bdir} or {adir}")
    enc = VoiceEncoder("cpu")
    b_emb = {p.stem: enc.embed_utterance(preprocess_wav(p)) for p in b_files}
    a_emb = {p.stem: enc.embed_utterance(preprocess_wav(p)) for p in a_files}
    matrix = {bn: {an: round(float(np.dot(be, ae)), 3) for an, ae in a_emb.items()} for bn, be in b_emb.items()}
    best_pair, best_cos = None, 2.0
    for bn, row in matrix.items():
        for an, cos in row.items():
            if cos < best_cos:
                best_cos, best_pair = cos, (bn, an)
    bn, an = best_pair
    voice_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy(bdir / f"{bn}.wav", voice_dir / "einstein.wav")
    shutil.copy(adir / f"{an}.wav", voice_dir / "newton.wav")
    report = {"matrix": matrix, "chosen": {"einstein": bn, "newton": an, "cross_cosine": round(best_cos, 3)}}
    (voice_dir / "voice_pick_report.json").write_text(json.dumps(report, indent=1) + "\n")
    print(json.dumps(report, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
