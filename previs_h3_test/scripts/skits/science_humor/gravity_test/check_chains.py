#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = ["faster-whisper", "resemblyzer", "setuptools<81", "numpy<2.3", "opencv-python-headless>=4.9", "librosa", "soundfile"]
# ///
"""Objective checks for the gravity test videos: who spoke each line, what was said, extra speech, and each face.

  uv run previs_h3_test/scripts/skits/science_humor/gravity_test/check_chains.py <chain_name> <video.mp4> [<chain_name> <video.mp4> ...]

<chain_name> is the JSON name in gravity_test/ (chain_01, chain_01_refs_only, ...). Per shot it reports:
- the words H3 spoke (faster-whisper base.en) against the script line, as a 0-1 match;
- which voice spoke each segment (Resemblyzer cosine to voice/barnaby.wav and voice/ambrose.wav) against the expected speaker;
- speech that starts after the line should have ended (the extra-speech defect from the ep01 test);
- from frames in the shot, how many faces YuNet finds and the SFace cosine of each face to both character sheets.
Cosine guides only: SFace same-person threshold is 0.363 and it cannot tell two looks of one person apart.
"""
import difflib
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[5]
SKIT = ROOT / "previs_h3_test/scripts/skits/science_humor"
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
                    "speaker": "barnaby" if m.group(2) == "1" else "ambrose", "text": m.group(3),
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
    for name in ("barnaby", "ambrose"):
        img = cv2.imread(str(SKIT / "character" / f"{name}_sheet.png"))
        refs[name] = [e for _x, _h, e in faces_in(img)] if img is not None else []
    return refs


def main() -> int:
    from faster_whisper import WhisperModel
    from resemblyzer import VoiceEncoder, preprocess_wav

    args = sys.argv[1:]
    if not args or len(args) % 2:
        sys.exit(__doc__)
    cv2, fs, det, rec = face_tools()
    whisper = WhisperModel("base.en", device="cpu", compute_type="int8")
    enc = VoiceEncoder("cpu")
    voices = {n: enc.embed_utterance(preprocess_wav(SKIT / "voice" / f"{n}.wav")) for n in ("barnaby", "ambrose")}
    print("voice refs cosine between the two characters:", round(float(np.dot(voices["barnaby"], voices["ambrose"])), 2))
    sheets = sheet_embeddings()
    print("faces found in sheets:", {k: len(v) for k, v in sheets.items()})
    report = {}
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        for name, video in zip(args[::2], args[1::2]):
            chain = json.loads((SKIT / "gravity_test" / f"{name}.json").read_text())
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
    out = SKIT / "gravity_test" / "check_report.json"
    out.write_text(json.dumps(report, indent=1) + "\n")
    print("\nwritten", out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
