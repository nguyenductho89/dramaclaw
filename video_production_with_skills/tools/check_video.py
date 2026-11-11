#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = ["faster-whisper", "resemblyzer", "setuptools<81", "numpy<2.3", "opencv-python-headless>=4.9", "librosa", "soundfile"]
# ///
"""Objective checks for episode videos and keyframe images: who spoke each line, what was said, extra
speech, and each face.

  uv run video_production_with_skills/tools/check_video.py <chain_name> <video.mp4> [<chain_name> <video.mp4> ...]
  uv run video_production_with_skills/tools/check_video.py --storyboard <image.png> [<image.png> ...]

<chain_name> is the JSON name in <episode>/chains/ (chain_01, chain_02, ...). The episode is picked with SERIES and EP
(default science_humor and ep01). Per shot it reports:
- the words H3 spoke (faster-whisper base.en) against the script line, as a 0-1 match;
- which voice spoke each segment (Resemblyzer cosine to assets/voices/einstein.wav and newton.wav) against the expected speaker;
- speech that starts after the line should have ended (the extra-speech defect);
- from frames in the shot, how many faces YuNet finds and the SFace cosine of each face to both character sheets.

`--storyboard` runs only the face check, against Qwen keyframe candidates
(<episode>/keyframes/images/candidates/*.png) BEFORE spending any GPU on them — it exists so a candidate with the
wrong face (or a missing/extra face) can be ruled out while picking, not after rendering H3 on top of it.

Cosine guides only: SFace same-person threshold is 0.363 and it cannot tell two looks of one person apart.
"""
import difflib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SERIES_DIR = ROOT / "video_production_with_skills/series" / os.environ.get("SERIES", "science_humor")
EP_DIR = SERIES_DIR / os.environ.get("EP", "ep01")
REPORTS = EP_DIR / "reports"
FPS = 24.0
SPEECH_END_TOLERANCE = 0.4  # seconds after the scripted end before speech counts as extra
FACE_MODELS = None


def expected_shots(chain: dict) -> list[dict]:
    frames = int(chain["frames"])
    out = []
    for i, shot in enumerate(chain["shots"]):
        m = re.search(r"At ([\d.]+) seconds <Subject (\d)> \(S\d\) says it .*?<d>\[English\] (.*?)</d>", shot)
        end = re.search(r"At ([\d.]+) seconds <Subject \d> finishes", shot)
        out.append({"index": i + 1, "start_s": i * frames / FPS, "length_s": frames / FPS,
                    "speaker": "einstein" if m.group(2) == "1" else "newton", "text": m.group(3),
                    "line_start": float(m.group(1)), "line_end": float(end.group(1))})
    return out


def norm(text: str) -> str:
    return re.sub(r"[^a-z' ]", "", text.lower().replace("15", "fifteen")).strip()


def audio_of(video: Path, tmp: Path):
    import librosa
    wav = tmp / (video.stem + ".wav")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(video), "-ac", "1", "-ar", "16000", str(wav)], check=True)
    audio, _ = librosa.load(str(wav), sr=16000, mono=True)
    return wav, audio.astype(np.float32)


def face_tools():
    global FACE_MODELS
    if FACE_MODELS is None:
        import cv2
        sys.path.insert(0, str(ROOT / "scripts"))
        import face_similarity as fs
        paths = fs.ensure_models()
        det = cv2.FaceDetectorYN.create(str(paths["face_detection_yunet_2023mar.onnx"]), "", (320, 320), 0.5)
        rec = cv2.FaceRecognizerSF.create(str(paths["face_recognition_sface_2021dec.onnx"]), "")
        FACE_MODELS = (cv2, fs, det, rec)
    return FACE_MODELS


