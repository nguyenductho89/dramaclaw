# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Prepare a self-hosted asset directory for in-browser inference (matting, depth motion capture).

By default transformers.js pulls model weights from the Hugging Face Hub and the
onnxruntime wasm from jsDelivr, which are largely unreachable from mainland-China
networks. This script gathers both kinds of files into one directory; upload that
directory to OSS / a CDN and point the backend's `BROWSER_MODEL_ASSET_BASE` at it.
No frontend rebuild is needed.

Usage:

    python3 scripts/fetch_browser_models.py --out /tmp/browser-models
    # Use a mirror when huggingface.co is unreachable from this machine:
    python3 scripts/fetch_browser_models.py --out /tmp/browser-models \\
        --hf-endpoint https://hf-mirror.com

Output layout (matches frontend/src/features/canvas/application/browserModelSource.ts):

    <out>/models/<org>/<model>/{config.json,preprocessor_config.json,onnx/*.onnx}
    <out>/onnxruntime-web/<version>/ort-wasm-simd-threaded[.asyncify].{mjs,wasm}

The wasm files are copied from frontend/node_modules, and the directory carries the
onnxruntime-web version: the wasm must be the same version as the JS glue bundled into
the frontend, so run `pnpm install` first, and after upgrading @huggingface/transformers
re-run this script and upload the new version directory as well (keep the old directory
for old frontends that have not refreshed the page yet).

Storage requirements: enable CORS (GET/HEAD) for the frontend site's Origin; the
Content-Type of `.wasm` should be `application/wasm` and of `.mjs` `text/javascript`.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import urllib.request
from collections.abc import Callable
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

# One-to-one with the models in the frontend workers: DEPTH_MODEL in depthCaptureWorker.ts and
# MATTE_MODEL in matteWorker.ts. tests/test_fetch_browser_models.py checks the two sides have not drifted.
MODELS: tuple[str, ...] = (
    "onnx-community/depth-anything-v2-small",
    "Xenova/modnet",
)

# WebGPU uses fp16; the wasm fallback uses q8 (the file name is model_quantized).
MODEL_FILES: tuple[str, ...] = (
    "config.json",
    "preprocessor_config.json",
    "onnx/model_fp16.onnx",
    "onnx/model_quantized.onnx",
)

# Safari uses the plain build and other browsers the asyncify build; upload both.
ORT_WASM_FILES: tuple[str, ...] = (
    "ort-wasm-simd-threaded.mjs",
    "ort-wasm-simd-threaded.wasm",
    "ort-wasm-simd-threaded.asyncify.mjs",
    "ort-wasm-simd-threaded.asyncify.wasm",
)

DEFAULT_HF_ENDPOINT = "https://huggingface.co"

Downloader = Callable[[str, Path], None]


def model_file_url(endpoint: str, model: str, filename: str, revision: str = "main") -> str:
    return f"{endpoint.rstrip('/')}/{model}/resolve/{revision}/{filename}"


def download(url: str, dest: Path) -> None:
    """Stream-download to dest; write a .part file first and rename, so an interruption never leaves a half file posing as the finished one."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    partial = dest.with_name(dest.name + ".part")
    request = urllib.request.Request(url, headers={"User-Agent": "fetch-browser-models"})
    with urllib.request.urlopen(request, timeout=60) as response, partial.open("wb") as out:
        shutil.copyfileobj(response, out, length=1 << 20)
    partial.replace(dest)


def fetch_models(
    out_dir: Path,
    *,
    endpoint: str,
    revision: str = "main",
    force: bool = False,
    downloader: Downloader = download,
) -> list[Path]:
    written: list[Path] = []
    for model in MODELS:
        for filename in MODEL_FILES:
            dest = out_dir / "models" / model / filename
            if dest.exists() and not force:
                print(f"  exists, skip {dest.relative_to(out_dir)}")
            else:
                print(f"  download     {dest.relative_to(out_dir)}")
                downloader(model_file_url(endpoint, model, filename, revision), dest)
            written.append(dest)
    return written


def find_ort_web_package(frontend_dir: Path) -> Path:
    """Locate the onnxruntime-web that transformers.js actually depends on (not just any version)."""
    pnpm_dir = frontend_dir / "node_modules" / ".pnpm"
    candidates = sorted(pnpm_dir.glob("@huggingface+transformers@*/node_modules/onnxruntime-web"))
    if not candidates:
        raise FileNotFoundError(
            f"Cannot find the onnxruntime-web that @huggingface/transformers depends on under {pnpm_dir}, "
            "run pnpm install in frontend/ first."
        )
    if len(candidates) > 1:
        raise RuntimeError(
            "node_modules contains multiple @huggingface/transformers versions; cannot tell which one to use for "
            f"onnxruntime-web: {[str(path) for path in candidates]}"
        )
    return candidates[0]


def copy_ort_wasm(out_dir: Path, frontend_dir: Path) -> tuple[str, list[Path]]:
    package_dir = find_ort_web_package(frontend_dir)
    version = json.loads((package_dir / "package.json").read_text(encoding="utf-8"))["version"]
    target_dir = out_dir / "onnxruntime-web" / version
    target_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for filename in ORT_WASM_FILES:
        source = package_dir / "dist" / filename
        if not source.is_file():
            raise FileNotFoundError(f"onnxruntime-web {version} is missing {filename}: {source}")
        shutil.copyfile(source, target_dir / filename)
        print(f"  copy         {(target_dir / filename).relative_to(out_dir)}")
        written.append(target_dir / filename)
    return version, written


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", required=True, type=Path, help="Output directory; upload the whole thing to OSS / a CDN")
    parser.add_argument(
        "--hf-endpoint",
        default=DEFAULT_HF_ENDPOINT,
        help="Hugging Face endpoint, default %(default)s; switch to a mirror if unreachable",
    )
    parser.add_argument("--revision", default="main", help="Model repository revision, default main")
    parser.add_argument(
        "--frontend",
        type=Path,
        default=REPO_ROOT / "frontend",
        help="Frontend directory (pnpm install must have been run), default frontend/ in this repo",
    )
    parser.add_argument("--force", action="store_true", help="Re-download model files even if they already exist")
    args = parser.parse_args(argv)

    out_dir: Path = args.out.expanduser().resolve()
    print(f"model weights <- {args.hf_endpoint}")
    try:
        files = fetch_models(
            out_dir, endpoint=args.hf_endpoint, revision=args.revision, force=args.force
        )
        print("onnxruntime wasm <- frontend/node_modules")
        version, wasm_files = copy_ort_wasm(out_dir, args.frontend.expanduser().resolve())
    except (OSError, RuntimeError) as exc:
        print(f"failed: {exc}", file=sys.stderr)
        return 1

    total_mb = sum(path.stat().st_size for path in [*files, *wasm_files]) / 1e6
    print(
        f"\nDone: {len(files)} model files + {len(wasm_files)} wasm files of onnxruntime-web {version}, "
        f"{total_mb:.1f} MB in total\n"
        f"Upload the whole contents of {out_dir} to OSS / a CDN, then configure the backend:\n"
        "  BROWSER_MODEL_ASSET_BASE=<URL prefix for that directory>"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
