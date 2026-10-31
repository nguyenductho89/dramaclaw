#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["opencv-python-headless>=4.9", "numpy"]
# ///
"""Face identity check: SFace cosine similarity between a reference and candidates.

Used to judge whether a generated image (Qwen render, video frame, ...) still shows
the character's face. Standalone on purpose: OpenCV is not a project dependency, so
`uv run` supplies it for this one script.

    uv run scripts/face_similarity.py REFERENCE.png CANDIDATE.png [CANDIDATE ...]
    uv run scripts/face_similarity.py ref.png out/*.png --json

* The reference may be a multi-panel identity sheet: the LARGEST detected face is
  used, which is the close-up panel.
* Candidates use their largest face too. Faces in wide shots are small, so detection
  retries on 2x and 3x upscales when nothing is found at native size.
* Score = SFace cosine. OpenCV's documented same-person threshold is 0.363; a
  higher score means closer. Scores from different frame sizes are only roughly
  comparable, so compare candidates of the same kind against the same reference.

Models (YuNet detector, SFace recognizer, from opencv/face_* on Hugging Face) are
downloaded once into `~/.cache/dramaclaw/face/` (override: DRAMACLAW_FACE_MODEL_DIR).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

MODELS = {
    "face_detection_yunet_2023mar.onnx": (
        "https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx",
        200_000,
    ),
    "face_recognition_sface_2021dec.onnx": (
        "https://huggingface.co/opencv/face_recognition_sface/resolve/main/face_recognition_sface_2021dec.onnx",
        30_000_000,
    ),
}
SAME_PERSON_COSINE = 0.363  # OpenCV zoo's documented SFace cosine threshold
UPSCALES = (1, 2, 3)


def model_dir() -> Path:
    return Path(os.environ.get("DRAMACLAW_FACE_MODEL_DIR") or Path.home() / ".cache" / "dramaclaw" / "face")


def ensure_models(directory: Path | None = None) -> dict[str, Path]:
    """Return the local path of each model, downloading missing/truncated ones."""
    directory = directory or model_dir()
    directory.mkdir(parents=True, exist_ok=True)
    paths: dict[str, Path] = {}
    for name, (url, min_bytes) in MODELS.items():
        path = directory / name
        if not path.is_file() or path.stat().st_size < min_bytes:
            print(f"downloading {name} ...", file=sys.stderr)
            tmp = path.with_suffix(".part")
            with urllib.request.urlopen(url, timeout=120) as resp, open(tmp, "wb") as out:
                out.write(resp.read())
            if tmp.stat().st_size < min_bytes:
                tmp.unlink(missing_ok=True)
                raise RuntimeError(f"{name}: download too small, refusing to use it")
            tmp.replace(path)
        paths[name] = path
    return paths


def largest_face(cv2, detector, image):
    """`(face_row, scale)` for the largest face found, trying upscales; else None."""
    for scale in UPSCALES:
        work = image if scale == 1 else cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        height, width = work.shape[:2]
        detector.setInputSize((width, height))
        _ok, faces = detector.detect(work)
        if faces is not None and len(faces):
            best = max(faces, key=lambda f: float(f[2]) * float(f[3]))
            return work, best
    return None


def embedding(cv2, recognizer, work, face):
    return recognizer.feature(recognizer.alignCrop(work, face))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("reference", type=Path)
    parser.add_argument("candidates", type=Path, nargs="+")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    args = parser.parse_args(argv)

    import cv2

    paths = ensure_models()
    detector = cv2.FaceDetectorYN.create(str(paths["face_detection_yunet_2023mar.onnx"]), "", (320, 320), 0.5)
    recognizer = cv2.FaceRecognizerSF.create(str(paths["face_recognition_sface_2021dec.onnx"]), "")

    def embed(path: Path):
        image = cv2.imread(str(path))
        if image is None:
            return None, None
        found = largest_face(cv2, detector, image)
        if found is None:
            return None, None
        work, face = found
        return embedding(cv2, recognizer, work, face), int(round(float(face[3])))

    ref_vec, ref_px = embed(args.reference)
    if ref_vec is None:
        print(f"no face found in reference {args.reference}", file=sys.stderr)
        return 2

    rows = []
    for path in args.candidates:
        vec, face_px = embed(path)
        if vec is None:
            rows.append({"file": str(path), "cosine": None, "face_px": None, "same_person": None})
            continue
        score = float(recognizer.match(ref_vec, vec, cv2.FaceRecognizerSF_FR_COSINE))
        rows.append({"file": str(path), "cosine": round(score, 3), "face_px": face_px, "same_person": score >= SAME_PERSON_COSINE})

    if args.json:
        print(json.dumps({"reference": str(args.reference), "reference_face_px": ref_px, "threshold": SAME_PERSON_COSINE, "results": rows}, indent=2))
        return 0
    print(f"reference: {args.reference} (face ~{ref_px}px)   same-person threshold: {SAME_PERSON_COSINE}")
    for row in rows:
        if row["cosine"] is None:
            print(f"  no face       {row['file']}")
        else:
            verdict = "same " if row["same_person"] else "DIFF "
            print(f"  {row['cosine']:+.3f} {verdict} face~{row['face_px']:>3}px  {row['file']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