def faces_in(image):
    cv2, fs, det, rec = face_tools()
    for scale in (1, 2):
        work = image if scale == 1 else cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        det.setInputSize((work.shape[1], work.shape[0]))
        _ok, faces = det.detect(work)
        if faces is not None and len(faces):
            return [(float(f[0]) / scale, int(f[3]) // scale, fs.embedding(cv2, rec, work, f)) for f in faces]
    return []


def sheet_embeddings():
    """Per character, embeddings of every face found in its sheet (three views)."""
    cv2, fs, det, rec = face_tools()
    refs = {}
    for name in ("einstein", "newton"):
        img = cv2.imread(str(SERIES_DIR / "assets" / "characters" / f"{name}_sheet.png"))
        refs[name] = [e for _x, _h, e in faces_in(img)] if img is not None else []
    return refs


def check_storyboard(image_paths: list[str]) -> int:
    """Face-only check for Gemini storyboard candidates, before any H3 render. For each image: how many faces
    YuNet finds (left to right) and each one's SFace cosine to both character sheets — same metric and threshold
    `main()` reports per H3 frame, just run directly on the candidate PNG."""
    cv2, fs, det, rec = face_tools()
    sheets = sheet_embeddings()
    print("faces found in sheets:", {k: len(v) for k, v in sheets.items()})
    report = {}
    for path in image_paths:
        img = cv2.imread(path)
        if img is None:
            print(f"{path}: could not read image")
            continue
        found = sorted(faces_in(img), key=lambda f: f[0])  # left to right
        cells = [{"x": round(x), "px": h,
                  **{n: round(max((float(rec.match(e, r, cv2.FaceRecognizerSF_FR_COSINE)) for r in sheets[n]), default=-1), 2) for n in sheets}}
                 for x, h, e in found]
        report[path] = cells
        print(f"{path}: {len(cells)} face(s) left->right: {cells}")
    REPORTS.mkdir(parents=True, exist_ok=True)
    out = REPORTS / "keyframe_check_report.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1) + "\n")
    print("\nwritten", out)
    return 0


def main() -> int:
    args = sys.argv[1:]
    if args and args[0] == "--storyboard":
        # Dispatched before the faster-whisper/resemblyzer imports below: storyboard candidates need only the
        # (much lighter, already-loaded-by-face_tools) face check, not the whisper/voice models the video path needs.
        return check_storyboard(args[1:])

    from faster_whisper import WhisperModel
    from resemblyzer import VoiceEncoder, preprocess_wav

    if not args or len(args) % 2:
        sys.exit(__doc__)
    cv2, fs, det, rec = face_tools()
    whisper = WhisperModel("base.en", device="cpu", compute_type="int8")
    enc = VoiceEncoder("cpu")
    voices = {n: enc.embed_utterance(preprocess_wav(SERIES_DIR / "assets" / "voices" / f"{n}.wav")) for n in ("einstein", "newton")}
    print("voice refs cosine between the two characters:", round(float(np.dot(voices["einstein"], voices["newton"])), 2))
    sheets = sheet_embeddings()
    print("faces found in sheets:", {k: len(v) for k, v in sheets.items()})
    report = {}
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        for name, video in zip(args[::2], args[1::2]):
            chain = json.loads((EP_DIR / "chains" / f"{name}.json").read_text())
            wav, audio = audio_of(Path(video), tmp)
            segs, _ = whisper.transcribe(audio, word_timestamps=True)
            segs = list(segs)
            shots = expected_shots(chain)
            print(f"\n=== {name} ({video})")
            rows = []
            for shot in shots:
                lo, hi = shot["start_s"], shot["start_s"] + shot["length_s"]
                said, extra, who = [], [], []
                for seg in segs:
                    for w in seg.words or []:
                        mid = (w.start + w.end) / 2
                        if lo <= mid < hi:
                            rel = w.start - lo
                            (extra if rel > shot["line_end"] + SPEECH_END_TOLERANCE else said).append(w.word.strip())
                chunk = audio[int(lo * 16000):int(hi * 16000)]
                emb = None
                if len(chunk) > 16000:
                    try:
                        emb = enc.embed_utterance(preprocess_wav(chunk, source_sr=16000))
                    except Exception:
                        emb = None
                cos = {n: round(float(np.dot(emb, v)), 2) for n, v in voices.items()} if emb is not None else {}
                best = max(cos, key=cos.get) if cos else None
                match = difflib.SequenceMatcher(None, norm(" ".join(said)), norm(shot["text"])).ratio()
                # faces from three frames in the shot (1.5 s, 3.5 s, 5.0 s)
                face_rows = []
                for sec in (1.5, 3.5, 5.0):
                    cap = cv2.VideoCapture(str(video)); cap.set(cv2.CAP_PROP_POS_MSEC, (lo + sec) * 1000); ok, frame = cap.read(); cap.release()
                    if not ok:
                        continue
                    found = sorted(faces_in(frame), key=lambda f: f[0])  # left to right
                    cells = []
                    for x, h, e in found:
                        cells.append({"x": round(x), "px": h,
                                      **{n: round(max((float(rec.match(e, r, cv2.FaceRecognizerSF_FR_COSINE)) for r in sheets[n]), default=-1), 2) for n in sheets}})
                    face_rows.append({"t": sec, "faces": cells})
                row = {"shot": shot["index"], "expected_speaker": shot["speaker"], "voice_cosines": cos, "voice_best": best,
                       "voice_ok": best == shot["speaker"], "words_match": round(match, 2), "said": " ".join(said),
                       "extra_speech": " ".join(extra), "faces": face_rows}
                rows.append(row)
                print(f"shot {shot['index']}: speaker {shot['speaker']:8s} voice->{best} {cos}  match {match:.2f}")
                print(f"   said : {row['said']}")
                print(f"   want : {shot['text']}")
                if extra:
                    print(f"   EXTRA SPEECH after {shot['line_end'] + SPEECH_END_TOLERANCE:.1f}s: {row['extra_speech']}")
                for fr in face_rows:
                    print(f"   t={fr['t']}s faces left->right: {fr['faces']}")
            report[name] = rows
    REPORTS.mkdir(parents=True, exist_ok=True)
    out = REPORTS / "video_check_report.json"
    out.write_text(json.dumps(report, indent=1) + "\n")
    print("\nwritten", out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
