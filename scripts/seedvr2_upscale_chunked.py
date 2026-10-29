"""SeedVR2 video upscale on RunPod, one job per overlapping segment.

    python scripts/seedvr2_upscale_chunked.py in.mp4 out.mp4 [--scale 2] [--model 7b|3b]
        [--segment-frames 41] [--overlap 8] [--work-dir DIR] [--endpoint ID]

Avoids the SeedVR2 7B OOM on long clips (see generators/runpod_seedvr2_upscale.py).
Turn the Qwen worker on (workers.max=1) before running; reuse --work-dir to resume.
"""

from __future__ import annotations

import argparse
import asyncio

from novelvideo.generators.runpod_seedvr2_upscale import (
    DEFAULT_OVERLAP_FRAMES,
    DEFAULT_SEGMENT_FRAMES,
    SEEDVR2_3B_UNET,
    SEEDVR2_7B_UNET,
    upscale_video_chunked,
)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("src")
    p.add_argument("dst")
    p.add_argument("--scale", type=float, default=2.0)
    p.add_argument("--model", choices=["7b", "3b"], default="7b")
    p.add_argument("--segment-frames", type=int, default=DEFAULT_SEGMENT_FRAMES)
    p.add_argument("--overlap", type=int, default=DEFAULT_OVERLAP_FRAMES)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--color-correction", choices=["lab", "wavelet", "adain", "none"], default="lab")
    p.add_argument("--work-dir")
    p.add_argument("--endpoint")
    a = p.parse_args()
    result = asyncio.run(
        upscale_video_chunked(
            a.src,
            a.dst,
            scale=a.scale,
            unet_name=SEEDVR2_7B_UNET if a.model == "7b" else SEEDVR2_3B_UNET,
            segment_frames=a.segment_frames,
            overlap_frames=a.overlap,
            seed=a.seed,
            color_correction=a.color_correction,
            endpoint_id=a.endpoint,
            work_dir=a.work_dir,
        )
    )
    for s in result.segments:
        print(f"segment frames {s.start}-{s.end - 1}")
    if result.error:
        print(f"FAILED: {result.error}")
        return 1
    print(f"saved {result.output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
